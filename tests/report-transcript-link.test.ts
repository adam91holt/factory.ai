// Issue #11: the factory report links the full-fidelity transcript
// (GET /issue/:key/transcript). The link must resolve with the SAME port
// rules the dashboard binds with (config.resolveDashboardPort — one source,
// no drift), and must vanish — leaving the report byte-identical — whenever
// the dashboard is off or the env is malformed.

import { afterEach, describe, expect, test } from "bun:test";
import { buildReport, transcriptUrlFor, type ReportInput } from "../src/report.ts";

const originalPort = process.env.DASHBOARD_PORT;
afterEach(() => {
  if (originalPort === undefined) delete process.env.DASHBOARD_PORT;
  else process.env.DASHBOARD_PORT = originalPort;
});

const base: ReportInput = {
  issueKey: "FAC-49", prUrl: "https://github.com/o/r/pull/1", outcome: "pr_open",
  stages: [], gates: [], gateStrength: "real", guardedPaths: [],
};

describe("transcriptUrlFor", () => {
  test("uses the explicit DASHBOARD_PORT", () => {
    process.env.DASHBOARD_PORT = "8792";
    expect(transcriptUrlFor("FAC-49")).toBe("http://127.0.0.1:8792/issue/FAC-49/transcript");
    expect(transcriptUrlFor("GK-factory")).toBe("http://127.0.0.1:8792/issue/GK-factory/transcript");
  });

  test("defaults to 8787 when unset (daemon mode)", () => {
    delete process.env.DASHBOARD_PORT;
    expect(transcriptUrlFor("FAC-1")).toBe("http://127.0.0.1:8787/issue/FAC-1/transcript");
  });

  test("dashboard off (0) or malformed port or non-link-shaped key → null, never a throw", () => {
    process.env.DASHBOARD_PORT = "0";
    expect(transcriptUrlFor("FAC-1")).toBeNull();
    process.env.DASHBOARD_PORT = "not-a-port";
    expect(transcriptUrlFor("FAC-1")).toBeNull();
    process.env.DASHBOARD_PORT = "8792";
    expect(transcriptUrlFor("fac-1")).toBeNull();
    expect(transcriptUrlFor("FAC-1; rm -rf /")).toBeNull();
  });
});

describe("buildReport carries the link", () => {
  test("present when the dashboard is on", () => {
    process.env.DASHBOARD_PORT = "8792";
    const report = buildReport(base);
    expect(report).toContain("📜 Full transcript: http://127.0.0.1:8792/issue/FAC-49/transcript");
  });

  test("dashboard off → the line is absent and the report is byte-identical to a link-less one", () => {
    process.env.DASHBOARD_PORT = "8792";
    const withLink = buildReport(base);
    process.env.DASHBOARD_PORT = "0";
    const without = buildReport(base);
    expect(without).not.toContain("Full transcript");
    expect(withLink.replace("📜 Full transcript: http://127.0.0.1:8792/issue/FAC-49/transcript\n\n", "")).toBe(without);
  });
});
