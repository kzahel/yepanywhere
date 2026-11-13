/** Verify an installed product and the provider-launch context composition. */
import { strict as assert } from "node:assert";
import { parseArgs } from "node:util";
import { tmpdir } from "node:os";
import { mkdtemp, cp, readFile, writeFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  execute,
  verifyInstalledMachineControl,
} from "../packages/server/src/machine-control/installation.js";
import { startMachineControlSession } from "../packages/server/src/sdk/providers/machine-control.js";
import type {
  AgentSession,
  StartSessionOptions,
} from "../packages/server/src/sdk/providers/types.js";

const { values } = parseArgs({
  options: { app: { type: "string" }, publisher: { type: "string" } },
});
assert(
  values.app,
  "--app is required; --publisher is required on macOS/Windows",
);
const installed = await verifyInstalledMachineControl(
  values.app,
  values.publisher,
);
let launch: StartSessionOptions | undefined;
await startMachineControlSession(
  "codex",
  { cwd: tmpdir(), permissionMode: "bypassPermissions", machineControl: true },
  async (options) => {
    launch = options;
    return {} as AgentSession;
  },
  {
    environment: {
      YEP_MC_APP: values.app,
      YEP_MC_TEAM_ID: values.publisher,
      YEP_MC_PUBLISHER: values.publisher,
      PATH: process.env.PATH,
    },
  },
);
assert(launch?.globalInstructions?.includes(installed.command));
assert(launch?.agentEnvironment?.PATH?.startsWith(installed.directory));
const instructions = await execute(installed.python, [
  "-I",
  "-B",
  `${installed.root}/launch.py`,
  "agent",
  "instructions",
]);
// Owned workflow text changes between releases; require only its stable
// claim lifecycle and that it still covers the browser surface.
assert(
  instructions.includes("claim release") && /\bbrowser\b/i.test(instructions),
);
console.log(
  "PASS authenticated installed CLI, compatible identity, owned instructions and launch-context composition",
);

if (process.platform !== "linux") {
  await assert.rejects(verifyInstalledMachineControl(values.app, "ZZZZZZZZZZ"));
}
const temporary = await mkdtemp(join(tmpdir(), "mc-cli-integrity-"));
try {
  const candidate = join(temporary, "Candidate.app");
  await cp(values.app, candidate, { recursive: true });
  await verifyInstalledMachineControl(candidate, values.publisher);
  const root =
    process.platform === "darwin"
      ? join(candidate, "Contents", "Resources", "mc-cli")
      : join(candidate, "mc-cli");
  const script = join(root, "client", "machine_control.py");
  const source = resolve(values.app);
  const relativeRoot =
    process.platform === "darwin" ? "Contents/Resources/mc-cli" : "mc-cli";
  const sourceScript = join(source, relativeRoot, "client/machine_control.py");
  const python = join(
    relativeRoot,
    "python",
    ...(process.platform === "win32" ? ["python.exe"] : ["bin", "python3"]),
  );
  const info = join(source, "Contents/Info.plist");
  async function negativeFixture(modifyScript: boolean) {
    await rm(candidate, { recursive: true, force: true });
    // Construct invalid bytes before the Mac bundle has its Info.plist.
    // App Management can refuse writes inside an already recognized notarized
    // app, including a disposable copy. Do not change the OS permission.
    await cp(source, candidate, {
      recursive: true,
      filter: (path) =>
        path !== (modifyScript ? sourceScript : join(source, python)) &&
        (process.platform !== "darwin" || path !== info),
    });
    if (modifyScript) {
      await writeFile(
        script,
        Buffer.concat([
          await readFile(sourceScript),
          Buffer.from("\n# integrity-negative\n"),
        ]),
      );
    }
    if (process.platform === "darwin")
      await cp(info, join(candidate, "Contents/Info.plist"));
  }
  await negativeFixture(true);
  await assert.rejects(
    verifyInstalledMachineControl(candidate, values.publisher),
  );
  await negativeFixture(false);
  await assert.rejects(
    verifyInstalledMachineControl(candidate, values.publisher),
  );
  console.log(
    process.platform === "linux"
      ? "PASS modified-script and missing-interpreter refusal before client execution"
      : "PASS wrong-publisher, modified-script and missing-interpreter refusal before client execution",
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}
