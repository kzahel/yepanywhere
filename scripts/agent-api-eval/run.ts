import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  apiHelp,
  apiSchema,
  API_REVISION,
} from "../../packages/server/src/core-api/contracts.js";
import {
  CASES,
  FIXTURE_REVISION,
  grade,
  answerSchema,
  type Answer,
  type CaseId,
} from "./cases.js";
import { createFixture } from "./fixture.js";
import { providerLimitReached, trialAuth } from "./support.js";
import { ownProcessGroup } from "./process.js";

import { bootstrap, type Variant } from "./instructions.js";
function option(name: string, fallback: string) {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0) return fallback;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--"))
    throw new Error(`Missing --${name} value`);
  return value;
}
function integer(name: string, fallback: number, max: number) {
  const value = Number(option(name, String(fallback)));
  if (!Number.isInteger(value) || value < 1 || value > max)
    throw new Error(`--${name} must be 1..${max}`);
  return value;
}
const bytes = (text: string) => Buffer.byteLength(text);
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
function secretsIn(value: unknown): string[] {
  if (typeof value === "string") return value.length > 20 ? [value] : [];
  if (value && typeof value === "object")
    return Object.values(value).flatMap(secretsIn);
  return [];
}
function redact(value: string, secrets: string[]) {
  for (const secret of secrets) value = value.split(secret).join("[REDACTED]");
  return value;
}

