import { type ChildProcess, execSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createInterface } from "node:readline";
import type {
  DeviceICECandidate,
  DeviceICECandidateEvent,
  DeviceInfo,
  DeviceSessionState,
  DeviceStreamProfileEvent,
  DeviceStreamStart,
  DeviceStreamStop,
  DeviceType,
  DeviceWebRTCAnswer,
  DeviceWebRTCOffer,
  RTCIceCandidateInit,
} from "@yep-anywhere/shared";
import { WebSocket } from "ws";
import { isUpdateCheckEnabled } from "../update-check.js";
import { isNewerSemver } from "../utils/semver.js";

/** Fallback bridge version if update server is unreachable. */
const BRIDGE_VERSION_FALLBACK = "0.0.1";

/** Update server endpoint for bridge version. */
const BRIDGE_VERSION_URL = "https://updates.yepanywhere.com/bridge/version";

/** GitHub repo for downloading bridge binaries. */
const BRIDGE_REPO = "kzahel/yepanywhere";

/** Cached bridge version from update server (5 minute TTL). */
let cachedBridgeVersion: { version: string; timestamp: number } | null = null;
const BRIDGE_VERSION_CACHE_TTL_MS = 5 * 60 * 1000;

async function getBridgeVersion(options?: {
  forceRefresh?: boolean;
}): Promise<string> {
  if (
    !options?.forceRefresh &&
    cachedBridgeVersion &&
    Date.now() - cachedBridgeVersion.timestamp < BRIDGE_VERSION_CACHE_TTL_MS
  ) {
    return cachedBridgeVersion.version;
  }

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);
    const response = await fetch(BRIDGE_VERSION_URL, {
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (!response.ok) {
      console.warn(
        `[DeviceBridge] Update server returned ${response.status}, using fallback version`,
      );
      return BRIDGE_VERSION_FALLBACK;
    }

    const data = (await response.json()) as { version?: string };
    if (data.version) {
      cachedBridgeVersion = { version: data.version, timestamp: Date.now() };
      return data.version;
    }
  } catch {
    console.warn(
      "[DeviceBridge] Failed to fetch bridge version, using fallback",
    );
  }

  return BRIDGE_VERSION_FALLBACK;
}
const ANDROID_SERVER_APK_NAME = "yep-device-server.apk";
const ANDROID_SERVER_APK_ENV_VAR = "ANDROID_DEVICE_SERVER_APK";
const DATA_DIR_ENV_VAR = "YEP_DATA_DIR";
const USE_APK_FOR_EMULATORS_ENV_VAR = "DEVICE_BRIDGE_USE_APK_FOR_EMULATOR";

/** Sidecar stdout handshake message */
interface SidecarHandshake {
  port: number;
  version: string;
}

type BridgeBinarySource = "dev" | "prod";

interface BridgeBinaryCandidate {
  path: string;
  source: BridgeBinarySource;
}

interface CachedBinaryVersion {
  path: string;
  mtimeMs: number;
  version: string | null;
}

export interface DeviceBridgeStatus {
  state: "available" | "downloadable" | "update-available";
  installedVersion: string | null;
  latestVersion: string | null;
}

/** IPC message from sidecar → server */
interface SidecarMessage {
  type: string;
  sessionId?: string;
  deviceId?: string;
  sdp?: string;
  candidate?: RTCIceCandidateInit | null;
  state?: string;
  error?: string;
  width?: number;
  height?: number;
  fps?: number;
  bitrate?: number;
  tier?: number;
  totalTiers?: number;
  direction?: "downshift" | "upshift";
}

/** Callback for forwarding sidecar messages to a specific client */
type ClientSendFn = (
  msg:
    | DeviceWebRTCOffer
    | DeviceICECandidateEvent
    | DeviceSessionState
    | DeviceStreamProfileEvent,
) => void;

export interface DeviceBridgeServiceOptions {
  /** Path to adb binary */
  adbPath: string;
  /** Data directory for locating the sidecar binary */
  dataDir: string;
}

/**
 * Manages the device-bridge sidecar lifecycle and proxies
 * WebRTC signaling between clients and the sidecar.
 */
