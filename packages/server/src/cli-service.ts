/**
 * CLI commands for installing yepanywhere as an auto-start service.
 *
 * Uses the platform-native auto-start mechanism so the server launches
 * silently in the background at login, with no console window:
 *   - Windows: a Scheduled Task that runs a hidden VBScript launcher
 *   - macOS:   a launchd LaunchAgent
 *   - Linux:   a systemd user service
 *
 * No external dependencies are used. The common alternative (a Windows
 * registry "Run" key) is deliberately avoided because it flashes a
 * console window on every login.
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getDataDir } from "./config.js";

/** Windows Scheduled Task name. */
const WINDOWS_TASK_NAME = "YepAnywhere";
/** macOS launchd label. */
const MACOS_LABEL = "com.yepanywhere.server";
/** Linux systemd user unit name. */
const LINUX_UNIT_NAME = "yepanywhere.service";

const SERVICE_DESCRIPTION =
  "Yep Anywhere - mobile-first supervisor for coding agents";

export interface InstallServiceOptions {
  /** Absolute path to the node executable. */
  nodePath: string;
  /** Absolute path to the CLI entry script. */
  scriptPath: string;
  /** Extra arguments to pass on startup (e.g. ["--port", "8000"]). */
  launchArgs: string[];
}

/**
 * Install yepanywhere as an auto-start service for the current platform.
 */
export async function installService(
  options: InstallServiceOptions,
): Promise<void> {
  const platform = os.platform();
  if (platform === "win32") {
    installWindows(options);
  } else if (platform === "darwin") {
    installMacos(options);
  } else if (platform === "linux") {
    installLinux(options);
  } else {
    throw new Error(
      `Auto-start is not supported on this platform: ${platform}`,
    );
  }
}

/**
 * Remove the auto-start service for the current platform.
 */
export async function uninstallService(): Promise<void> {
  const platform = os.platform();
  if (platform === "win32") {
    uninstallWindows();
  } else if (platform === "darwin") {
    uninstallMacos();
  } else if (platform === "linux") {
    uninstallLinux();
  } else {
    throw new Error(
      `Auto-start is not supported on this platform: ${platform}`,
    );
  }
}

/**
 * Print whether the auto-start service is installed for the current platform.
 */
export async function serviceStatus(): Promise<void> {
  const platform = os.platform();
  if (platform === "win32") {
    statusWindows();
  } else if (platform === "darwin") {
    statusMacos();
  } else if (platform === "linux") {
    statusLinux();
  } else {
    throw new Error(
      `Auto-start is not supported on this platform: ${platform}`,
    );
  }
}

// --- Windows -------------------------------------------------------------

