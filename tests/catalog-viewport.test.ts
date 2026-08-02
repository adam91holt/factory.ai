// Mobile viewport check for the catalog page (issue #16 WP3, FAC-64 mobile
// discipline): drive REAL chromium at 390x844 against the BUILT ui/dist in
// ?mock=1 mode (no daemon, no Postgres) and assert ZERO horizontal overflow —
// the failure mode the 2026-08-02 live 390px reviews kept finding (fixed
// multi-column grids and incompressible tables plowing off-screen).
//
// OPT-IN, exactly like the real-driver store parity check (store-parity-pg):
//
//   bun run ui:build && FACTORY_BROWSER_CHECK=1 bun test catalog-viewport
//
// because it needs a chromium download (~/.cache/ms-playwright — already
// cached on the dev box) and the python playwright driver. The default run
// registers a single visible skip so the gate stays discoverable, never
// silently green. The page is served from THIS process (node:http over
// ui/dist with the same SPA fallback src/server.ts uses); chromium is driven
// by the system `playwright` (python) via a spawned script that prints one
// JSON line — no new bun dependency.

import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";

const RUN = process.env.FACTORY_BROWSER_CHECK === "1";
const UI_DIST = fileURLToPath(new URL("../ui/dist", import.meta.url));

const PYTHON_SCRIPT = `
import json, sys
from playwright.sync_api import sync_playwright

base, shot = sys.argv[1], sys.argv[2]
with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page(viewport={"width": 390, "height": 844})
    # NOT networkidle: the app shell keeps an SSE connection open forever.
    page.goto(base + "/catalog?mock=1", wait_until="domcontentloaded")
    # The catalog page (not just the shell) must render before we measure:
    # the h1 is unique/visible, then a short settle for the mock lists.
    page.wait_for_selector("h1:has-text('Catalog')", timeout=15000)
    page.wait_for_timeout(1500)
    result = page.evaluate(
        "() => ({ doc: document.documentElement.scrollWidth,"
        "         body: document.body.scrollWidth,"
        "         inner: window.innerWidth })"
    )
    page.screenshot(path=shot, full_page=True)
    browser.close()
print(json.dumps(result))
`;

describe("catalog page at 390x844 — zero horizontal overflow", () => {
  if (!RUN) {
    test.skip("browser viewport check (opt-in: bun run ui:build && FACTORY_BROWSER_CHECK=1 bun test catalog-viewport)", () => { /* gated */ });
    return;
  }

  test("chromium at 390px: scrollWidth never exceeds the viewport", async () => {
    expect(existsSync(join(UI_DIST, "index.html"))).toBe(true); // run `bun run ui:build` first

    // Static server over ui/dist with the SPA fallback (same split as
    // src/server.ts: /assets/* are files, everything else is index.html).
    const index = readFileSync(join(UI_DIST, "index.html"));
    const server = createServer((req, res) => {
      const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
      if (path.startsWith("/assets/")) {
        const rel = normalize(path).replace(/^\/+/, "");
        const full = join(UI_DIST, rel);
        if (!full.startsWith(join(UI_DIST, "assets") + sep)) { res.writeHead(400); res.end(); return; }
        try {
          const type = full.endsWith(".js") ? "text/javascript" : full.endsWith(".css") ? "text/css" : "application/octet-stream";
          res.writeHead(200, { "content-type": type });
          res.end(readFileSync(full));
        } catch { res.writeHead(404); res.end(); }
        return;
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(index);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const shot = join(mkdtempSync(join(tmpdir(), "factory-viewport-")), "catalog-390x844.png");

    try {
      // spawn, not spawnSync: the static server above lives on THIS event
      // loop, and a sync wait would deadlock chromium's requests against it.
      const proc = await new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
        const child = spawn("python3", ["-c", PYTHON_SCRIPT, base, shot], { stdio: ["ignore", "pipe", "pipe"] });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (c: Buffer) => { stdout += c.toString(); });
        child.stderr.on("data", (c: Buffer) => { stderr += c.toString(); });
        const timer = setTimeout(() => child.kill("SIGKILL"), 120_000);
        child.on("error", (e) => { clearTimeout(timer); reject(e); });
        child.on("close", (status) => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
      });
      expect({ status: proc.status, stderr: proc.stderr.slice(-500) }).toEqual({ status: 0, stderr: "" });
      const line = proc.stdout.trim().split("\n").pop() ?? "{}";
      const m = JSON.parse(line) as { doc: number; body: number; inner: number };
      // Zero horizontal overflow: nothing may render wider than the viewport.
      expect(m.inner).toBe(390);
      expect(m.doc).toBeLessThanOrEqual(390);
      expect(m.body).toBeLessThanOrEqual(390);
      expect(existsSync(shot)).toBe(true);
      console.log(`[viewport] catalog 390x844 clean (doc ${m.doc}px, body ${m.body}px) — screenshot: ${shot}`);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 180_000);
});