export class DeviceBridgeService {
  private adbPath: string;
  private dataDir: string;
  private process: ChildProcess | null = null;
  private ws: WebSocket | null = null;
  private port: number | null = null;
  private available = false;
  private starting = false;
  private startPromise: Promise<void> | null = null;
  private restartAttempts = 0;
  private maxRestartAttempts = 5;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  /** Timestamp of last failed start attempt (for cooldown). */
  private lastStartFailure = 0;
  /** Cooldown period after a failed start (10s). */
  private startCooldownMs = 10_000;
  private activeBinaryPath: string | null = null;
  private runningBridgeVersion: string | null = null;
  private binaryVersionCache: CachedBinaryVersion | null = null;

  /** Maps streaming sessionId → client send function */
  private clientSenders = new Map<string, ClientSendFn>();

  constructor(options: DeviceBridgeServiceOptions) {
    this.adbPath = options.adbPath;
    this.dataDir = options.dataDir;
  }

  /** Whether the bridge is available (sidecar running and connected). */
  isAvailable(): boolean {
    return this.available;
  }

  /** Find the sidecar binary path and whether it is managed by auto-update. */
  private findBinaryCandidate(): BridgeBinaryCandidate | null {
    // Dev mode: local build
    const devExt = os.platform() === "win32" ? ".exe" : "";
    const devPath = path.resolve(
      import.meta.dirname,
      `../../../device-bridge/bridge${devExt}`,
    );
    if (fs.existsSync(devPath)) {
      return { path: devPath, source: "dev" };
    }

    // Production: downloaded binary
    const p = os.platform();
    const platform =
      p === "darwin" ? "darwin" : p === "win32" ? "windows" : "linux";
    const arch = os.arch() === "arm64" ? "arm64" : "amd64";
    const ext = p === "win32" ? ".exe" : "";
    const prodPath = path.join(
      this.dataDir,
      "bin",
      `device-bridge-${platform}-${arch}${ext}`,
    );
    if (fs.existsSync(prodPath)) {
      return { path: prodPath, source: "prod" };
    }

    return null;
  }

  /** Find the sidecar binary path. */
  private findBinaryPath(): string | null {
    return this.findBinaryCandidate()?.path ?? null;
  }

  /** Whether the sidecar binary is available (without starting it). */
  hasBinary(): boolean {
    return this.findBinaryPath() !== null;
  }

  /** Get the platform-specific binary name (e.g. "device-bridge-darwin-arm64"). */
  private getBinaryInfo() {
    const p = os.platform();
    const platform =
      p === "darwin" ? "darwin" : p === "win32" ? "windows" : "linux";
    const arch = os.arch() === "arm64" ? "arm64" : "amd64";
    const ext = p === "win32" ? ".exe" : "";
    const name = `device-bridge-${platform}-${arch}${ext}`;
    return { platform, arch, ext, name };
  }

  /** Production binary path (where auto-download writes to). */
  private getProdBinaryPath(): string {
    const { name } = this.getBinaryInfo();
    return path.join(this.dataDir, "bin", name);
  }

  private isRunningProductionBinary(): boolean {
    return this.activeBinaryPath === this.getProdBinaryPath();
  }

  /** Production Android server APK path (where auto-download writes to). */
  private getProdAndroidServerAPKPath(): string {
    return path.join(this.dataDir, "bin", ANDROID_SERVER_APK_NAME);
  }

  /** Optional explicit Android server APK path override from env. */
  private getConfiguredAndroidServerAPKPath(): string | null {
    const configured = process.env[ANDROID_SERVER_APK_ENV_VAR]?.trim();
    return configured || null;
  }

