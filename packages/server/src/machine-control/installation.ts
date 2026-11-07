import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, win32 } from "node:path";
import { z } from "zod";
import { verifyMachineControlSignature } from "./signature.js";

// MC's desktop updater key, independently shipped with YA. The legacy
// workstation component uses its own release contract/key.
const desktopKey = "RWQ0YYTnnIZqsBtzr7w+9aR8BEJNVQpa1pPM97LhC1Y5mSak7RnWxJus";

export interface InstalledMachineControl {
  root: string;
  directory: string;
  command: string;
  python: string;
  version: string;
  sourceRevision: string;
}

export type Execute = (
  command: string,
  args: string[],
  input?: string,
) => Promise<string>;

export const execute: Execute = (command, args, input) =>
  new Promise((resolveOutput, reject) => {
    let inputError: Error | undefined;
    const child = execFile(
      command,
      args,
      {
        timeout: 30_000,
        maxBuffer: 2 * 1024 * 1024,
        windowsHide: true,
      },
      (error, stdout) =>
        error || inputError
          ? reject(error ?? inputError)
          : resolveOutput(stdout),
    );
    child.stdin?.on("error", (error: Error) => {
      inputError = error;
      child.kill();
    });
    child.stdin?.end(input);
  });

export async function verifyMacApp(app: string, team: string, run = execute) {
  if (!/^[A-Z0-9]{10}$/u.test(team))
    throw new Error(
      "Machine Control requires a valid trusted publisher team ID",
    );
  const installed = await realpath(app);
  await run("/usr/bin/codesign", [
    "--verify",
    "--deep",
    "--strict",
    "-R",
    `=anchor apple generic and certificate leaf[subject.OU] = "${team}" and identifier "org.machine-control.app"`,
    installed,
  ]);
  return join(installed, "Contents", "Resources");
}

const identitySchema = z
  .object({
    schema: z.literal("machine-control-client-identity/v1"),
    clientProtocol: z.literal(1),
    residentProtocol: z.literal("machine-control/v0"),
    distribution: z.literal("desktop"),
    version: z.string().regex(/^\d+\.\d+\.\d+$/u),
    sourceRevision: z.string().regex(/^[a-f0-9]{40}$/u),
    platform: z.enum(["macos", "windows", "linux"]),
    target: z.string(),
    command: z.string(),
    pythonVersion: z.string(),
    pythonArchiveSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    features: z.array(z.string()).max(64),
  })
  .strict();

const inventorySchema = z
  .object({
    schema: z.literal("machine-control-client-files/v1"),
    files: z
      .array(
        z
          .object({
            path: z.string().min(1).max(1024),
            sha256: z.string().regex(/^[a-f0-9]{64}$/u),
            byteLength: z
              .number()
              .int()
              .nonnegative()
              .max(256 * 1024 * 1024),
          })
          .strict(),
      )
      .min(1)
      .max(10_000),
  })
  .strict();

async function boundedRead(path: string, limit: number) {
  const info = await lstat(path);
  if (!info.isFile() || info.size > limit)
    throw new Error("Invalid Machine Control metadata file");
  const bytes = await readFile(path);
  if (bytes.length > limit)
    throw new Error("Machine Control metadata exceeded limit");
  return bytes;
}

/** Hashes are checked only after the platform authenticates this receipt. */
export async function verifyClientFiles(root: string, bytes: Buffer) {
  const inventory = inventorySchema.parse(JSON.parse(bytes.toString("utf8")));
  const names = new Set<string>();
  let total = 0;
  for (const item of inventory.files) {
    if (
      item.path.startsWith("/") ||
      /[\\:]/u.test(item.path) ||
      item.path
        .split("/")
        .some((part) => !part || part === "." || part === "..") ||
      names.has(item.path)
    )
      throw new Error("Invalid Machine Control payload path");
    names.add(item.path);
    total += item.byteLength;
    if (total > 1024 * 1024 * 1024)
      throw new Error("Machine Control payload exceeded limit");
    const file = join(root, ...item.path.split("/"));
    const info = await lstat(file);
    if (
      !info.isFile() ||
      info.size !== item.byteLength ||
      (await realpath(file)) !== file
    )
      throw new Error("Machine Control payload identity mismatch");
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(file)) hash.update(chunk);
    if (hash.digest("hex") !== item.sha256)
      throw new Error("Machine Control payload digest mismatch");
  }
  const expected = new Set([...names, "files.json"]);
  let entries = 0;
  async function walk(directory: string, prefix = "", depth = 0) {
    if (depth > 20) throw new Error("Machine Control payload depth exceeded");
    for (const item of await readdir(directory, { withFileTypes: true })) {
      if (++entries > 20_000)
        throw new Error("Machine Control payload entries exceeded limit");
      const name = prefix + item.name;
      if (item.isDirectory())
        await walk(join(directory, item.name), name + "/", depth + 1);
      else if (!item.isFile() || !expected.delete(name)) {
        if (!item.isFile() || !["package.cat", "files.json.sig"].includes(name))
          throw new Error("Unexpected Machine Control payload");
      }
    }
  }
  await walk(root);
  if (expected.size) throw new Error("Incomplete Machine Control payload");
  return names;
}

