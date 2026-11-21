import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { generateRelayStatsHtml } from "../src/stats.js";

describe("relay stats", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("renders version and traffic charts from daily telemetry files", async () => {
    const dir = mkdtempSync(join(tmpdir(), "relay-stats-"));
    tempDirs.push(dir);

    writeFileSync(
      join(dir, "2026-03-09.ndjson"),
      [
        JSON.stringify({
          timestamp: "2026-03-09T10:00:00.000Z",
          relayNodeId: "relay-a",
          event: "server_register",
          username: "alice",
          installId: "install-1",
          appVersion: "1.2.3",
        }),
        JSON.stringify({
          timestamp: "2026-03-09T10:05:00.000Z",
          relayNodeId: "relay-a",
          event: "client_connect_success",
          username: "alice",
          installId: "install-1",
        }),
      ].join("\n"),
      "utf8",
    );

    writeFileSync(
      join(dir, `${new Date().toISOString().slice(0, 10)}.ndjson`),
      [
        JSON.stringify({
          timestamp: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
          relayNodeId: "relay-a",
          event: "connection_sample",
          waiting: 4,
          pairs: 2,
          registered: 5,
          activeServers: 5,
        }),
      ].join("\n"),
      "utf8",
    );

    const html = await generateRelayStatsHtml(dir);

    expect(html).toContain("Remote-active installs by version");
    expect(html).toContain("Relay traffic, last 24 hours");
    expect(html).toContain("1.2.3");
    expect(html).toContain("waiting");
    expect(html).toContain("pairs");
  });

  it("counts Unicode rows once per install and skips malformed lines", async () => {
    const dir = mkdtempSync(join(tmpdir(), "relay-stats-"));
    tempDirs.push(dir);

    writeFileSync(
      join(dir, "2026-03-09.ndjson"),
      [
        JSON.stringify({
          timestamp: "2026-03-09T10:00:00.000Z",
          relayNodeId: "relay-a",
          event: "server_register",
          username: "alice",
          installId: "install-1",
          appVersion: "1.2.3",
        }),
        "{not json",
        JSON.stringify({
          timestamp: "2026-03-09T10:01:00.000Z",
          relayNodeId: "relay-a",
          event: "server_register",
          username: "alice",
          installId: "install-1",
          appVersion: "1.2.3",
        }),
        JSON.stringify({
          timestamp: "2026-03-09T10:05:00.000Z",
          relayNodeId: "relay-a",
          event: "server_register",
          username: "bob",
          installId: "install\u2028two\u2029here",
          appVersion: "1.2.3",
        }),
      ].join("\n"),
      "utf8",
    );

    const html = await generateRelayStatsHtml(dir);

    expect(html).toContain("1.2.3");
    expect(html).toContain('"data":[2]');
  });
});
