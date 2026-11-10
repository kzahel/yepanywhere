import { fetchJSON } from "../../api/client";
import { subscribeClientSummarySourceKey } from "../clientSummaryStore";
import { getSessionTranscriptMemoryStats } from "../sessionDetail/sessionDetailStore";
import { getSourceRuntimeRegistry } from "../sourceRuntime";
import { generateUUID } from "../uuid";
import {
  countEntries,
  deleteEntries,
  getAllEntries,
  openDatabase,
  putEntry,
} from "./idb";

export interface LogEntry {
  id?: number;
  timestamp: number;
  level: string;
  prefix: string;
  message: string;
  /**
   * Which browser tab wrote this entry. Every tab of one origin shares the
   * IndexedDB queue below, so a collected batch interleaves tabs and any tab
   * may post another's entries. Without this, two windows on one session and
   * one window flapping between rendered and empty look identical in the
   * collected log, which is the distinction a lock investigation turns on.
   */
  tabId?: string;
}

const DB_NAME = "yep-anywhere-client-logs";
const DB_VERSION = 2;
const STORE_NAME = "entries";
const MAX_ENTRIES = 2000;
const FLUSH_BATCH_SIZE = 500;
const FLUSH_DEBOUNCE_MS = 1000;
const TELEMETRY_INTERVAL_MS = 15_000;

const PREFIX_REGEX = /^\[([A-Za-z]+)\]/;
const DEVICE_ID_KEY = "yep-anywhere-device-id";
const TAB_ID_KEY = "yep-anywhere-tab-id";

function getDeviceId(): string | undefined {
  try {
    let id = localStorage.getItem(DEVICE_ID_KEY);
    if (!id) {
      id = generateUUID();
      localStorage.setItem(DEVICE_ID_KEY, id);
    }
    return id;
  } catch {
    return undefined;
  }
}

/**
 * Session storage is per tab and survives that tab's reloads, which is exactly
 * the identity a growth curve needs: one series per window, continuous across
 * a reload the reader performed.
 */
function getTabId(): string | undefined {
  try {
    let id = sessionStorage.getItem(TAB_ID_KEY);
    if (!id) {
      id = generateUUID();
      sessionStorage.setItem(TAB_ID_KEY, id);
    }
    return id;
  } catch {
    return undefined;
  }
}

export class ClientLogCollector {
  private _db: IDBDatabase | null = null;
  private _memoryBuffer: LogEntry[] = [];
  private _useMemoryFallback = false;
  private _started = false;
  private _flushing = false;
  private _deviceId: string | undefined;
  private _tabId: string | undefined;

  private _origLog: typeof console.log | null = null;
  private _origWarn: typeof console.warn | null = null;
  private _origError: typeof console.error | null = null;
  private _unsubscribeStatus: (() => void) | null = null;
  private _unsubscribeSourceKey: (() => void) | null = null;
  private _errorHandler: ((e: ErrorEvent) => void) | null = null;
  private _rejectionHandler: ((e: PromiseRejectionEvent) => void) | null = null;
  private _flushTimer: ReturnType<typeof setTimeout> | null = null;
  private _telemetryTimer: ReturnType<typeof setInterval> | null = null;

