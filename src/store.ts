// The ONLY file in this repo that imports a database driver.
//
// db.ts owns every SQL string and the single-writer discipline; this module
// owns nothing but "run this text with these $N params and give me rows".
// Two implementations sit behind one interface:
//
//   bunStore(url)  — production. Bun's BUILT-IN Postgres client (`bun` → SQL),
//                    so the repo keeps its zero-runtime-dependency ethos
//                    exactly as it did with bun:sqlite.
//   pgliteStore()  — tests. @electric-sql/pglite is real Postgres compiled to
//                    WASM, in-process, no server and no port. It is a
//                    devDependency and is reached ONLY through a dynamic
//                    import, so the WASM blob never lands on the daemon's
//                    import graph.
//
// Both are driven with the SAME call shape — `unsafe(text, params)` /
// `query(text, params)` with `$1`-style placeholders — so production and the
// unit suite execute BYTE-IDENTICAL SQL strings. Nothing here ever
// concatenates a value into SQL text.
//
// EMPIRICAL NOTE (this is why db.ts casts everything numeric):
//   Bun's client returns int8/BIGINT/COUNT(*)/SUM() as JS **strings**.
//   PGlite returns the same columns as JS **numbers**.
// That divergence is real and was measured, not assumed. db.ts therefore casts
// every numeric select (`::float8` / `::int`) AND funnels every numeric column
// through its `num()` coercion, so a missed cast degrades to slow-but-correct
// instead of silently handing a string to arithmetic. tests/store-parity.test.ts
// and tests/db-cast-discipline.test.ts pin both halves.

export interface Store {
  /** Rows for a SELECT (or any RETURNING statement). */
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]>;
  /** Affected-row count for INSERT/UPDATE/DELETE without RETURNING. */
  exec(text: string, params?: unknown[]): Promise<number>;
  close(): Promise<void>;
}

/** Production store: Bun's built-in Postgres client over a loopback URL. */
export async function bunStore(url: string): Promise<Store> {
  const { SQL } = await import("bun");
  const sql = new SQL({
    url,
    max: 8,
    idleTimeout: 30,
    connectionTimeout: 5,
    // Server-side guards, the functional replacement for the SQLite-era
    // busy_timeout/WAL pragmas: a runaway telemetry scan or a stuck lock must
    // never wedge the single writer. MVCC already removes the reader-blocks-
    // writer failure class those pragmas existed for.
    connection: {
      application_name: "factory-daemon",
      statement_timeout: "15000",
      lock_timeout: "3000",
    },
  });
  // `unsafe(text, params)` is deliberate and is NOT a SQL-injection door: the
  // text is always a literal in db.ts and every value travels as a bound $N
  // parameter. It is the one call shape both drivers share, which is what keeps
  // the SQL identical between production and tests.
  return {
    async query<T>(text: string, params: unknown[] = []): Promise<T[]> {
      const rows = await sql.unsafe(text, params as never[]);
      return rows as unknown as T[];
    },
    async exec(text: string, params: unknown[] = []): Promise<number> {
      const result = await sql.unsafe(text, params as never[]);
      // Bun returns [] for a non-RETURNING write, carrying `.count`.
      return (result as unknown as { count?: number }).count ?? 0;
    },
    async close(): Promise<void> {
      await sql.end();
    },
  };
}

/** Test store: in-process WASM Postgres. Dynamic import keeps it off the
 *  daemon's graph; @electric-sql/pglite is a devDependency only. */
export async function pgliteStore(): Promise<Store> {
  const { PGlite } = await import("@electric-sql/pglite");
  const pg = await PGlite.create();
  return {
    async query<T>(text: string, params: unknown[] = []): Promise<T[]> {
      const result = await pg.query(text, params);
      return result.rows as unknown as T[];
    },
    async exec(text: string, params: unknown[] = []): Promise<number> {
      const result = await pg.query(text, params);
      // PGlite reports writes as { rows, fields, affectedRows } — the one raw
      // shape difference from Bun, normalised here so db.ts never sees it.
      return (result as unknown as { affectedRows?: number }).affectedRows ?? 0;
    },
    async close(): Promise<void> {
      await pg.close();
    },
  };
}