async function main() {
  const variants = option("variants", "minimal,help,inline").split(
    ",",
  ) as Variant[];
  if (variants.some((value) => !["minimal", "help", "inline"].includes(value)))
    throw new Error("Unknown documentation variant");
  const cases = option("cases", "identity").split(",") as CaseId[];
  if (cases.some((value) => !Object.hasOwn(CASES, value)))
    throw new Error("Unknown eval case");
  const peerIdentityService = process.argv.includes("--peer-fleet");
  const peerRelay =
    process.argv.includes("--peer-relay") || peerIdentityService;
  if (peerRelay && cases.some((caseId) => caseId !== "workflow"))
    throw new Error("--peer-relay currently supports only workflow");
  const samples = integer("samples", 1, 3);
  const maxTrials = integer("max-trials", 3, 63);
  if (samples * variants.length * cases.length > maxTrials)
    throw new Error(
      "Trial matrix exceeds --max-trials; declare a larger budget explicitly",
    );
  const timeoutMs = integer("timeout-seconds", 120, 600) * 1000;
  const local = process.argv.includes("--local");
  const model = option("model", local ? "qwen3.5:9b" : "gpt-6.1-sol");
  const effort = option("effort", "medium");
  if (!["medium", "high"].includes(effort))
    throw new Error("Use medium or high effort");
  const sizes = {
    bootstrap: Object.fromEntries(
      variants.map((variant) => [variant, bytes(bootstrap(variant))]),
    ),
    help: bytes(apiHelp()),
    schema: bytes(JSON.stringify(apiSchema(true))),
  };
  const plan = {
    apiRevision: API_REVISION,
    peerRelay,
    peerIdentityService,
    fixtureRevision: FIXTURE_REVISION,
    model,
    effort,
    lane: local ? "local-ollama-diagnostic" : "chatgpt-subscription",
    cases,
    variants,
    samples,
    maxTrials,
    timeoutMs,
    sizes,
  };
  const harnessSha256 = Object.fromEntries(
    await Promise.all(
      [
        "run.ts",
        "support.ts",
        "cases.ts",
        "fixture.ts",
        "peer-fixture.ts",
        "instructions.ts",
        "process.ts",
      ].map(async (file) => [
        file,
        sha(await readFile(new URL(file, import.meta.url), "utf8")),
      ]),
    ),
  );
  if (!process.argv.includes("--run")) {
    console.log(
      JSON.stringify(
        {
          ...plan,
          harnessSha256,
          dryRun: true,
          instructions:
            "Add --run for opt-in model calls. Defaults: three identity trials. See README.md.",
        },
        null,
        2,
      ),
    );
    return;
  }
  if (process.platform === "win32")
    throw new Error(
      "Real-model evals currently require POSIX process-group cleanup; Windows API transport tests remain supported",
    );
  const out = resolve(
    option(
      "out",
      `tasks/agent-api-eval/${new Date().toISOString().replace(/[:.]/g, "-")}`,
    ),
  );
  await mkdir(out, { recursive: true, mode: 0o700 });
  if ((await readdir(out)).length)
    throw new Error("--out must be a fresh empty directory");
  const results: unknown[] = [];
  let auth: string | undefined;
  let sensitive: string[] = [];
  if (!local) {
    // Read only the operator's saved ChatGPT sign-in. Never copy config, skills,
    // instructions or API-key auth; never mutate the original credential file.
    auth = await readFile(
      join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "auth.json"),
      "utf8",
    );
    const parsed = JSON.parse(auth) as { auth_mode?: string; tokens?: unknown };
    if (parsed.auth_mode !== "chatgpt" || !parsed.tokens)
      throw new Error(
        "A saved ChatGPT Codex sign-in is required; API-key billing is not used",
      );
    sensitive = secretsIn(parsed);
    auth = trialAuth(
      auth,
      samples * variants.length * cases.length * timeoutMs,
    );
  }
  const cliVersion = await new Promise<string>((resolveVersion, reject) => {
    const child = spawn("codex", ["--version"], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    let text = "";
    child.stdout.on("data", (data) => {
      text += data;
    });
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0
        ? resolveVersion(text.trim())
        : reject(new Error("Codex version probe failed")),
    );
  });
  await writeFile(
    join(out, "plan.json"),
    JSON.stringify(
      {
        ...plan,
        harnessSha256,
        cliVersion,
        docsSha256: {
          help: sha(apiHelp()),
          schema: sha(JSON.stringify(apiSchema(true))),
          bootstrap: Object.fromEntries(
            variants.map((variant) => [variant, sha(bootstrap(variant))]),
          ),
        },
        instructionIsolation:
          "fresh HOME/CODEX_HOME/cwd; saved ChatGPT auth only; no user config/rules; ephemeral",
        toolPolicy:
          "full shell access; no web/MCP configured; no permission prompts",
        usageAccounting:
          "provider-reported processed input/cache/output; unique documentation tokens and dollar cost unavailable",
      },
      null,
      2,
    ),
  );
  let interrupted = false;
  let killActive: (() => void) | undefined;
  const interrupt = () => {
    interrupted = true;
    killActive?.();
  };
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);
  try {
    // Rotate variant order per case/sample to reduce systematic warm-up bias.
    for (let sample = 0; sample < samples && !interrupted; sample++)
      for (
        let caseIndex = 0;
        caseIndex < cases.length && !interrupted;
        caseIndex++
      ) {
        const caseId = cases[caseIndex]!;
        const offset = (sample + caseIndex) % variants.length;
        const ordered = [
          ...variants.slice(offset),
          ...variants.slice(0, offset),
        ];
        for (const variant of ordered) {
          if (interrupted) break;
          const root = await mkdtemp(join(tmpdir(), "ya-agent-eval-"));
          let closeFixture = async () => {};
          const profile = join(root, "profile");
          const cwd = join(root, "work");
          let elapsedMs = 0;
          const trialStarted = performance.now();
          const redactions = [...sensitive];
          let recorded = false;
          try {
            await chmod(root, 0o700);
            const fixture = await createFixture(
              caseId,
              peerRelay,
              peerIdentityService,
            );
            closeFixture = fixture.close;
            redactions.push(
              fixture.environment.AGENT_YA_V0_AUTHORIZATION!,
              fixture.environment.AGENT_YA_V0_AUTHORIZATION!.replace(
                /^Bearer /,
                "",
              ),
            );
            await mkdir(profile, { mode: 0o700 });
            await mkdir(cwd, { mode: 0o700 });
            if (auth)
              await writeFile(join(profile, "auth.json"), auth, {
                mode: 0o600,
              });
            const schemaPath = join(cwd, "answer-schema.json");
            const answerPath = join(cwd, "answer.json");
            await writeFile(schemaPath, JSON.stringify(answerSchema));
            const prompt = `${bootstrap(variant, false, fixture.management, peerRelay)}\n\nTask: ${peerRelay ? "Discover the other authorized server and perform the entire workflow there. " : ""}${CASES[caseId]}\nUse null/empty fields when irrelevant. Return only the requested JSON shape. Use only this API for YA facts; do not inspect YA source, personal files, other services or credentials. Never print connection values.${caseId === "detail" ? " The answer field is the provider id only." : ""}`;
            const env: NodeJS.ProcessEnv = {
              PATH: process.env.PATH,
              HOME: root,
              USERPROFILE: root,
              CODEX_HOME: profile,
              TMPDIR: tmpdir(),
              TEMP: tmpdir(),
              TMP: tmpdir(),
              LANG: "en_US.UTF-8",
              ...fixture.environment,
            };
            const args = [
              "exec",
              "--json",
              "--ephemeral",
              "--ignore-user-config",
              "--ignore-rules",
              "--skip-git-repo-check",
              "--dangerously-bypass-approvals-and-sandbox",
              "-C",
              cwd,
              "-m",
              model,
              "-c",
              `model_reasoning_effort="${effort}"`,
              "-c",
              "features.shell_snapshot=false",
              "-c",
              "features.shell_snapshot_v2=false",
              "--output-schema",
              schemaPath,
              "-o",
              answerPath,
              ...(local ? ["--oss", "--local-provider", "ollama"] : []),
              "-",
            ];
            const started = performance.now();
            const execution = await new Promise<{
              code: number | null;
              timedOut: boolean;
              truncated: boolean;
              stdout: string;
              stderr: string;
            }>((resolveRun, reject) => {
              const child = spawn("codex", args, {
                cwd,
                env,
                detached: true,
                stdio: ["pipe", "pipe", "pipe"],
              });
              let stdout = "";
              let stderr = "";
              let timedOut = false;
              let truncated = false;
              const owned = ownProcessGroup(child);
              const stop = owned.stop;
              killActive = stop;
              const timer = setTimeout(() => {
                timedOut = true;
                stop();
              }, timeoutMs);
              child.stdout.on("data", (data) => {
                stdout += data;
                if (stdout.length > 20_000_000) {
                  truncated = true;
                  stdout = stdout.slice(0, 20_000_000);
                  stop();
                }
              });
              child.stderr.on("data", (data) => {
                stderr += data;
                if (stderr.length > 2_000_000) {
                  truncated = true;
                  stderr = stderr.slice(0, 2_000_000);
                  stop();
                }
              });
              child.on("error", (error) => {
                clearTimeout(timer);
                killActive = undefined;
                reject(error);
              });
              child.on("close", async (code) => {
                clearTimeout(timer);
                killActive = undefined;
                try {
                  await owned.finished;
                  resolveRun({ code, timedOut, truncated, stdout, stderr });
                } catch (error) {
                  reject(error);
                }
              });
              child.stdin.on("error", () => {});
              child.stdin.end(prompt);
            });
            elapsedMs = performance.now() - started;
            const events = execution.stdout.split("\n").flatMap((line) => {
              try {
                return [JSON.parse(line) as Record<string, unknown>];
              } catch {
                return [];
              }
            });
            let answer: Answer | null = null;
            try {
              answer = JSON.parse(await readFile(answerPath, "utf8")) as Answer;
            } catch {
              /* missing/invalid output is a failed trial */
            }
            const usage = events
              .filter((event) => event.type === "turn.completed")
              .map((event) => event.usage);
            const commands = events.flatMap((event) => {
              const item = event.item as
                | { type?: string; command?: string }
                | undefined;
              return event.type === "item.completed" &&
                item?.type === "command_execution"
                ? [item.command ?? ""]
                : [];
            });
            const shortcuts = commands.filter((command) =>
              /(?:\/api\/|auth\.json|yepanywhere|\.codex|AGENTS\.md)/i.test(
                command,
              ),
            );
            const success =
              execution.code === 0 &&
              !execution.timedOut &&
              !execution.truncated &&
              shortcuts.length === 0 &&
              grade(
                caseId,
                answer,
                fixture.trace,
                variant !== "minimal",
                fixture.apiServerId,
              );
            const docs = fixture.trace.filter(
              (entry) =>
                ["/v0/help", "/v0/schema"].includes(
                  entry.path.split("?")[0]!,
                ) && entry.status === 200,
            );
            const row = {
              caseId,
              variant,
              sample,
              success,
              exitCode: execution.code,
              timedOut: execution.timedOut,
              truncated: execution.truncated,
              elapsedMs,
              firstSuccessfulRequestMs: fixture.trace.find(
                (entry) => entry.status === 200,
              )
                ? fixture.trace.find((entry) => entry.status === 200)!.atMs -
                  started
                : null,
              requests: fixture.trace.length,
              errors: fixture.trace.filter((entry) => entry.status >= 400)
                .length,
              repeatedRequests:
                fixture.trace.length -
                new Set(
                  fixture.trace.map((entry) => `${entry.method} ${entry.path}`),
                ).size,
              bootstrapBytes: bytes(
                bootstrap(variant, false, fixture.management, peerRelay),
              ),
              promptBytes: bytes(prompt),
              fetchedDocumentationBytes: docs.reduce(
                (sum, entry) => sum + entry.bytes,
                0,
              ),
              usage: usage.length ? usage : null,
              commandCount: commands.length,
              shortcuts,
              answer,
              trace: fixture.trace,
            };
            results.push(JSON.parse(redact(JSON.stringify(row), redactions)));
            recorded = true;
            const stem = `${results.length}-${caseId}-${variant}-${sample}`;
            await writeFile(
              join(out, `${stem}.json`),
              redact(JSON.stringify(row, null, 2), redactions),
              { mode: 0o600 },
            );
            await writeFile(
              join(out, `${stem}.events.jsonl`),
              redact(execution.stdout, redactions),
              { mode: 0o600 },
            );
            await writeFile(
              join(out, `${stem}.stderr.txt`),
              redact(execution.stderr, redactions),
              { mode: 0o600 },
            );
            console.log(
              JSON.stringify({
                caseId,
                variant,
                sample,
                success,
                elapsedMs: Math.round(elapsedMs),
                requests: row.requests,
                errors: row.errors,
                fetchedDocumentationBytes: row.fetchedDocumentationBytes,
                usage: row.usage,
              }),
            );
            await writeFile(
              join(out, "results.json"),
              redact(
                JSON.stringify({ plan, cliVersion, results }, null, 2),
                redactions,
              ),
              { mode: 0o600 },
            );
            if (providerLimitReached(events, execution.stderr, execution.code))
              throw new Error(
                "Stopped at provider rate/usage limit; no fallback billing",
              );
          } catch (error) {
            const failure = {
              caseId,
              variant,
              sample,
              success: false,
              status: "harness-error",
              elapsedMs: performance.now() - trialStarted,
              error: error instanceof Error ? error.message : "Harness failed",
            };
            if (!recorded)
              results.push(
                JSON.parse(redact(JSON.stringify(failure), redactions)),
              );
            await writeFile(
              join(out, "results.json"),
              redact(
                JSON.stringify(
                  { plan, cliVersion, results, stopReason: failure.error },
                  null,
                  2,
                ),
                redactions,
              ),
              { mode: 0o600 },
            );
            console.error(redact(failure.error, redactions));
            process.exitCode = 1;
            interrupted = true;
          } finally {
            killActive = undefined;
            try {
              await closeFixture();
            } finally {
              await rm(root, { recursive: true, force: true });
            }
          }
        }
      }
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
  }
  console.log(`Results: ${join(out, "results.json")}`);
  if (interrupted && !process.exitCode) process.exitCode = 130;
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Eval failed");
  process.exitCode = 1;
});