  async start(): Promise<void> {
    if (this._started) return;
    this._started = true;
    this._deviceId = getDeviceId();
    this._tabId = getTabId();

    try {
      const db = await openDatabase(DB_NAME, DB_VERSION, (db) => {
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, {
            keyPath: "id",
            autoIncrement: true,
          });
        }
      });
      if (!this._started) {
        db.close();
        return;
      }
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.close();
        throw new Error("Client log database is missing its entries store");
      }
      this._db = db;
    } catch {
      if (!this._started) return;
      this._useMemoryFallback = true;
    }

    this._wrapConsole();
    this._writeEntry(
      "info",
      "[ClientInfo]",
      `[ClientInfo] ${navigator.userAgent} | ${window.screen.width}x${window.screen.height} | dpr=${window.devicePixelRatio} | lang=${navigator.language}`,
    );
    this._writeTelemetryEntry();
    this._startTelemetry();

    this._subscribeCurrentTransportStatus();
    this._unsubscribeSourceKey = subscribeClientSummarySourceKey(() => {
      this._subscribeCurrentTransportStatus();
    });

    // Flush immediately if already connected (e.g. setting enabled mid-session)
    if (this._isCurrentTransportReady()) {
      this.flush();
    }
  }

  stop(): void {
    if (!this._started) return;
    this._started = false;

    this._restoreConsole();

    this._unsubscribeStatus?.();
    this._unsubscribeStatus = null;
    this._unsubscribeSourceKey?.();
    this._unsubscribeSourceKey = null;
    this._clearScheduledFlush();
    this._stopTelemetry();

    if (this._db) {
      this._db.close();
      this._db = null;
    }

    this._memoryBuffer = [];
    this._useMemoryFallback = false;
  }

  record(level: string, prefix: string, message: string): void {
    if (!this._started) return;
    this._writeEntry(level, prefix, message);
  }

  async flush(): Promise<void> {
    if (this._flushing) return;
    this._flushing = true;
    try {
      await this._doFlush();
    } catch {
      if (this._started) this._enableMemoryFallback();
    } finally {
      this._flushing = false;
    }
  }

  private async _doFlush(): Promise<void> {
    let entries: LogEntry[];

    if (this._useMemoryFallback || !this._db) {
      entries = this._memoryBuffer.splice(0, FLUSH_BATCH_SIZE);
      if (entries.length === 0) return;
    } else {
      entries = await getAllEntries<LogEntry>(
        this._db,
        STORE_NAME,
        FLUSH_BATCH_SIZE,
      );
      if (entries.length === 0) return;
    }

    try {
      await fetchJSON("/client-logs", {
        method: "POST",
        body: JSON.stringify({
          entries,
          deviceId: this._deviceId,
        }),
      });

      // Delete flushed entries from IDB
      if (!this._useMemoryFallback && this._db) {
        const keys = entries
          .map((e) => e.id)
          .filter((id): id is number => id != null);
        if (keys.length > 0) {
          await deleteEntries(this._db, STORE_NAME, keys);
        }
      }
    } catch {
      // If flush fails (e.g. not connected), put memory entries back
      if (this._useMemoryFallback) {
        this._memoryBuffer.unshift(...entries);
      }
    }
  }

  private _writeEntry(level: string, prefix: string, message: string): void {
    const entry: LogEntry = {
      timestamp: Date.now(),
      level,
      prefix,
      message,
      tabId: this._tabId,
    };

    if (this._useMemoryFallback || !this._db) {
      this._bufferEntry(entry);
      this._scheduleFlush();
      return;
    }

    void this._persistEntry(entry);
  }

  private async _persistEntry(entry: LogEntry): Promise<void> {
    try {
      if (!this._db) throw new Error("Client log database is unavailable");
      await putEntry(this._db, STORE_NAME, entry);
      await this._trimEntries();
      this._scheduleFlush();
    } catch {
      if (!this._started) return;
      this._enableMemoryFallback(entry);
      this._scheduleFlush();
    }
  }

  private _enableMemoryFallback(entry?: LogEntry): void {
    this._db?.close();
    this._db = null;
    this._useMemoryFallback = true;
    if (entry) this._bufferEntry(entry);
  }

  private _bufferEntry(entry: LogEntry): void {
    this._memoryBuffer.push(entry);
    if (this._memoryBuffer.length > MAX_ENTRIES) {
      this._memoryBuffer = this._memoryBuffer.slice(-MAX_ENTRIES);
    }
  }

  private _scheduleFlush(): void {
    if (!this._started || !this._isCurrentTransportReady()) return;
    if (this._flushTimer) return;
    this._flushTimer = setTimeout(() => {
      this._flushTimer = null;
      void this.flush();
    }, FLUSH_DEBOUNCE_MS);
  }

  private _clearScheduledFlush(): void {
    if (!this._flushTimer) return;
    clearTimeout(this._flushTimer);
    this._flushTimer = null;
  }

  private _startTelemetry(): void {
    this._stopTelemetry();
    this._telemetryTimer = setInterval(() => {
      this._writeTelemetryEntry();
    }, TELEMETRY_INTERVAL_MS);
  }

  private _stopTelemetry(): void {
    if (!this._telemetryTimer) return;
    clearInterval(this._telemetryTimer);
    this._telemetryTimer = null;
  }

  private _subscribeCurrentTransportStatus(): void {
    this._unsubscribeStatus?.();
    this._unsubscribeStatus = null;
    if (!this._started) return;

    const transport =
      getSourceRuntimeRegistry().getCurrentSourceRuntime().transport;
    this._unsubscribeStatus = transport.status.subscribe(() => {
      if (this._isCurrentTransportReady()) {
        this.flush();
      }
    });
  }

  private _isCurrentTransportReady(): boolean {
    return (
      getSourceRuntimeRegistry()
        .getCurrentSourceRuntime()
        .transport.status.getSnapshot().state === "ready"
    );
  }

  private _writeTelemetryEntry(): void {
    if (!this._started || typeof window === "undefined") return;
    const perf = window.performance as Performance & {
      memory?: {
        jsHeapSizeLimit?: number;
        totalJSHeapSize?: number;
        usedJSHeapSize?: number;
      };
    };
    const memory = perf.memory;
    const payload = {
      path: window.location.pathname,
      visibility:
        typeof document !== "undefined" ? document.visibilityState : "unknown",
      memory: memory
        ? {
            usedJSHeapSize: memory.usedJSHeapSize,
            totalJSHeapSize: memory.totalJSHeapSize,
            jsHeapSizeLimit: memory.jsHeapSizeLimit,
          }
        : null,
      dom:
        typeof document !== "undefined"
          ? {
              nodes: document.getElementsByTagName("*").length,
              messageRows: document.querySelectorAll(
                "[data-message-render-row]",
              ).length,
              streamingBlocks:
                document.querySelectorAll(".streaming-block").length,
              toolRows: document.querySelectorAll("[data-tool-row]").length,
            }
          : null,
      // Attributes multi-day heap growth to transcript-store retention vs
      // DOM/other without needing a live heap snapshot from the device.
      transcriptMemory: getSessionTranscriptMemoryStats(),
    };
    this._writeEntry(
      "info",
      "[ClientTelemetry]",
      `[ClientTelemetry] ${JSON.stringify(payload)}`,
    );
  }

  private async _trimEntries(): Promise<void> {
    if (!this._db) return;
    const count = await countEntries(this._db, STORE_NAME);
    if (count <= MAX_ENTRIES) return;

    // Get the oldest entries to delete
    const excess = count - MAX_ENTRIES;
    const oldest = await getAllEntries<LogEntry>(this._db, STORE_NAME, excess);
    const keys = oldest
      .map((e) => e.id)
      .filter((id): id is number => id != null);
    if (keys.length > 0) {
      await deleteEntries(this._db, STORE_NAME, keys);
    }
  }

  private _wrapConsole(): void {
    this._origLog = console.log;
    this._origWarn = console.warn;
    this._origError = console.error;

    console.log = (...args: unknown[]) => {
      this._capture("log", args);
      this._origLog?.apply(console, args);
    };
    console.warn = (...args: unknown[]) => {
      this._capture("warn", args);
      this._origWarn?.apply(console, args);
    };
    console.error = (...args: unknown[]) => {
      this._capture("error", args);
      this._origError?.apply(console, args);
    };

    // Capture unhandled exceptions and promise rejections
    this._errorHandler = (e: ErrorEvent) => {
      const msg =
        e.error instanceof Error
          ? (e.error.stack ?? e.error.message)
          : e.message;
      this._writeEntry("error", "[UncaughtError]", msg);
    };
    this._rejectionHandler = (e: PromiseRejectionEvent) => {
      const reason =
        e.reason instanceof Error
          ? (e.reason.stack ?? e.reason.message)
          : String(e.reason);
      this._writeEntry("error", "[UnhandledRejection]", reason);
    };
    window.addEventListener("error", this._errorHandler);
    window.addEventListener("unhandledrejection", this._rejectionHandler);
  }

  private _restoreConsole(): void {
    if (this._origLog) console.log = this._origLog;
    if (this._origWarn) console.warn = this._origWarn;
    if (this._origError) console.error = this._origError;
    this._origLog = null;
    this._origWarn = null;
    this._origError = null;

    if (this._errorHandler) {
      window.removeEventListener("error", this._errorHandler);
      this._errorHandler = null;
    }
    if (this._rejectionHandler) {
      window.removeEventListener("unhandledrejection", this._rejectionHandler);
      this._rejectionHandler = null;
    }
  }

  /** Capture all warn/error messages unconditionally */
  private _capture(level: string, args: unknown[]): void {
    if (args.length === 0) return;
    const message = args
      .map((a) =>
        typeof a === "string"
          ? a
          : a instanceof Error
            ? `${a.message}${a.stack ? `\n${a.stack}` : ""}`
            : JSON.stringify(a),
      )
      .join(" ");

    const first = args[0];
    const prefix =
      typeof first === "string" ? (PREFIX_REGEX.exec(first)?.[0] ?? "") : "";
    this._writeEntry(level, prefix, message);
  }
}
