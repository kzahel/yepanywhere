import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { managePreview } from "../src/computer-control/native.js";
import { ComputerControlService } from "../src/computer-control/service.js";
import { ServerSettingsService } from "../src/services/ServerSettingsService.js";

// Deliberately imports no Machine Control source/build output. The operator
// supplies the independently authenticated, signed preview and isolated data.
const config = JSON.parse(await readFile(process.argv[2] ?? "", "utf8")) as {
  packageDirectory: string;
  trustedPublisher: string;
  dataDir: string;
  evidencePath: string;
};
const settings = new ServerSettingsService({ dataDir: config.dataDir });
await settings.initialize();
const service = new ComputerControlService(settings, config.dataDir);
const evidence: Record<string, unknown> = {
  schema: "ya-computer-native-acceptance/v1",
  passed: false,
};
try {
  const tampered = await mkdtemp(path.join(tmpdir(), "ya-untrusted-preview-"));
  try {
    const script = await readFile(
      path.join(config.packageDirectory, "workstation.ps1"),
      "utf8",
    );
    await writeFile(
      path.join(tampered, "workstation.ps1"),
      `${script}\nthrow 'UNTRUSTED_MANAGER_EXECUTED'\n`,
    );
    try {
      await managePreview(
        {
          packageDirectory: tampered,
          trustedPublisher: config.trustedPublisher,
        },
        service.instance,
        "Install",
      );
      throw new Error("Tampered manager was accepted");
    } catch (error) {
      if (!String(error).includes("selected trusted publisher signature"))
        throw error;
      evidence.tamperedManagerRefused = true;
    }
  } finally {
    await rm(tampered, { recursive: true, force: true });
  }
  const staging = await mkdtemp(path.join(tmpdir(), "ya-preview-import-"));
  try {
    await cp(config.packageDirectory, staging, { recursive: true });
    evidence.installed = await service.install({
      packageDirectory: staging,
      trustedPublisher: config.trustedPublisher,
    });
    evidence.usesInstalledCopy =
      service.config().preview?.packageDirectory !== staging;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
  evidence.originalImportRemoved = true;
  evidence.vanilla =
    service.select("vanilla", false, "codex") === undefined &&
    !service.status().running;
  await service.configure({
    ...service.config(),
    enabled: true,
    idleMs: 5000,
    grantMs: 120_000,
  });
  const selected = service.select("native-acceptance", true, "codex")!;
  evidence.deferred = !service.status().running;
  const windows = await selected.call("computer_control", {
    operation: "windows",
  });
  evidence.windows = {
    success: windows.success,
    metadata: windows.contentItems
      .filter((item) => item.type === "inputText")
      .map((item) => {
        const { data: _data, ...metadata } = JSON.parse(item.text);
        return metadata;
      }),
  };
  if (!windows.success) throw new Error(JSON.stringify(windows));
  const capture = await selected.call("computer_control", {
    operation: "screenshot",
  });
  evidence.capture = {
    success: capture.success,
    imageCount: capture.contentItems.filter(
      (item) => item.type === "inputImage",
    ).length,
    metadata: capture.contentItems.filter((item) => item.type === "inputText"),
  };
  if (
    !capture.success ||
    !capture.contentItems.some((item) => item.type === "inputImage")
  )
    throw new Error("Native capture failed");
  await new Promise((resolve) => setTimeout(resolve, 6500));
  evidence.idleStopped = !service.status().running;
  const reused = await selected.call("computer_control", {
    operation: "windows",
  });
  evidence.restarted = reused.success;
  await service.revoke("native-acceptance");
  evidence.revoked = !(
    await selected.call("computer_control", { operation: "windows" })
  ).success;
  evidence.stopped = !service.status().running;
  await service.uninstall();
  evidence.uninstalledWithoutImport =
    !service.config().preview && !service.config().enabled;
  evidence.passed =
    evidence.tamperedManagerRefused &&
    evidence.usesInstalledCopy &&
    evidence.originalImportRemoved &&
    evidence.uninstalledWithoutImport &&
    evidence.vanilla &&
    evidence.deferred &&
    evidence.idleStopped &&
    evidence.restarted &&
    evidence.revoked &&
    evidence.stopped;
} catch (error) {
  evidence.error = String(error);
} finally {
  await service.close();
  await writeFile(config.evidencePath, JSON.stringify(evidence, null, 2));
}
console.log(JSON.stringify({ passed: evidence.passed, error: evidence.error }));
if (!evidence.passed) process.exitCode = 1;