// Test-FileCatalog cannot hash the running resident image. Verify the same
// bytes in a complete bounded copy against its signed catalog instead.
// No copied code is executed.
async function runtimeCatalogSnapshot(source: string) {
  const snapshot = await mkdtemp(join(tmpdir(), "ya-mc-runtime-catalog-"));
  let count = 0;
  let bytes = 0;
  async function copy(directory: string, destination: string, depth = 0) {
    if (depth > 20 || (await realpath(directory)) !== directory)
      throw new Error("Invalid Machine Control runtime directory");
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (++count > 20_000)
        throw new Error("Machine Control runtime entries exceeded limit");
      const input = join(directory, entry.name);
      const output = join(destination, entry.name);
      const info = await lstat(input);
      if ((await realpath(input)) !== input || info.isSymbolicLink())
        throw new Error("Machine Control runtime may not contain links");
      if (info.isDirectory()) {
        await mkdir(output);
        await copy(input, output, depth + 1);
      } else if (info.isFile()) {
        bytes += info.size;
        if (bytes > 512 * 1024 * 1024)
          throw new Error("Machine Control runtime exceeded limit");
        await copyFile(input, output);
      } else throw new Error("Invalid Machine Control runtime file");
    }
  }
  try {
    await copy(source, snapshot);
    return snapshot;
  } catch (error) {
    await rm(snapshot, { recursive: true, force: true });
    throw error;
  }
}

