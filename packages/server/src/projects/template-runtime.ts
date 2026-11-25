import { spawn } from "node:child_process";
import {
  projectServiceSchema,
  projectFileLinksSchema,
} from "@yep-anywhere/shared/project-service";
import { prepareSessionSandbox } from "../session-sandbox.js";
import { z } from "zod";
import { filterEnvForChildProcess } from "../sdk/providers/env-filter.js";
import {
  processTreeSpawnOptions,
  signalProcessTree,
} from "../utils/processTree.js";
import type { TemplateComposition } from "./template-library.js";

const localPath = z
  .string()
  .min(1)
  .refine(
    (value) =>
      !/[\\:]/.test(value) &&
      value
        .split("/")
        .every((part) => !["", ".", "..", ".git"].includes(part.toLowerCase())),
  );
const argv = z
  .array(
    z
      .string()
      .min(1)
      .refine((value) => !value.includes("\0")),
  )
  .min(1)
  .max(64);
const runtimeSchema = z.object({
  viewAudience: z.literal("public").optional(),
  fileLinks: projectFileLinksSchema.optional(),
  kind: z.enum(["static", "server"]),
  dir: localPath,
  setup: argv,
  build: argv,
  test: argv,
  preview: argv,
  prepare: localPath,
  start: argv.optional(),
  addons: z.record(z.string(), argv).optional(),
  service: projectServiceSchema.optional(),
  livePreview: projectServiceSchema
    .refine(
      (service) => service.where.kind === "process",
      "Live preview requires a process",
    )
    .optional(),
});
export type TemplateRuntime = z.infer<typeof runtimeSchema>;

/** Reads runtime commands from retained template bytes, before allocating a target. */
export function templateRuntime(
  composition: TemplateComposition,
): TemplateRuntime {
  const file = composition.files.get(".project-template/app.json");
  if (!file) throw new Error("Template runtime configuration is missing");
  const runtime = runtimeSchema.parse(
    JSON.parse(file.content.toString("utf8")),
  );
  if (!composition.files.has(runtime.prepare))
    throw new Error("Template preparation prompt is missing");
  return runtime;
}

/** Executes template setup as argv, retaining bounded output and owning its process tree. */
export async function runTemplateSetup(
  cwd: string,
  command: string[],
  onOutput: (text: string) => void,
  signal?: AbortSignal,
  restricted = false,
): Promise<void> {
  signal?.throwIfAborted();
  const sandbox = restricted
    ? await prepareSessionSandbox({
        level: "project-write",
        networkFirewall: true,
        provider: "claude",
        projectPath: cwd,
      })
    : undefined;
  signal?.throwIfAborted();
  const environment = filterEnvForChildProcess(process.env);
  const wrapped = sandbox?.wrapSpawn(
    command[0]!,
    command.slice(1),
    environment,
  );
  await new Promise<void>((resolve, reject) => {
    const child = (() => {
      try {
        return spawn(
          wrapped?.command ?? command[0]!,
          wrapped?.args ?? command.slice(1),
          {
            cwd: wrapped?.cwd ?? cwd,
            shell: false,
            stdio: wrapped?.stdio ?? ["pipe", "pipe", "pipe"],
            env: wrapped?.env ?? environment,
            ...processTreeSpawnOptions,
          },
        );
      } finally {
        wrapped?.release();
      }
    })();
    child.stdin?.end();
    let expired = false;
    const abort = () => signalProcessTree(child, "SIGKILL");
    signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => {
      expired = true;
      signal?.removeEventListener("abort", abort);
      signalProcessTree(child, "SIGKILL");
      child.stdout?.destroy();
      child.stderr?.destroy();
      reject(new Error("Template setup exceeded ten minutes"));
    }, 600_000);
    child.stdout?.on("data", (chunk: Buffer) =>
      onOutput(`[setup stdout] ${chunk.toString("utf8")}`),
    );
    child.stderr?.on("data", (chunk: Buffer) =>
      onOutput(`[setup stderr] ${chunk.toString("utf8")}`),
    );
    child.once("error", (error) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(error);
    });
    child.once("close", (code, exitSignal) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      signalProcessTree(child, "SIGKILL");
      if (expired) return;
      if (signal?.aborted) reject(new Error("Template setup was interrupted"));
      else if (code === 0) resolve();
      else reject(new Error(`Template setup failed (${exitSignal ?? code})`));
    });
  });
}
