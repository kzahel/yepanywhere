import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { createProvidersRoutes } from "../../../src/routes/providers.js";
import { AntigravityProvider } from "../../../src/sdk/providers/antigravity.js";

const agy = `#!/usr/bin/env node
const { spawn } = require('node:child_process');
const { appendFileSync } = require('node:fs');
if (!process.stdin.isTTY) process.exit(1);
appendFileSync(process.env.AGY_TEST_RUNS, process.pid + '\\n');
const settings = JSON.parse(process.argv[process.argv.indexOf('--settings') + 1]);
const callback = spawn('/bin/sh', ['-c', settings.statusLine.command]);
callback.stdin.end(JSON.stringify({
  email: 'private@example.invalid',
  quota: {
    'gemini-5h': { remaining_fraction: 0, reset_time: '2026-11-21T21:00:27Z' },
    '3p-weekly': { remaining_fraction: 0.75 },
    'gemini-argon-wtu-weekly': { remaining_fraction: 0.5 },
    'gemini-weekly': { remaining_fraction: 1, disabled: true },
    'unrecognized-5h': { remaining_fraction: 0 },
  },
}));
`;

it.skipIf(
  !["darwin", "linux"].includes(process.platform) ||
    !existsSync("/usr/bin/script"),
)(
  "coalesces terminal probes and applies quota only to its model family",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "ya-test-agy-usage-"));
    const executable = join(directory, "agy");
    const runs = join(directory, "runs");
    const url = "/antigravity/subscription-usage";
    try {
      await writeFile(executable, agy, { mode: 0o755 });
      vi.stubEnv("ANTIGRAVITY_ACP_PATH", executable);
      vi.stubEnv("AGY_TEST_RUNS", runs);
      for (const key of [
        "CLOUD_CODE_URL",
        "AGY_LLM_GATEWAY_URL",
        "AGY_ACP_CCPA_PROJECT",
        "GEMINI_API_KEY",
        "GOOGLE_API_KEY",
      ]) {
        vi.stubEnv(key, undefined);
      }
      const provider = new AntigravityProvider();
      vi.spyOn(provider, "getAuthStatus").mockResolvedValue({
        installed: true,
        authenticated: true,
      });
      vi.spyOn(provider, "getAvailableModels").mockResolvedValue([
        { id: "default", name: "Antigravity default" },
        { id: "gemini-4-neon", name: "Gemini 4 Neon" },
        { id: "gemini-4-argon", name: "Gemini 4 Argon" },
        { id: "claude-opus-5-5", name: "Claude Opus 5.5" },
        { id: "gpt-oss-120b", name: "GPT-OSS 120B" },
      ]);
      const routes = createProvidersRoutes({ providers: [provider] });
      const responses = await Promise.all([
        routes.request(url),
        routes.request(`${url}?refresh=1`),
        routes.request(`${url}?refresh=1`),
      ]);
      const results = await Promise.all(
        responses.map((response) => response.json()),
      );
      expect(results[0]).toEqual({
        usage: {
          provider: "antigravity",
          fetchedAt: expect.any(String),
          windows: [
            {
              id: "antigravity:gemini-5h",
              usedPercent: 100,
              windowDurationMinutes: 300,
              resetsAt: "2026-11-21T21:00:27.000Z",
              scope: {
                type: "models",
                label: "Gemini",
                modelIds: ["gemini-4-neon"],
              },
            },
            {
              id: "antigravity:gemini-argon-wtu-weekly",
              usedPercent: 50,
              windowDurationMinutes: 10_080,
              scope: {
                type: "models",
                label: "Gemini Argon",
                modelIds: ["gemini-4-argon"],
              },
            },
            {
              id: "antigravity:3p-weekly",
              usedPercent: 25,
              windowDurationMinutes: 10_080,
              scope: {
                type: "models",
                label: "Claude & GPT",
                modelIds: ["claude-opus-5-5", "gpt-oss-120b"],
              },
            },
          ],
        },
      });
      expect(results[1]).toEqual(results[0]);
      expect(results[2]).toEqual(results[0]);
      expect(await (await routes.request(url)).json()).toEqual(results[0]);
      const pids = (await readFile(runs, "utf8")).trim().split("\n");
      expect(pids).toHaveLength(1);
      expect(() => process.kill(Number(pids[0]), 0)).toThrow(/ESRCH/);

      vi.stubEnv("CLOUD_CODE_URL", "http://127.0.0.1:8421");
      expect(await (await routes.request(`${url}?refresh=1`)).json()).toEqual({
        usage: null,
      });
      expect((await readFile(runs, "utf8")).trim().split("\n")).toEqual(pids);
    } finally {
      vi.unstubAllEnvs();
      await rm(directory, { recursive: true, force: true });
    }
  },
);
