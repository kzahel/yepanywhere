import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import { callComputerPipe } from "./pipe.js";
import { jobLauncher } from "./job-launcher.js";

export interface ComputerPreview {
  packageDirectory: string;
  trustedPublisher: string;
}
export function installedPreview(
  preview: ComputerPreview,
  instance: string,
  packageId: unknown,
): ComputerPreview {
  if (
    !process.env.LOCALAPPDATA ||
    typeof packageId !== "string" ||
    !/^[a-f0-9]{64}$/.test(packageId)
  )
    throw new Error("Invalid installed package identity");
  return {
    ...preview,
    packageDirectory: path.join(
      process.env.LOCALAPPDATA,
      "MachineControl",
      "packages",
      instance,
      "versions",
      packageId,
    ),
  };
}
export interface NativeOwner {
  sid: string;
  sessionId: number;
  instance: string;
  pipe: string;
  artifactRoot: string;
}
export interface NativeRuntime {
  owner: NativeOwner;
  generation: string;
  activity(): void;
  stop(): Promise<void>;
}

/** Runs only YA-authored code. Imported scripts are authenticated before use. */
function powershell(
  code: string,
  input: unknown,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    delete env.PSModulePath;
    const child = spawn(
      path.join(
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
        Buffer.from(
          `$ErrorActionPreference='Stop'; $p=[Console]::In.ReadToEnd() | ConvertFrom-Json; ${code}`,
          "utf16le",
        ).toString("base64"),
      ],
      { windowsHide: true, env, stdio: ["pipe", "pipe", "pipe"] },
    );
    let output = "";
    let error = "";
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error("Preview management deadline exceeded"));
    }, 120_000);
    child.on("error", (cause) => {
      clearTimeout(timeout);
      reject(cause);
    });
    child.stdout.on("data", (data: Buffer) => {
      output += data;
      if (output.length > 65536) child.kill();
    });
    child.stderr.on("data", (data: Buffer) => {
      error = (error + data).slice(0, 4096);
    });
    child.on("exit", (code) => {
      clearTimeout(timeout);
      if (code !== 0)
        return reject(new Error(`Preview management failed: ${error}`));
      try {
        resolve(JSON.parse(output.trim()) as Record<string, unknown>);
      } catch {
        reject(new Error("Invalid preview management response"));
      }
    });
    child.stdin.end(JSON.stringify(input));
  });
}

const authenticateManager = `
$script=Join-Path $p.packageDirectory 'workstation.ps1';
$sig=Get-AuthenticodeSignature -LiteralPath $script;
if ($sig.Status -ne 'Valid' -or $null -eq $sig.TimeStamperCertificate -or
    $sig.SignerCertificate.GetNameInfo([Security.Cryptography.X509Certificates.X509NameType]::SimpleName,$false) -cne $p.trustedPublisher) {
  throw 'Workstation manager does not have the selected trusted publisher signature'
};
`;

export async function managePreview(
  preview: ComputerPreview,
  instance: string,
  action: "Install" | "Uninstall",
) {
  return powershell(
    `${authenticateManager}
& $script -Action $p.action -Instance $p.instance -Package $p.packageDirectory -ExpectedPublisher $p.trustedPublisher
`,
    { ...preview, instance, action },
  );
}

export async function nativeOwner(instance: string): Promise<NativeOwner> {
  const identity = await powershell(
    `@{ sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value; sessionId=[Diagnostics.Process]::GetCurrentProcess().SessionId } | ConvertTo-Json -Compress`,
    {},
  );
  if (
    typeof identity.sid !== "string" ||
    !/^S-1-5-21-\d+-\d+-\d+-\d+$/.test(identity.sid) ||
    !Number.isInteger(identity.sessionId) ||
    Number(identity.sessionId) <= 0
  )
    throw new Error(
      "Computer control requires an interactive Windows user session",
    );
  const sessionId = Number(identity.sessionId);
  if (!process.env.LOCALAPPDATA)
    throw new Error("Local application data is unavailable");
  return {
    sid: identity.sid,
    sessionId,
    instance,
    pipe: `\\\\.\\pipe\\machine-control-user-${identity.sid}-${sessionId}-${instance}`,
    artifactRoot: path.join(
      process.env.LOCALAPPDATA,
      "MachineControl",
      "workstation",
      instance,
      `session-${sessionId}`,
      "artifacts",
    ),
  };
}