function installWindows(options: InstallServiceOptions): void {
  const dataDir = getDataDir();
  fs.mkdirSync(dataDir, { recursive: true });

  const vbsPath = path.join(dataDir, "yepanywhere-launch.vbs");
  const command = buildCommandString(options);
  // In VBScript string literals a double quote is escaped by doubling it.
  const escapedCommand = command.replace(/"/g, '""');
  const vbs = `Set sh = CreateObject("WScript.Shell")\r\nsh.Run "${escapedCommand}", 0, False\r\n`;
  fs.writeFileSync(vbsPath, vbs, "utf-8");

  const xmlPath = path.join(dataDir, "yepanywhere-task.xml");
  // Task Scheduler expects UTF-16 with a BOM for /Create /XML.
  const bom = "﻿";
  fs.writeFileSync(xmlPath, `${bom}${buildTaskXml(vbsPath)}`, {
    encoding: "utf16le",
  });

  execFileSync(
    "schtasks",
    ["/Create", "/TN", WINDOWS_TASK_NAME, "/XML", xmlPath, "/F"],
    { stdio: "pipe" },
  );
  // Start now so the user does not have to log out and back in.
  execFileSync("schtasks", ["/Run", "/TN", WINDOWS_TASK_NAME], {
    stdio: "pipe",
  });

  console.log("Auto-start service installed (Windows Scheduled Task).");
  console.log(`Task name: ${WINDOWS_TASK_NAME}`);
  console.log("It will start on each login and is running now.");
}

function uninstallWindows(): void {
  try {
    execFileSync("schtasks", ["/Delete", "/TN", WINDOWS_TASK_NAME, "/F"], {
      stdio: "pipe",
    });
  } catch {
    console.log("No auto-start service was installed.");
    return;
  }
  const dataDir = getDataDir();
  removeIfExists(path.join(dataDir, "yepanywhere-launch.vbs"));
  removeIfExists(path.join(dataDir, "yepanywhere-task.xml"));
  console.log("Auto-start service removed.");
}

function statusWindows(): void {
  try {
    const out = execFileSync("schtasks", ["/Query", "/TN", WINDOWS_TASK_NAME], {
      stdio: "pipe",
      encoding: "utf-8",
    });
    console.log("Auto-start service is installed.");
    console.log(out.trim());
  } catch {
    console.log("Auto-start service is not installed.");
  }
}

function buildTaskXml(vbsPath: string): string {
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>${escapeXml(SERVICE_DESCRIPTION)}</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Enabled>true</Enabled>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>3</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>wscript.exe</Command>
      <Arguments>"${escapeXml(vbsPath)}"</Arguments>
    </Exec>
  </Actions>
</Task>`;
}

// --- macOS ---------------------------------------------------------------

function installMacos(options: InstallServiceOptions): void {
  const plistPath = path.join(
    os.homedir(),
    "Library",
    "LaunchAgents",
    `${MACOS_LABEL}.plist`,
  );
  const logPath = path.join(getDataDir(), "logs", "service.log");
  fs.mkdirSync(path.dirname(plistPath), { recursive: true });
  fs.mkdirSync(path.dirname(logPath), { recursive: true });

  const programArgs = [
    options.nodePath,
    options.scriptPath,
    ...options.launchArgs,
  ];
  fs.writeFileSync(plistPath, buildPlist(programArgs, logPath), "utf-8");

  try {
    execFileSync("launchctl", ["unload", plistPath], { stdio: "pipe" });
  } catch {
    // Not loaded yet; ignore.
  }
  execFileSync("launchctl", ["load", "-w", plistPath], { stdio: "pipe" });

  console.log("Auto-start service installed (launchd LaunchAgent).");
  console.log(`Plist: ${plistPath}`);
  console.log("It will start on each login and is running now.");
}

function uninstallMacos(): void {
  const plistPath = path.join(
    os.homedir(),
    "Library",
    "LaunchAgents",
    `${MACOS_LABEL}.plist`,
  );
  if (!fs.existsSync(plistPath)) {
    console.log("No auto-start service was installed.");
    return;
  }
  try {
    execFileSync("launchctl", ["unload", "-w", plistPath], { stdio: "pipe" });
  } catch {
    // Already unloaded; ignore.
  }
  removeIfExists(plistPath);
  console.log("Auto-start service removed.");
}

function statusMacos(): void {
  const plistPath = path.join(
    os.homedir(),
    "Library",
    "LaunchAgents",
    `${MACOS_LABEL}.plist`,
  );
  if (fs.existsSync(plistPath)) {
    console.log("Auto-start service is installed.");
    console.log(`Plist: ${plistPath}`);
  } else {
    console.log("Auto-start service is not installed.");
  }
}

function buildPlist(programArgs: string[], logPath: string): string {
  const argsXml = programArgs
    .map((arg) => `    <string>${escapeXml(arg)}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${MACOS_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${argsXml}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${escapeXml(logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(logPath)}</string>
</dict>
</plist>
`;
}

// --- Linux ---------------------------------------------------------------

function installLinux(options: InstallServiceOptions): void {
  const unitDir = path.join(os.homedir(), ".config", "systemd", "user");
  const unitPath = path.join(unitDir, LINUX_UNIT_NAME);
  fs.mkdirSync(unitDir, { recursive: true });

  const execStart = [
    options.nodePath,
    options.scriptPath,
    ...options.launchArgs,
  ]
    .map(quoteIfNeeded)
    .join(" ");
  const unit = `[Unit]
Description=${SERVICE_DESCRIPTION}
After=network.target

[Service]
Type=simple
ExecStart=${execStart}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`;
  fs.writeFileSync(unitPath, unit, "utf-8");

  execFileSync("systemctl", ["--user", "daemon-reload"], { stdio: "pipe" });
  execFileSync("systemctl", ["--user", "enable", "--now", LINUX_UNIT_NAME], {
    stdio: "pipe",
  });
  // Allow the service to keep running after logout and start at boot.
  try {
    execFileSync("loginctl", ["enable-linger", os.userInfo().username], {
      stdio: "pipe",
    });
  } catch {
    // Lingering is optional; ignore if not permitted.
  }

  console.log("Auto-start service installed (systemd user service).");
  console.log(`Unit: ${unitPath}`);
  console.log("It will start on each login and is running now.");
}

function uninstallLinux(): void {
  const unitPath = path.join(
    os.homedir(),
    ".config",
    "systemd",
    "user",
    LINUX_UNIT_NAME,
  );
  if (!fs.existsSync(unitPath)) {
    console.log("No auto-start service was installed.");
    return;
  }
  try {
    execFileSync("systemctl", ["--user", "disable", "--now", LINUX_UNIT_NAME], {
      stdio: "pipe",
    });
  } catch {
    // Already stopped/disabled; ignore.
  }
  removeIfExists(unitPath);
  try {
    execFileSync("systemctl", ["--user", "daemon-reload"], { stdio: "pipe" });
  } catch {
    // Ignore.
  }
  console.log("Auto-start service removed.");
}

function statusLinux(): void {
  const unitPath = path.join(
    os.homedir(),
    ".config",
    "systemd",
    "user",
    LINUX_UNIT_NAME,
  );
  if (fs.existsSync(unitPath)) {
    console.log("Auto-start service is installed.");
    console.log(`Unit: ${unitPath}`);
  } else {
    console.log("Auto-start service is not installed.");
  }
}

// --- Shared helpers ------------------------------------------------------

/** Build a quoted command line: "node" "cli.js" arg1 arg2 ... */
function buildCommandString(options: InstallServiceOptions): string {
  const parts = [`"${options.nodePath}"`, `"${options.scriptPath}"`];
  for (const arg of options.launchArgs) {
    parts.push(arg);
  }
  return parts.join(" ");
}

function quoteIfNeeded(value: string): string {
  return /\s/.test(value) ? `"${value}"` : value;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function removeIfExists(filePath: string): void {
  try {
    fs.rmSync(filePath, { force: true });
  } catch {
    // Ignore.
  }
}
