import { sanitizeSessionTitle } from "@yep-anywhere/shared";
import { getLogger } from "../logging/logger.js";
import type { SessionMetadataService } from "../metadata/SessionMetadataService.js";
import type { AgentProvider } from "../sdk/providers/types.js";
import type { EventBus } from "../watcher/EventBus.js";

const DEFAULT_REFRESH_INTERVAL_MS = 10_000;

type NativeTitleProvider = Required<
  Pick<
    AgentProvider,
    | "closeNativeSessionTitles"
    | "listNativeSessionTitles"
    | "onNativeSessionTitleChanged"
    | "setNativeSessionTitle"
  >
>;

export interface CodexNativeTitleServiceOptions {
  provider: NativeTitleProvider;
  metadataService: SessionMetadataService;
  eventBus?: EventBus;
  refreshIntervalMs?: number;
}

export class CodexNativeTitleService {
  private readonly provider: NativeTitleProvider;
  private readonly metadataService: SessionMetadataService;
  private readonly eventBus: EventBus | undefined;
  private readonly refreshIntervalMs: number;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private refreshPromise: Promise<void> | null = null;
  private unsubscribeProvider: (() => void) | null = null;
  private stopped = true;
  private refreshFailureReported = false;
  private projectionRevision = 0;

  constructor(options: CodexNativeTitleServiceOptions) {
    this.provider = options.provider;
    this.metadataService = options.metadataService;
    this.eventBus = options.eventBus;
    this.refreshIntervalMs = Math.max(
      1_000,
      options.refreshIntervalMs ?? DEFAULT_REFRESH_INTERVAL_MS,
    );
  }

  async start(): Promise<void> {
    if (!this.stopped) return;
    this.stopped = false;
    this.unsubscribeProvider = this.provider.onNativeSessionTitleChanged(
      (sessionId, title) => this.applyProviderTitle(sessionId, title),
    );
    void this.refresh()
      .catch(() => undefined)
      .finally(() => this.scheduleRefresh());
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
    this.unsubscribeProvider?.();
    this.unsubscribeProvider = null;
    await this.provider.closeNativeSessionTitles();
    await this.refreshPromise?.catch(() => undefined);
  }

  async rename(sessionId: string, rawTitle: string): Promise<void> {
    const title = sanitizeSessionTitle(rawTitle);
    if (!title) throw new Error("Codex thread name must not be empty");
    await this.provider.setNativeSessionTitle(sessionId, title);
    await this.metadataService.setTitle(sessionId, undefined);
    this.applyProviderTitle(sessionId, title);
  }

  async refresh(): Promise<void> {
    if (this.refreshPromise) return this.refreshPromise;
    const refresh = this.refreshOnce();
    this.refreshPromise = refresh;
    try {
      await refresh;
    } finally {
      if (this.refreshPromise === refresh) this.refreshPromise = null;
    }
  }

  private async refreshOnce(): Promise<void> {
    try {
      const revision = this.projectionRevision;
      const snapshot = await this.provider.listNativeSessionTitles();
      if (this.stopped || revision !== this.projectionRevision) return;
      const changes = snapshot.complete
        ? this.metadataService.replaceNativeTitles(snapshot.titles)
        : this.metadataService.mergeNativeTitles(snapshot.titles);
      for (const change of changes) {
        this.emitTitleChanged(change.sessionId, change.title);
      }
      if (!snapshot.complete) {
        getLogger().warn(
          {
            component: "codex-native-titles",
            titleCount: snapshot.titles.size,
          },
          "Codex native-title refresh reached its bounded thread limit",
        );
      }
      this.refreshFailureReported = false;
    } catch (error) {
      const log = this.refreshFailureReported
        ? getLogger().debug.bind(getLogger())
        : getLogger().warn.bind(getLogger());
      log(
        { component: "codex-native-titles", error },
        "Codex native-title refresh failed; retaining the last projection",
      );
      this.refreshFailureReported = true;
      throw error;
    }
  }

  private scheduleRefresh(): void {
    if (this.stopped || this.refreshTimer) return;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      void this.refresh()
        .catch(() => undefined)
        .finally(() => this.scheduleRefresh());
    }, this.refreshIntervalMs);
    this.refreshTimer.unref?.();
  }

  private applyProviderTitle(sessionId: string, title: string): void {
    const normalizedTitle = sanitizeSessionTitle(title);
    if (!normalizedTitle) return;
    this.projectionRevision += 1;
    if (!this.metadataService.setNativeTitle(sessionId, normalizedTitle))
      return;
    this.emitTitleChanged(sessionId, normalizedTitle);
  }

  private emitTitleChanged(sessionId: string, title: string): void {
    this.eventBus?.emit({
      type: "session-metadata-changed",
      sessionId,
      title,
      timestamp: new Date().toISOString(),
    });
  }
}