// Fixed lifecycle helper, created only on first use. IPC disconnect stops the
// exact child, even when Hono crashes. It cannot accept desktop/provider calls.
export const guardianSource = `
const {spawn}=require('node:child_process');
const net=require('node:net');
const {randomUUID}=require('node:crypto');
const path=require('node:path');
let child, residentPid, pipe, ending=false, timer;
function call(operation, expectedGeneration) { return new Promise((resolve,reject)=>{
 const requestId=randomUUID(); const s=net.createConnection(pipe); let text='';
 const t=setTimeout(()=>{s.destroy();reject(Error('timeout'));},3000);
 s.on('error',reject); s.on('close',()=>clearTimeout(t));
 s.on('connect',()=>s.write(JSON.stringify({operation,requestId,expectedGeneration})+'\\n'));
 s.on('data',chunk=>{text+=chunk;if(text.length>65536){s.destroy();reject(Error('size'));}
 if(text.includes('\\n')){s.destroy();try{const r=JSON.parse(text);if(r.requestId!==requestId)throw Error();resolve(r);}catch(e){reject(e);}}});
 }); }
async function stop(){if(ending)return;ending=true;clearTimeout(timer);
 const deadline=setTimeout(()=>{if(child&&child.exitCode===null)child.kill();process.exit();},10000);
 if(child && child.exitCode===null){try{const r=await call('status');if(r.data.processId===residentPid)await call('runtime.stop',r.generation);}catch{}
 setTimeout(()=>{if(child.exitCode===null)child.kill();process.exit();},4000);
 }else process.exit();}
process.on('disconnect',stop);
process.on('message',m=>{if(m.type==='start'&&!child){pipe=m.pipe;
 const env={...process.env};delete env.PSModulePath;
 child=spawn(path.join(process.env.SystemRoot||'C:\\\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe'),['-NoProfile','-NonInteractive','-EncodedCommand',${JSON.stringify(Buffer.from(jobLauncher, "utf16le").toString("base64"))}],{windowsHide:true,env,stdio:['pipe','pipe','ignore']});
 child.stdin.on('error',()=>stop());child.stdin.write(JSON.stringify({executable:m.executable,instance:m.instance})+'\\n');
 let output='';child.stdout.on('data',data=>{output+=data;if(output.length>4096)return stop();if(output.includes('\\n')){try{residentPid=JSON.parse(output.trim()).pid;process.send({pid:residentPid});}catch{stop();}}});
 child.on('error',()=>stop());child.on('exit',()=>process.exit());}
 if(m.type==='stop')stop();clearTimeout(timer);timer=setTimeout(stop,300000);});
`;