  /** Resolve an existing Android server APK path for sidecar startup. */
  private findExistingAndroidServerAPKPath(): string | null {
    const configured = this.getConfiguredAndroidServerAPKPath();
    if (configured && fs.existsSync(configured)) {
      return configured;
    }

    const candidates = [
      this.getProdAndroidServerAPKPath(),
      path.resolve(
        import.meta.dirname,
        "../../../android-device-server/app/build/outputs/apk/release/yep-device-server.apk",
      ),
      path.resolve(
        process.cwd(),
        "packages/android-device-server/app/build/outputs/apk/release/yep-device-server.apk",
      ),
      path.resolve(
        process.cwd(),
        "app/build/outputs/apk/release/yep-device-server.apk",
      ),
      path.join(os.homedir(), ".yep-anywhere", "bin", ANDROID_SERVER_APK_NAME),
    ];

    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }

    return null;
  }

  private shouldUseAPKForEmulators(): boolean {
    const value = process.env[USE_APK_FOR_EMULATORS_ENV_VAR]
      ?.trim()
      .toLowerCase();
    return (
      value === "1" || value === "true" || value === "yes" || value === "on"
    );
  }

  private needsAndroidServerAPK(
    deviceId: string,
    deviceType?: DeviceType,
  ): boolean {
    if (deviceType) {
      if (deviceType === "android") return true;
      if (deviceType === "chromeos" || deviceType === "ios-simulator")
        return false;
      if (deviceType === "emulator") return this.shouldUseAPKForEmulators();
    }

    const id = deviceId.trim();
    if (!id) {
      return false;
    }
    if (id.startsWith("android:")) {
      return true;
    }
    if (id === "chromeos" || id.startsWith("chromeos:")) {
      return false;
    }
    if (id.startsWith("avd-")) {
      return false;
    }
    if (id.startsWith("emulator-")) {
      return this.shouldUseAPKForEmulators();
    }
    return true;
  }

  private async probeBinaryVersion(binaryPath: string): Promise<string | null> {
    const child = spawn(binaryPath, ["--ipc", "--adb-path", this.adbPath], {
      stdio: ["ignore", "pipe", "ignore"],
      env: {
        ...process.env,
        [DATA_DIR_ENV_VAR]: this.dataDir,
      },
    });

    try {
      const handshake = await this.readHandshake(child);
      return handshake.version || null;
    } catch (err) {
      console.warn(
        `[DeviceBridge] Failed to probe bridge version for ${binaryPath}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return null;
    } finally {
      if (!child.killed) {
        child.kill("SIGTERM");
      }
    }
  }

  private async getInstalledBinaryVersion(
    binaryPath: string,
  ): Promise<string | null> {
    if (
      this.activeBinaryPath === binaryPath &&
      this.runningBridgeVersion &&
      this.process
    ) {
      return this.runningBridgeVersion;
    }

    try {
      const stat = fs.statSync(binaryPath);
      if (
        this.binaryVersionCache &&
        this.binaryVersionCache.path === binaryPath &&
        this.binaryVersionCache.mtimeMs === stat.mtimeMs
      ) {
        return this.binaryVersionCache.version;
      }

      const version = await this.probeBinaryVersion(binaryPath);
      this.binaryVersionCache = {
        path: binaryPath,
        mtimeMs: stat.mtimeMs,
        version,
      };
      return version;
    } catch {
      return null;
    }
  }

  async getBridgeStatus(options?: {
    forceRefresh?: boolean;
  }): Promise<DeviceBridgeStatus> {
    const binary = this.findBinaryCandidate();
    if (!binary) {
      return {
        state: "downloadable",
        installedVersion: null,
        latestVersion: null,
      };
    }

    if (binary.source === "dev") {
      return {
        state: "available",
        installedVersion: null,
        latestVersion: null,
      };
    }

    const [installedVersion, latestVersion] = await Promise.all([
      this.getInstalledBinaryVersion(binary.path),
      isUpdateCheckEnabled()
        ? getBridgeVersion({ forceRefresh: options?.forceRefresh })
        : null,
    ]);

    const state =
      !installedVersion ||
      (latestVersion && isNewerSemver(installedVersion, latestVersion))
        ? "update-available"
        : "available";

    return {
      state,
      installedVersion,
      latestVersion,
    };
  }

  private async downloadReleaseAsset(
    name: string,
    destPath: string,
    options?: { executable?: boolean; kindLabel?: string },
  ): Promise<string> {
    const kindLabel = options?.kindLabel ?? name;
    const bridgeVersion = await getBridgeVersion({ forceRefresh: true });
    const url = `https://github.com/${BRIDGE_REPO}/releases/download/bridge-v${bridgeVersion}/${name}`;
    const destDir = path.dirname(destPath);
    fs.mkdirSync(destDir, { recursive: true });

    console.log(`[DeviceBridge] Downloading ${kindLabel} from ${url}`);

    const response = await fetch(url, { redirect: "follow" });
    if (!response.ok) {
      throw new Error(
        `Failed to download ${kindLabel}: ${response.status} ${response.statusText}`,
      );
    }

    const tmpPath = `${destPath}.tmp`;
    const buffer = Buffer.from(await response.arrayBuffer());
    fs.writeFileSync(tmpPath, buffer);
    fs.renameSync(tmpPath, destPath);

    if (options?.executable && os.platform() !== "win32") {
      fs.chmodSync(destPath, 0o755);
    }

    console.log(
      `[DeviceBridge] Downloaded ${kindLabel} (${(buffer.length / 1024 / 1024).toFixed(1)} MB)`,
    );
    return destPath;
  }

  /** Download the bridge binary from GitHub releases. */
  async downloadBinary(): Promise<string> {
    const { name } = this.getBinaryInfo();
    const destPath = this.getProdBinaryPath();
    return this.downloadReleaseAsset(name, destPath, {
      executable: true,
      kindLabel: "bridge binary",
    });
  }

  /** Download the Android device server APK from GitHub releases. */
  async downloadAndroidServerAPK(): Promise<string> {
    return this.downloadReleaseAsset(
      ANDROID_SERVER_APK_NAME,
      this.getProdAndroidServerAPKPath(),
      { kindLabel: "Android device server APK" },
    );
  }

  /** Download both runtime dependencies needed for bridge/device streaming. */
  async downloadRuntimeDependencies(): Promise<{
    binaryPath: string;
    apkPath: string;
  }> {
    const shouldRestartManagedSidecar = this.isRunningProductionBinary();
    const wasRunning = shouldRestartManagedSidecar && this.isAvailable();

    if (shouldRestartManagedSidecar && os.platform() === "win32") {
      await this.shutdown();
    }

    const [binaryPath, apkPath] = await Promise.all([
      this.downloadBinary(),
      this.downloadAndroidServerAPK(),
    ]);

    this.binaryVersionCache = null;

    if (shouldRestartManagedSidecar && os.platform() !== "win32") {
      await this.shutdown();
    }
    if (wasRunning) {
      await this.ensureStarted();
    }

    return { binaryPath, apkPath };
  }

  /** Ensure Android server APK exists before starting Android/APK transport sessions. */
  private async ensureAndroidServerAPK(): Promise<string> {
    const configured = this.getConfiguredAndroidServerAPKPath();
    if (configured) {
      if (!fs.existsSync(configured)) {
        throw new Error(
          `${ANDROID_SERVER_APK_ENV_VAR} is set but file does not exist: ${configured}`,
        );
      }
      return configured;
    }

    const existing = this.findExistingAndroidServerAPKPath();
    if (existing) {
      return existing;
    }

    return this.downloadAndroidServerAPK();
  }

  /** Ensure the sidecar is running. Lazy start on first use. */
  async ensureStarted(): Promise<void> {
    if (this.available) return;
    if (this.startPromise) return this.startPromise;

    // Don't retry too quickly after a failure
    const elapsed = Date.now() - this.lastStartFailure;
    if (this.lastStartFailure > 0 && elapsed < this.startCooldownMs) {
      throw new Error(
        `Sidecar start on cooldown (${Math.ceil((this.startCooldownMs - elapsed) / 1000)}s remaining)`,
      );
    }

    this.startPromise = this.start();
    try {
      await this.startPromise;
    } catch (err) {
      this.lastStartFailure = Date.now();
      throw err;
    } finally {
      this.startPromise = null;
    }
  }

  /** Kill any stale bridge processes from previous server runs. */
  private killStaleProcesses(): void {
    const binaryPath = this.findBinaryPath();
    if (!binaryPath) return;

    const currentPid = this.process?.pid;

    try {
      // Find all processes matching the bridge binary path
      const result = execSync(`pgrep -f "${binaryPath}" 2>/dev/null`, {
        encoding: "utf-8",
        timeout: 3000,
      }).trim();

      if (result) {
        const pids = result
          .split("\n")
          .filter(Boolean)
          .map(Number)
          .filter((pid) => pid !== currentPid);
        for (const pid of pids) {
          try {
            process.kill(pid, "SIGTERM");
            console.log(`[DeviceBridge] Killed stale bridge process ${pid}`);
          } catch {
            // Process might have already exited.
          }
        }
      }
    } catch {
      // pgrep returns non-zero if no matches — expected.
    }
  }

  /** Start the sidecar process and establish IPC. */
  private async start(): Promise<void> {
    if (this.starting) return;
    this.starting = true;

    // Cancel any pending restart timer to prevent cascading restarts.
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }

    try {
      const binary = this.findBinaryCandidate();
      if (!binary) {
        throw new Error(
          "Device bridge binary not found. Build it or download it first.",
        );
      }
      const binaryPath = binary.path;

      // Kill any orphaned bridge processes from previous server runs.
      this.killStaleProcesses();

      console.log(`[DeviceBridge] Starting sidecar: ${binaryPath}`);

      const sidecarEnv: NodeJS.ProcessEnv = {
        ...process.env,
        [DATA_DIR_ENV_VAR]: this.dataDir,
      };
      const apkPath = this.findExistingAndroidServerAPKPath();
      if (apkPath) {
        sidecarEnv[ANDROID_SERVER_APK_ENV_VAR] = apkPath;
      }

      const child = spawn(binaryPath, ["--ipc", "--adb-path", this.adbPath], {
        stdio: ["pipe", "pipe", "pipe"],
        env: sidecarEnv,
      });

      this.process = child;

      // Read the handshake from stdout (first line).
      const handshake = await this.readHandshake(child);
      this.port = handshake.port;
      this.activeBinaryPath = binaryPath;
      this.runningBridgeVersion = handshake.version;
      this.binaryVersionCache = {
        path: binaryPath,
        mtimeMs: fs.statSync(binaryPath).mtimeMs,
        version: handshake.version,
      };

      console.log(
        `[DeviceBridge] Sidecar started on port ${this.port} (v${handshake.version})`,
      );

      // Pipe stderr to our console.
      child.stderr?.on("data", (data: Buffer) => {
        const lines = data.toString().trim().split("\n");
        for (const line of lines) {
          console.log(`[DeviceBridge/sidecar] ${line}`);
        }
      });

      // Monitor exit — ignore stale events from previously-killed processes.
      child.on("exit", (code, signal) => {
        if (this.process !== child) return;
        console.warn(
          `[DeviceBridge] Sidecar exited (code=${code}, signal=${signal})`,
        );
        this.cleanup();
        // Don't auto-restart on clean exit (idle shutdown, code=0)
        // or intentional kill (code=null, signal=SIGTERM).
        if (code != null && code !== 0) {
          this.scheduleRestart();
        }
      });

      // Connect WebSocket.
      await this.connectWebSocket();

      this.available = true;
      this.restartAttempts = 0;
      this.lastStartFailure = 0;
    } finally {
      this.starting = false;
    }
  }

  /** Read the JSON handshake from the sidecar's stdout. */
  private readHandshake(child: ChildProcess): Promise<SidecarHandshake> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("Sidecar handshake timed out (5s)"));
      }, 5000);

      if (!child.stdout) {
        reject(new Error("Sidecar process has no stdout"));
        return;
      }
      const rl = createInterface({ input: child.stdout });
      rl.once("line", (line) => {
        clearTimeout(timeout);
        rl.close();
        try {
          const data = JSON.parse(line) as SidecarHandshake;
          if (!data.port) {
            reject(new Error(`Invalid handshake: ${line}`));
          } else {
            resolve(data);
          }
        } catch {
          reject(new Error(`Failed to parse handshake: ${line}`));
        }
      });

      child.on("error", (err) => {
        clearTimeout(timeout);
        reject(err);
      });

      child.on("exit", (code) => {
        clearTimeout(timeout);
        reject(new Error(`Sidecar exited during handshake (code=${code})`));
      });
    });
  }

  /** Connect to the sidecar's WebSocket IPC. */
  private connectWebSocket(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${this.port}/ws`);

      const timeout = setTimeout(() => {
        ws.close();
        reject(new Error("WebSocket connect timed out (5s)"));
      }, 5000);

      ws.on("open", () => {
        clearTimeout(timeout);
        this.ws = ws;
        console.log("[DeviceBridge] WebSocket connected to sidecar");
        resolve();
      });

      ws.on("message", (data) => {
        this.handleSidecarMessage(data.toString());
      });

      ws.on("close", () => {
        if (this.ws === ws) {
          console.warn("[DeviceBridge] WebSocket closed");
          this.ws = null;
        }
      });

      ws.on("error", (err) => {
        clearTimeout(timeout);
        console.error("[DeviceBridge] WebSocket error:", err.message);
        reject(err);
      });
    });
  }

  /** Handle a message from the sidecar. */
  private handleSidecarMessage(raw: string): void {
    let msg: SidecarMessage;
    try {
      msg = JSON.parse(raw);
    } catch {
      console.warn("[DeviceBridge] Bad sidecar message:", raw);
      return;
    }

    const sessionId = msg.sessionId;
    if (!sessionId) return;

    const send = this.clientSenders.get(sessionId);
    if (!send) {
      // No client registered for this session (might have disconnected).
      return;
    }

    switch (msg.type) {
      case "webrtc.offer":
        if (msg.sdp) {
          send({
            type: "device_webrtc_offer",
            sessionId,
            sdp: msg.sdp,
          });
        }
        break;

      case "webrtc.ice":
        send({
          type: "device_ice_candidate_event",
          sessionId,
          candidate: msg.candidate ?? null,
        });
        break;

      case "session.state":
        send({
          type: "device_session_state",
          sessionId,
          state: msg.state as
            | "connecting"
            | "connected"
            | "disconnected"
            | "failed",
          error: msg.error,
        });
        break;

      case "stream.profile":
        if (
          typeof msg.width === "number" &&
          typeof msg.height === "number" &&
          typeof msg.fps === "number" &&
          typeof msg.bitrate === "number" &&
          typeof msg.tier === "number" &&
          typeof msg.totalTiers === "number" &&
          (msg.direction === "downshift" || msg.direction === "upshift")
        ) {
          send({
            type: "device_stream_profile_event",
            sessionId,
            width: msg.width,
            height: msg.height,
            fps: msg.fps,
            bitrate: msg.bitrate,
            tier: msg.tier,
            totalTiers: msg.totalTiers,
            direction: msg.direction,
          });
        }
        break;
    }
  }

  /** Send a JSON message to the sidecar. */
  private sendToSidecar(msg: Record<string, unknown>): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.warn("[DeviceBridge] Cannot send: WebSocket not connected");
      return;
    }
    this.ws.send(JSON.stringify(msg));
  }

  // =========================================================================
  // Public API: Called by relay message router
  // =========================================================================

  /** Register a client's send function for a streaming session. */
  registerClientSender(sessionId: string, send: ClientSendFn): void {
    this.clientSenders.set(sessionId, send);
  }

  /** Unregister a client sender (on disconnect). */
  unregisterClientSender(sessionId: string): void {
    this.clientSenders.delete(sessionId);
  }

  /** Start streaming a device to a client. */
  async startStream(msg: DeviceStreamStart, send: ClientSendFn): Promise<void> {
    if (this.needsAndroidServerAPK(msg.deviceId, msg.deviceType)) {
      await this.ensureAndroidServerAPK();
    }
    await this.ensureStarted();
    this.registerClientSender(msg.sessionId, send);

    this.sendToSidecar({
      type: "session.start",
      sessionId: msg.sessionId,
      deviceId: msg.deviceId,
      deviceType: msg.deviceType,
      options: msg.options,
    });
  }

  /** Stop streaming. */
  stopStream(msg: DeviceStreamStop): void {
    this.unregisterClientSender(msg.sessionId);
    this.sendToSidecar({
      type: "session.stop",
      sessionId: msg.sessionId,
    });
  }

  /** Forward SDP answer from client to sidecar. */
  handleAnswer(msg: DeviceWebRTCAnswer): void {
    this.sendToSidecar({
      type: "webrtc.answer",
      sessionId: msg.sessionId,
      sdp: msg.sdp,
    });
  }

  /** Forward ICE candidate from client to sidecar. */
  handleICE(msg: DeviceICECandidate): void {
    this.sendToSidecar({
      type: "webrtc.ice",
      sessionId: msg.sessionId,
      candidate: msg.candidate,
    });
  }

  // =========================================================================
  // REST API proxies
  // =========================================================================

  /** Fetch a sidecar REST endpoint. */
  private async fetchSidecar(
    endpoint: string,
    init?: RequestInit,
  ): Promise<Response> {
    const url = `http://127.0.0.1:${this.port}${endpoint}`;
    return fetch(url, init);
  }

  /** List devices via sidecar REST API. */
  async listDevices(): Promise<DeviceInfo[]> {
    await this.ensureStarted();
    const resp = await this.fetchSidecar("/devices");
    if (!resp.ok) {
      throw new Error(`Sidecar error: ${resp.status}`);
    }
    return resp.json();
  }

  /** Get device screenshot via sidecar REST API. */
  async getScreenshot(deviceId: string): Promise<Buffer> {
    await this.ensureStarted();
    const resp = await this.fetchSidecar(`/devices/${deviceId}/screenshot`);
    if (!resp.ok) {
      throw new Error(`Screenshot error: ${resp.status}`);
    }
    return Buffer.from(await resp.arrayBuffer());
  }

  /** Start a device via sidecar REST API. */
  async startDevice(deviceId: string): Promise<void> {
    await this.ensureStarted();
    const resp = await this.fetchSidecar(`/devices/${deviceId}/start`, {
      method: "POST",
    });
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Start error: ${text}`);
    }
  }

  /** Stop a device via sidecar REST API. */
  async stopDevice(deviceId: string): Promise<void> {
    await this.ensureStarted();
    const resp = await this.fetchSidecar(`/devices/${deviceId}/stop`, {
      method: "POST",
    });
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Stop error: ${text}`);
    }
  }

  // =========================================================================
  // Lifecycle
  // =========================================================================

  private cleanup(): void {
    this.available = false;
    this.ws?.close();
    this.ws = null;
    this.port = null;
    this.activeBinaryPath = null;
    this.runningBridgeVersion = null;
    this.clientSenders.clear();
  }

  private scheduleRestart(): void {
    if (this.restartAttempts >= this.maxRestartAttempts) {
      console.error(
        `[DeviceBridge] Max restart attempts (${this.maxRestartAttempts}) reached, giving up`,
      );
      return;
    }

    const delay = Math.min(1000 * 2 ** this.restartAttempts, 30000);
    this.restartAttempts++;
    console.log(
      `[DeviceBridge] Restarting in ${delay}ms (attempt ${this.restartAttempts})`,
    );

    this.restartTimer = setTimeout(() => {
      this.start().catch((err) => {
        console.error("[DeviceBridge] Restart failed:", err.message);
      });
    }, delay);
  }

  /** Graceful shutdown. */
  async shutdown(): Promise<void> {
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }

    // Try to ask the sidecar to shut down cleanly.
    if (this.port) {
      try {
        await fetch(`http://127.0.0.1:${this.port}/shutdown`, {
          method: "POST",
          signal: AbortSignal.timeout(2000),
        });
      } catch {
        // Sidecar might already be dead.
      }
    }

    // Kill the child process.
    if (this.process && !this.process.killed) {
      this.process.kill("SIGTERM");
    }

    this.cleanup();
    this.process = null;
  }
}