export async function verifyInstalledMachineControl(
  installation: string,
  publisher: string | undefined,
  platform = process.platform,
  run = execute,
): Promise<InstalledMachineControl> {
  const installed = await realpath(installation);
  let root: string;
  let windowsRuntime:
    | { sourceRevision: string; runtime: string; version: string }
    | undefined;
  if (platform === "darwin") {
    if (!publisher)
      throw new Error(
        "Machine Control requires YEP_MC_TEAM_ID from a trusted publisher source",
      );
    root = join(await verifyMacApp(installed, publisher, run), "mc-cli");
  } else if (platform === "win32") {
    if (!publisher)
      throw new Error(
        "Machine Control requires YEP_MC_PUBLISHER from a trusted publisher source",
      );
    root = join(installed, "mc-cli");
    const code = `$ErrorActionPreference='Stop'; $p=[Console]::In.ReadToEnd()|ConvertFrom-Json;
      foreach($file in @((Join-Path $p.install 'machine-control.exe'),(Join-Path $p.root 'package.cat'),
        (Join-Path $p.install 'runtime/package.cat'),(Join-Path $p.runtimeSnapshot 'package.cat'),
        (Join-Path $p.install 'runtime/machine-control-windows.exe'),
        (Join-Path $p.install 'runtime/providers/cua/cua-driver.exe'))) {
        $s=Get-AuthenticodeSignature -LiteralPath $file;
        if($s.Status -ne 'Valid' -or $null -eq $s.TimeStamperCertificate -or
          $s.SignerCertificate.GetNameInfo([Security.Cryptography.X509Certificates.X509NameType]::SimpleName,$false) -cne $p.publisher) {throw 'MC publisher verification failed'}
      }
      $version=(Get-Item -LiteralPath (Join-Path $p.install 'machine-control.exe')).VersionInfo.ProductVersion;
      if($version -notmatch '^[0-9]+[.][0-9]+[.][0-9]+$') {throw 'MC product version invalid'};
      # Since 0.5.3, the signed catalog authenticates files.json. YA then
      # verifies every full-byte payload hash before executing any CLI code.
      if([version]$version -ge [version]'0.5.3') {
        if((Test-FileCatalog -Path (Join-Path $p.root 'files.json') -CatalogFilePath (Join-Path $p.root 'package.cat')) -ne 'Valid') {throw 'MC CLI inventory catalog mismatch'};
      } elseif((Test-FileCatalog -Path $p.root -CatalogFilePath (Join-Path $p.root 'package.cat') -FilesToSkip 'package.cat') -ne 'Valid') {throw 'MC CLI catalog mismatch'};
      $runtimeRoot=$p.runtimeSnapshot;
      if((Test-FileCatalog -Path $runtimeRoot -CatalogFilePath (Join-Path $runtimeRoot 'package.cat') -FilesToSkip 'package.cat') -ne 'Valid') {throw 'MC runtime catalog mismatch'};
      $metadata=Join-Path $runtimeRoot 'desktop-runtime.json';
      if((Get-Item -LiteralPath $metadata).Length -gt 8192) {throw 'MC runtime metadata exceeded limit'};
      $runtime=Get-Content -LiteralPath $metadata -Raw | ConvertFrom-Json;
      if($runtime.schema -ne 'machine-control-desktop-runtime/v0' -or $runtime.profile -ne 'ordinary_user_desktop' -or $runtime.instance -ne 'desktop') {throw 'MC runtime profile mismatch'};
      [Console]::Out.Write((@{sourceRevision=$runtime.sourceRevision;runtime=$runtime.runtime;version=$version}|ConvertTo-Json -Compress))`;
    const snapshot = await runtimeCatalogSnapshot(join(installed, "runtime"));
    let result: string;
    try {
      result = await run(
        win32.join(
          process.env.SystemRoot ?? "C:\\Windows",
          "System32",
          "WindowsPowerShell",
          "v1.0",
          "powershell.exe",
        ),
        [
          "-NoProfile",
          "-NonInteractive",
          "-EncodedCommand",
          Buffer.from(code, "utf16le").toString("base64"),
        ],
        JSON.stringify({
          install: installed,
          root,
          publisher,
          runtimeSnapshot: snapshot,
        }),
      );
    } finally {
      await rm(snapshot, { recursive: true, force: true });
    }
    windowsRuntime = z
      .object({
        sourceRevision: z.string().regex(/^[a-f0-9]{40}$/u),
        runtime: z.enum(["win-x64", "win-arm64"]),
        version: z.string().regex(/^\d+\.\d+\.\d+$/u),
      })
      .strict()
      .parse(JSON.parse(result));
  } else if (platform === "linux") {
    root = join(installed, "mc-cli");
    const receipt = await boundedRead(
      join(root, "files.json"),
      2 * 1024 * 1024,
    );
    const signature = await boundedRead(join(root, "files.json.sig"), 8192);
    verifyMachineControlSignature(
      receipt,
      Buffer.from(signature.toString().trim(), "base64").toString("utf8"),
      desktopKey,
    );
  } else throw new Error("Machine Control desktop platform unavailable");
  if ((await realpath(root)) !== root)
    throw new Error("Machine Control CLI directory may not be a link");
  const files = await verifyClientFiles(
    root,
    await boundedRead(join(root, "files.json"), 2 * 1024 * 1024),
  );
  const identity = identitySchema.parse(
    JSON.parse(
      (await boundedRead(join(root, "client-runtime.json"), 8192)).toString(
        "utf8",
      ),
    ),
  );
  const expectedPlatform =
    platform === "darwin"
      ? "macos"
      : platform === "win32"
        ? "windows"
        : "linux";
  const arch =
    process.arch === "arm64"
      ? "aarch64"
      : process.arch === "x64"
        ? "x86_64"
        : "unsupported";
  const target = `${arch}-${platform === "darwin" ? "apple-darwin" : platform === "win32" ? "pc-windows-msvc" : "unknown-linux-gnu"}`;
  const commandName =
    platform === "win32" ? "machine-control.cmd" : "machine-control";
  if (
    (windowsRuntime &&
      (windowsRuntime.sourceRevision !== identity.sourceRevision ||
        windowsRuntime.version !== identity.version ||
        windowsRuntime.runtime !==
          (process.arch === "arm64" ? "win-arm64" : "win-x64"))) ||
    identity.platform !== expectedPlatform ||
    identity.target !== target ||
    identity.command !== `commands/${commandName}` ||
    ![
      "agent.instructions",
      "host.desktop",
      "host.browser",
      "host.claims",
    ].every((feature) => identity.features.includes(feature))
  )
    throw new Error(
      "Installed Machine Control CLI is incompatible with this host",
    );
  const python = join(
    root,
    "python",
    ...(platform === "win32" ? ["python.exe"] : ["bin", "python3"]),
  );
  for (const name of [
    "launch.py",
    "client/machine_control.py",
    "client/agent_interface.py",
    "client/scoped_run.py",
    "client/scoped_process.py",
    "providers/claims/claims.py",
    `commands/${commandName}`,
    platform === "win32" ? "python/python.exe" : "python/bin/python3",
    platform === "darwin"
      ? "platforms/macos/bin/machost"
      : platform === "win32"
        ? "platforms/windows/host/winhost.py"
        : "platforms/linux/host/linuxhost.py",
  ])
    if (!files.has(name))
      throw new Error("Incomplete Machine Control CLI dependency inventory");
  // Probe only after authenticating every executable/script dependency.
  const observed = identitySchema.parse(
    JSON.parse(
      await run(python, [
        "-I",
        "-B",
        join(root, "launch.py"),
        "agent",
        "identity",
      ]),
    ),
  );
  if (JSON.stringify(observed) !== JSON.stringify(identity))
    throw new Error("Machine Control CLI probe identity mismatch");
  return {
    root,
    directory: join(root, "commands"),
    command: join(root, "commands", commandName),
    python,
    version: identity.version,
    sourceRevision: identity.sourceRevision,
  };
}

export function defaultInstallation(
  platform: string,
  environment: NodeJS.ProcessEnv,
) {
  if (platform === "darwin") return "/Applications/Machine Control.app";
  if (platform === "win32" && environment.LOCALAPPDATA)
    return resolve(environment.LOCALAPPDATA, "Machine Control");
  if (platform === "linux") return "/usr/share/machine-control";
  throw new Error("Machine Control installation location unavailable");
}