export async function startNative(
  preview: ComputerPreview,
  instance: string,
): Promise<NativeRuntime> {
  const owner = await nativeOwner(instance);
  // Install verifies the complete catalog, including existing staged content.
  // Rechecking before each cold start catches changes since operator install.
  const installed = await managePreview(preview, instance, "Install");
  if (
    typeof installed.packageId !== "string" ||
    !/^[a-f0-9]{64}$/.test(installed.packageId)
  )
    throw new Error("Invalid installed package identity");
  const executable = path.join(
    process.env.LOCALAPPDATA ?? "",
    "MachineControl",
    "packages",
    instance,
    "versions",
    installed.packageId,
    "machine-control-windows.exe",
  );
  const guard = spawn(process.execPath, ["-e", guardianSource], {
    windowsHide: true,
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  const stop = () => stopGuardian(guard);
  try {
    const pid = await new Promise<number>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("Resident guardian startup timed out")),
        15_000,
      );
      guard.once("error", reject);
      guard.once("exit", () => reject(new Error("Resident guardian exited")));
      guard.once("message", (message: { pid?: number }) => {
        clearTimeout(timeout);
        if (message.pid) resolve(message.pid);
        else reject(new Error("Missing resident PID"));
      });
      guard.send({ type: "start", executable, instance, pipe: owner.pipe });
    });
    // Pipe acquisition waits within one deadline; no written call is replayed.
    const result = await callComputerPipe(
      owner.pipe,
      { operation: "status", requestId: randomUUID() },
      15_000,
    );
    const data = result.data as Record<string, unknown> | undefined;
    if (
      !result.accepted ||
      result.sessionId !== owner.sessionId ||
      data?.processId !== pid ||
      data?.instance !== instance ||
      data?.profile !== "workstation" ||
      data?.integrityRid !== 8192 ||
      data?.isLocalSystem !== false ||
      data?.ready !== true ||
      typeof result.generation !== "string"
    )
      throw new Error("Resident ownership or desktop attestation failed");
    return {
      owner,
      generation: result.generation,
      stop,
      activity: () => {
        if (guard.connected) guard.send({ type: "activity" });
      },
    };
  } catch (error) {
    await stop();
    throw error;
  }
}

export function stopGuardian(guard: ChildProcess): Promise<void> {
  if (guard.exitCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const deadline = setTimeout(() => {
      if (guard.connected) guard.disconnect();
      reject(new Error("Resident guardian did not confirm exit"));
    }, 12_000);
    guard.once("exit", () => {
      clearTimeout(deadline);
      resolve();
    });
    if (guard.connected) guard.send({ type: "stop" });
    else {
      clearTimeout(deadline);
      reject(
        new Error(
          "Resident guardian IPC disconnected before exit confirmation",
        ),
      );
    }
  });
}

/** Images are bounded, exact native artifacts; never read a caller path. */
export async function readComputerImage(
  root: string,
  data: Record<string, unknown>,
): Promise<string> {
  if (
    typeof data.artifactId !== "string" ||
    !/^[a-f0-9]{32}$/.test(data.artifactId) ||
    typeof data.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(data.sha256) ||
    !Number.isSafeInteger(data.bytes) ||
    Number(data.bytes) < 24 ||
    Number(data.bytes) > 8 * 1024 * 1024
  )
    throw new Error("Invalid screenshot provenance");
  const target = path.join(root, `${data.artifactId}.png`);
  if (data.targetLocalPath !== target)
    throw new Error("Screenshot path does not match its artifact identity");
  const canonicalRoot = await realpath(root);
  const canonical = (value: string) =>
    process.platform === "win32" ? value.toLowerCase() : value;
  if (canonical(canonicalRoot) !== canonical(path.resolve(root)))
    throw new Error("Screenshot root contains a link");
  if (
    !Number.isSafeInteger(data.width) ||
    !Number.isSafeInteger(data.height) ||
    Number(data.width) < 1 ||
    Number(data.height) < 1 ||
    Number(data.width) > 16384 ||
    Number(data.height) > 16384 ||
    Number(data.width) * Number(data.height) > 64 * 1024 * 1024
  )
    throw new Error("Screenshot dimensions exceed bounds");
  if (
    (await realpath(target)) !==
      path.join(canonicalRoot, `${data.artifactId}.png`) ||
    (await lstat(target)).isSymbolicLink()
  )
    throw new Error("Screenshot escaped the owned artifact directory");
  const file = await open(target, "r");
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size !== data.bytes)
      throw new Error("Screenshot extent changed");
    const buffer = Buffer.alloc(stat.size);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (
      bytesRead !== stat.size ||
      !buffer
        .subarray(0, 8)
        .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
      createHash("sha256").update(buffer).digest("hex") !== data.sha256 ||
      buffer.readUInt32BE(16) !== data.width ||
      buffer.readUInt32BE(20) !== data.height
    )
      throw new Error("Screenshot hash, format or dimensions mismatch");
    return `data:image/png;base64,${buffer.toString("base64")}`;
  } finally {
    await file.close();
  }
}
