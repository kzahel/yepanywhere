import { createHash, randomUUID } from "node:crypto";
import type { ServerSettingsService } from "../services/ServerSettingsService.js";
import {
  COMPUTER_TOOLS,
  computerOperation,
  type ComputerSession,
  type ComputerToolResult,
} from "./contract.js";
import {
  managePreview,
  installedPreview,
  readComputerImage,
  startNative,
  type ComputerPreview,
  type NativeRuntime,
} from "./native.js";
import { callComputerPipe, ComputerDeliveryError } from "./pipe.js";

export interface ComputerSettings {
  enabled: boolean;
  preview?: ComputerPreview;
  idleMs: number;
  grantMs: number;
}
const defaults: ComputerSettings = {
  enabled: false,
  idleMs: 60_000,
  grantMs: 30 * 60_000,
};
interface Grant {
  calls: Set<string>;
  sessionId: string;
  expiresAt: number;
  generation?: string;
  references: Set<string>;
  windows: Set<number>;
}
export interface ComputerDependencies {
  platform?: string;
  start?: typeof startNative;
  call?: typeof callComputerPipe;
  image?: typeof readComputerImage;
  manage?: typeof managePreview;
  now?: () => number;
}

export class ComputerControlService {
  readonly instance: string;
  private readonly grants = new Set<Grant>();
  private runtime?: NativeRuntime;
  private busy = false;
  private stopping?: Promise<void>;
  private timer?: ReturnType<typeof setTimeout>;
  private idleAt = 0;
  private lastError?: string;
  private readonly unsubscribe: () => void;
  constructor(
    private readonly settings: ServerSettingsService,
    dataDir: string,
    private readonly deps: ComputerDependencies = {},
  ) {
    this.instance = `ya-${createHash("sha256").update(dataDir).digest("hex").slice(0, 20)}`;
    this.unsubscribe = settings.onSettingsChanged((next, previous) => {
      if (
        JSON.stringify(next.computerControl) !==
        JSON.stringify(previous.computerControl)
      ) {
        this.grants.clear();
        void this.stop().catch((error: unknown) => {
          this.lastError = String(error);
        });
      }
    });
  }
  private now() {
    return this.deps.now?.() ?? Date.now();
  }
  config(): ComputerSettings {
    return { ...defaults, ...this.settings.getSetting("computerControl") };
  }
  status() {
    return {
      ...this.config(),
      available:
        (this.deps.platform ?? process.platform) === "win32" &&
        !process.versions.bun,
      instance: this.instance,
      running: !!this.runtime,
      busy: this.busy,
      lastError: this.lastError,
      sessions: [...this.grants].map(({ sessionId, expiresAt }) => ({
        sessionId,
        expiresAt,
      })),
    };
  }
  async configure(value: ComputerSettings) {
    this.grants.clear();
    await this.settings.updateSettings({ computerControl: value });
    await this.stop();
    return this.status();
  }
  async install(preview: ComputerPreview) {
    this.assertPlatform();
    if (this.busy) throw new Error("Computer control is busy");
    this.busy = true;
    try {
      this.grants.clear();
      await this.settings.updateSettings({
        computerControl: { ...this.config(), enabled: false },
      });
      await this.stop();
      const result = await (this.deps.manage ?? managePreview)(
        preview,
        this.instance,
        "Install",
      );
      await this.settings.updateSettings({
        computerControl: {
          ...this.config(),
          enabled: false,
          preview: installedPreview(preview, this.instance, result.packageId),
        },
      });
      return result;
    } finally {
      this.busy = false;
    }
  }
  async uninstall() {
    this.assertPlatform();
    if (this.busy) throw new Error("Computer control is busy");
    this.busy = true;
    try {
      const preview = this.config().preview;
      this.grants.clear();
      await this.settings.updateSettings({
        computerControl: { ...this.config(), enabled: false },
      });
      await this.stop();
      if (preview)
        await (this.deps.manage ?? managePreview)(
          preview,
          this.instance,
          "Uninstall",
        );
      await this.settings.updateSettings({ computerControl: { ...defaults } });
    } finally {
      this.busy = false;
    }
  }
  private assertPlatform() {
    if (
      (this.deps.platform ?? process.platform) !== "win32" ||
      process.versions.bun
    )
      throw new Error(
        "Computer control requires Windows with the Node runtime",
      );
  }
  select(
    sessionId: string,
    selected: boolean | undefined,
    provider: string,
    executor?: string,
    sandbox?: string,
  ): ComputerSession | undefined {
    if (selected !== undefined && typeof selected !== "boolean")
      throw new Error("computerControl must be a boolean");
    if (!selected) return undefined;
    this.assertPlatform();
    if (provider !== "codex" || executor || (sandbox && sandbox !== "none"))
      throw new Error(
        "Computer control requires a local unsandboxed Codex session",
      );
    const config = this.config();
    if (!config.enabled || !config.preview)
      throw new Error(
        "Computer control is disabled or no authenticated preview is installed",
      );
    if (this.grants.size >= 32)
      throw new Error("Computer control session limit reached");
    const grant: Grant = {
      calls: new Set(),
      sessionId,
      expiresAt: this.now() + config.grantMs,
      references: new Set(),
      windows: new Set(),
    };
    this.grants.add(grant);
    this.schedule();
    return {
      tools: COMPUTER_TOOLS,
      call: (tool, args, callId) => this.execute(grant, tool, args, callId),
      acceptsThread: (threadId) => threadId === grant.sessionId,
      close: () => this.revokeGrant(grant),
      rename: (id) => {
        grant.sessionId = id;
      },
    };
  }
  async revoke(sessionId: string) {
    for (const grant of this.grants)
      if (grant.sessionId === sessionId) this.grants.delete(grant);
    if (!this.grants.size && !this.busy) await this.stop();
    this.schedule();
  }
  private async revokeGrant(grant: Grant) {
    this.grants.delete(grant);
    if (!this.grants.size && !this.busy) await this.stopAfterCall();
    this.schedule();
  }
  private authorized(grant: Grant) {
    return (
      this.grants.has(grant) &&
      grant.expiresAt > this.now() &&
      this.config().enabled
    );
  }
  private async execute(
    grant: Grant,
    tool: string,
    args: unknown,
    callId?: string,
  ): Promise<ComputerToolResult> {
    let acquired = false;
    let nativeResult: Record<string, unknown> | undefined;
    try {
      if (!this.authorized(grant))
        throw new Error("Computer control grant expired or revoked");
      if (callId) {
        if (grant.calls.has(callId) || grant.calls.size >= 2048)
          throw new Error(
            "Duplicate computer call or session operation limit exceeded; no replay",
          );
        grant.calls.add(callId);
      }
      if (tool !== "computer_control") throw new Error("Unknown computer tool");
      const request = computerOperation.parse(args);
      if (
        "expectedGeneration" in request &&
        request.expectedGeneration !== grant.generation
      )
        throw new Error("A fresh observation from this session is required");
      if ("reference" in request && !grant.references.has(request.reference))
        throw new Error("Unknown or expired session reference");
      if (
        "hwnd" in request &&
        request.hwnd &&
        request.operation !== "snapshot" &&
        request.operation !== "screenshot" &&
        !grant.windows.has(request.hwnd)
      )
        throw new Error("Unknown session window");
      if (this.busy)
        throw new Error(
          "Computer desktop is busy; no operation was dispatched",
        );
      this.busy = acquired = true;
      await this.stopping;
      if (!this.runtime)
        this.runtime = await (this.deps.start ?? startNative)(
          this.config().preview!,
          this.instance,
        );
      const runtime = this.runtime;
      if (!this.authorized(grant))
        throw new Error("Computer control grant revoked during startup");
      if (
        "expectedGeneration" in request &&
        request.expectedGeneration !== this.runtime.generation
      )
        throw new Error(
          "Resident generation changed; take a fresh observation",
        );
      this.runtime.activity();
      nativeResult = await (this.deps.call ?? callComputerPipe)(
        this.runtime.owner.pipe,
        { ...request, requestId: randomUUID() },
      );
      this.runtime?.activity();
      if (
        nativeResult.sessionId !== runtime.owner.sessionId ||
        nativeResult.generation !== runtime.generation
      )
        throw new ComputerDeliveryError(
          "Native session/generation response mismatch",
          "unknown",
        );
      if (!this.authorized(grant))
        return {
          success: false,
          contentItems: [
            {
              type: "inputText",
              text: JSON.stringify({
                ...nativeResult,
                data: undefined,
                message:
                  "Grant revoked while the native operation was in flight; observe effects independently",
              }),
            },
          ],
        };
      if (
        nativeResult.accepted &&
        ["windows", "snapshot", "screenshot"].includes(request.operation)
      ) {
        grant.generation = this.runtime.generation;
        if (request.operation === "snapshot") grant.references.clear();
        const collect = (value: unknown, depth = 0) => {
          if (depth > 20 || !value || typeof value !== "object") return;
          const record = value as Record<string, unknown>;
          for (const key of ["reference", "r"])
            if (
              request.operation === "snapshot" &&
              typeof record[key] === "string" &&
              grant.references.size < 1000
            )
              grant.references.add(record[key]);
          if (typeof record.hwnd === "number" && grant.windows.size < 1000)
            grant.windows.add(record.hwnd);
          for (const child of Object.values(record)) collect(child, depth + 1);
        };
        collect(nativeResult.data);
      }
      const contentItems: ComputerToolResult["contentItems"] = [
        { type: "inputText", text: JSON.stringify(nativeResult) },
      ];
      if (request.operation === "screenshot" && nativeResult.accepted)
        contentItems.push({
          type: "inputImage",
          imageUrl: await (this.deps.image ?? readComputerImage)(
            this.runtime.owner.artifactRoot,
            nativeResult.data as Record<string, unknown>,
          ),
        });
      if (!this.authorized(grant))
        throw new Error("Computer control grant revoked during artifact read");
      return { success: nativeResult.accepted === true, contentItems };
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      if (error instanceof ComputerDeliveryError && acquired)
        await this.stopAfterCall();
      const delivery =
        error instanceof ComputerDeliveryError
          ? error.delivery
          : nativeResult
            ? nativeResult.delivery
            : "refused";
      return {
        success: false,
        contentItems: [
          {
            type: "inputText",
            text: JSON.stringify({
              ...(nativeResult ?? {}),
              ...(!this.authorized(grant) ? { data: undefined } : {}),
              accepted: false,
              delivery,
              effect:
                nativeResult?.effect ??
                (delivery === "unknown" ? "unknown" : "refused"),
              uncertainty:
                nativeResult?.uncertainty ??
                (delivery === "unknown"
                  ? "Operation may have executed; never replay automatically"
                  : "none"),
              errorCode: "computer_control_refused",
              message: error instanceof Error ? error.message : String(error),
            }),
          },
        ],
      };
    } finally {
      if (acquired) {
        this.busy = false;
        this.idleAt = this.now() + this.config().idleMs;
        if (!this.grants.size || !this.config().enabled)
          await this.stopAfterCall();
        this.schedule();
      }
    }
  }
  private async stopAfterCall() {
    try {
      await this.stop();
    } catch (error) {
      this.lastError = `Owned runtime cleanup failed: ${String(error)}`;
    }
  }
  private schedule() {
    clearTimeout(this.timer);
    for (const grant of this.grants)
      if (grant.expiresAt <= this.now()) this.grants.delete(grant);
    const deadline = Math.min(
      ...[...this.grants].map((grant) => grant.expiresAt),
      ...(this.runtime ? [this.idleAt || this.now()] : []),
    );
    if (!Number.isFinite(deadline)) return;
    this.timer = setTimeout(
      () => {
        for (const grant of this.grants)
          if (grant.expiresAt <= this.now()) this.grants.delete(grant);
        if (!this.busy && (this.idleAt <= this.now() || !this.grants.size))
          void this.stop()
            .then(() => this.schedule())
            .catch((error: unknown) => {
              this.lastError = String(error);
            });
        else if (!this.busy) this.schedule();
      },
      Math.max(1, deadline - this.now()),
    );
    this.timer.unref();
  }
  async stop() {
    if (this.stopping) return this.stopping;
    if (!this.runtime) return;
    const runtime = this.runtime;
    this.runtime = undefined;
    for (const grant of this.grants) {
      grant.generation = undefined;
      grant.references.clear();
      grant.windows.clear();
    }
    this.stopping = runtime
      .stop()
      .catch((error: unknown) => {
        this.runtime = runtime;
        this.lastError = String(error);
        throw error;
      })
      .finally(() => {
        this.stopping = undefined;
      });
    return this.stopping;
  }
  async close() {
    this.unsubscribe();
    clearTimeout(this.timer);
    this.grants.clear();
    await this.stopAfterCall();
  }
}
