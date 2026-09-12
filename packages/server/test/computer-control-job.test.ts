import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { jobLauncher } from "../src/computer-control/job-launcher.js";

const powershell = path.join(
  process.env.SystemRoot ?? "C:\\Windows",
  "System32",
  "WindowsPowerShell",
  "v1.0",
  "powershell.exe",
);
const fixture = `using System;using System.Diagnostics;using System.IO;using System.Threading;
public static class Fixture { public static void Main(string[] args) {
 if(args.Length==0 || args[0]!="descendant") {
  var child=Process.Start(new ProcessStartInfo { FileName=Process.GetCurrentProcess().MainModule.FileName, Arguments="descendant", UseShellExecute=false, CreateNoWindow=true });
  File.WriteAllText(Environment.GetEnvironmentVariable("YA_TEST_DESCENDANT_FILE"),child.Id.ToString());
 }
 Thread.Sleep(60000);
} }`;
function ps(code: string) {
  return [
    "-NoProfile",
    "-NonInteractive",
    "-EncodedCommand",
    Buffer.from(code, "utf16le").toString("base64"),
  ];
}
function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
async function until(predicate: () => Promise<boolean> | boolean) {
  const deadline = Date.now() + 15_000;
  while (!(await predicate())) {
    if (Date.now() > deadline)
      throw new Error("Owned process cleanup deadline exceeded");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe.skipIf(process.platform !== "win32")("Windows job ownership", () => {
  for (const crash of ["resident", "launcher", "owner EOF"] as const)
    it(`reclaims resident descendants after ${crash} crash and leaves unrelated processes alive`, async () => {
      const root = await mkdtemp(path.join(tmpdir(), "ya-job-"));
      const exe = path.join(root, "fixture.exe");
      const pidFile = path.join(root, "descendant.pid");
      let launcher: ChildProcess | undefined;
      let unrelated: ChildProcess | undefined;
      let residentPid = 0;
      let descendantPid = 0;
      try {
        const compiler = spawn(
          powershell,
          ps(
            "$ErrorActionPreference='Stop';$p=[Console]::In.ReadToEnd()|ConvertFrom-Json;Add-Type -TypeDefinition $p.source -OutputAssembly $p.exe -OutputType ConsoleApplication",
          ),
          { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
        );
        compiler.stdin.end(JSON.stringify({ source: fixture, exe }));
        let compileError = "";
        compiler.stderr.on("data", (data) => {
          compileError += data;
        });
        await new Promise<void>((resolve, reject) => {
          compiler.on("error", reject);
          compiler.on("exit", (code) =>
            code === 0 ? resolve() : reject(new Error(compileError)),
          );
        });
        unrelated = spawn(exe, ["descendant"], {
          windowsHide: true,
          stdio: "ignore",
        });
        launcher = spawn(powershell, ps(jobLauncher), {
          windowsHide: true,
          env: { ...process.env, YA_TEST_DESCENDANT_FILE: pidFile },
          stdio: ["pipe", "pipe", "pipe"],
        });
        const currentLauncher = launcher;
        let output = "";
        let error = "";
        currentLauncher.stderr?.on("data", (data) => {
          error += data;
        });
        currentLauncher.stdin?.write(
          `${JSON.stringify({ executable: exe, instance: "test" })}\n`,
        );
        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(
            () => reject(new Error(`Job startup timeout: ${error}`)),
            15_000,
          );
          currentLauncher.on("error", reject);
          currentLauncher.on("exit", () => {
            clearTimeout(timeout);
            if (!residentPid) reject(new Error(error || "Launcher exited"));
          });
          currentLauncher.stdout?.on("data", (data) => {
            output += data;
            if (output.includes("\n")) {
              residentPid = JSON.parse(output.trim()).pid;
              clearTimeout(timeout);
              resolve();
            }
          });
        });
        await until(async () => {
          try {
            descendantPid = Number(await readFile(pidFile, "utf8"));
            return descendantPid > 0;
          } catch {
            return false;
          }
        });
        expect(alive(residentPid)).toBe(true);
        expect(alive(descendantPid)).toBe(true);
        if (crash === "resident") process.kill(residentPid);
        else if (crash === "launcher") currentLauncher.kill();
        else currentLauncher.stdin?.end();
        await until(() => !alive(residentPid) && !alive(descendantPid));
        expect(alive(unrelated.pid!)).toBe(true);
      } finally {
        launcher?.stdin?.end();
        launcher?.kill();
        unrelated?.kill();
        for (const pid of [residentPid, descendantPid])
          if (pid && alive(pid)) process.kill(pid);
        // Owned executable handles need a bounded chance to close on Windows.
        await rm(root, {
          recursive: true,
          force: true,
          maxRetries: 10,
          retryDelay: 100,
        });
      }
    }, 40_000);
});
