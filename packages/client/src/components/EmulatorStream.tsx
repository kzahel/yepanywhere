import type { DeviceType } from "@yep-anywhere/shared";
import { useCallback, useEffect, useRef } from "react";
import {
  ADAPTIVE_CHECK_INTERVAL_MS,
  ADAPTIVE_DEGRADED_FPS,
  ADAPTIVE_LOSS_THRESHOLD,
  ADAPTIVE_RECOVERY_SECONDS,
  type EmulatorFps,
} from "../hooks/useEmulatorSettings";

import styles from "./EmulatorStream.module.css";

interface EmulatorStreamProps {
  /** Remote MediaStream from WebRTC */
  stream: MediaStream | null;
  /** WebRTC DataChannel for sending touch/key events */
  dataChannel: RTCDataChannel | null;
  /** Device class being streamed (used for input behavior). */
  deviceType?: DeviceType;
  /** RTCPeerConnection for diagnostics */
  peerConnection: RTCPeerConnection | null;
  /** Whether to automatically reduce fps on packet loss */
  adaptiveFps?: boolean;
  /** The user-configured max fps — used to restore after recovery */
  configuredFps?: EmulatorFps;
}

/**
 * Compute the actual rendered video rect within the element,
 * accounting for `object-fit: contain` letterboxing.
 */
function getVideoRect(video: HTMLVideoElement): DOMRect {
  const elem = video.getBoundingClientRect();
  const videoW = video.videoWidth;
  const videoH = video.videoHeight;

  // Before video metadata loads, fall back to element rect
  if (!videoW || !videoH) return elem;

  const scale = Math.min(elem.width / videoW, elem.height / videoH);
  const renderW = videoW * scale;
  const renderH = videoH * scale;

  return new DOMRect(
    elem.left + (elem.width - renderW) / 2,
    elem.top + (elem.height - renderH) / 2,
    renderW,
    renderH,
  );
}

/** Clamp a value to [0, 1]. */
function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

function mapTouchToNormalized(
  clientX: number,
  clientY: number,
  rect: DOMRect,
): { x: number; y: number } | null {
  if (rect.width <= 0 || rect.height <= 0) return null;

  const x = (clientX - rect.left) / rect.width;
  const y = (clientY - rect.top) / rect.height;

  // Ignore touches outside the rendered video area.
  if (x < 0 || x > 1 || y < 0 || y > 1) return null;

  return { x: clamp01(x), y: clamp01(y) };
}

function mapReleaseToNormalized(
  clientX: number,
  clientY: number,
  rect: DOMRect,
): { x: number; y: number } | null {
  if (rect.width <= 0 || rect.height <= 0) return null;
  const x = (clientX - rect.left) / rect.width;
  const y = (clientY - rect.top) / rect.height;
  // For release events, clamp instead of dropping so the server can always
  // clear touch state even when the finger ends outside the video bounds.
  return { x: clamp01(x), y: clamp01(y) };
}

type KeyboardEventLike = Pick<
  KeyboardEvent,
  "key" | "code" | "isComposing" | "ctrlKey" | "metaKey" | "altKey"
>;

const KEY_BY_KEY: Readonly<Record<string, string>> = {
  Backspace: "KEYCODE_DEL",
  Delete: "KEYCODE_FORWARD_DEL",
  Enter: "KEYCODE_ENTER",
  Tab: "KEYCODE_TAB",
  Escape: "KEYCODE_ESCAPE",
  " ": "KEYCODE_SPACE",
  ArrowLeft: "KEYCODE_DPAD_LEFT",
  ArrowRight: "KEYCODE_DPAD_RIGHT",
  ArrowUp: "KEYCODE_DPAD_UP",
  ArrowDown: "KEYCODE_DPAD_DOWN",
  Home: "KEYCODE_MOVE_HOME",
  End: "KEYCODE_MOVE_END",
  PageUp: "KEYCODE_PAGE_UP",
  PageDown: "KEYCODE_PAGE_DOWN",
  Insert: "KEYCODE_INSERT",
  ".": "KEYCODE_PERIOD",
  ",": "KEYCODE_COMMA",
  "/": "KEYCODE_SLASH",
  "\\": "KEYCODE_BACKSLASH",
  "-": "KEYCODE_MINUS",
  "=": "KEYCODE_EQUALS",
  ";": "KEYCODE_SEMICOLON",
  "'": "KEYCODE_APOSTROPHE",
  "[": "KEYCODE_LEFT_BRACKET",
  "]": "KEYCODE_RIGHT_BRACKET",
  "`": "KEYCODE_GRAVE",
};

const KEY_BY_CODE: Readonly<Record<string, string>> = {
  Space: "KEYCODE_SPACE",
  Enter: "KEYCODE_ENTER",
  Tab: "KEYCODE_TAB",
  Escape: "KEYCODE_ESCAPE",
  Backspace: "KEYCODE_DEL",
  Delete: "KEYCODE_FORWARD_DEL",
  ArrowLeft: "KEYCODE_DPAD_LEFT",
  ArrowRight: "KEYCODE_DPAD_RIGHT",
  ArrowUp: "KEYCODE_DPAD_UP",
  ArrowDown: "KEYCODE_DPAD_DOWN",
  Home: "KEYCODE_MOVE_HOME",
  End: "KEYCODE_MOVE_END",
  PageUp: "KEYCODE_PAGE_UP",
  PageDown: "KEYCODE_PAGE_DOWN",
  Insert: "KEYCODE_INSERT",
  Period: "KEYCODE_PERIOD",
  Comma: "KEYCODE_COMMA",
  Slash: "KEYCODE_SLASH",
  Backslash: "KEYCODE_BACKSLASH",
  Minus: "KEYCODE_MINUS",
  Equal: "KEYCODE_EQUALS",
  Semicolon: "KEYCODE_SEMICOLON",
  Quote: "KEYCODE_APOSTROPHE",
  BracketLeft: "KEYCODE_LEFT_BRACKET",
  BracketRight: "KEYCODE_RIGHT_BRACKET",
  Backquote: "KEYCODE_GRAVE",
};

function supportsKeyboardInput(deviceType?: DeviceType): boolean {
  return (
    deviceType === "emulator" ||
    deviceType === "android" ||
    deviceType === "ios-simulator"
  );
}

export function mapKeyboardEventToAndroidKey(
  event: KeyboardEventLike,
): string | null {
  if (event.isComposing) return null;
  if (event.ctrlKey || event.metaKey || event.altKey) return null;

  // Preserve shifted printable output (e.g. "A", "!", "@") so the
  // Android device server can inject exact text.
  if (event.key.length === 1) {
    return event.key;
  }

  const fromKey = KEY_BY_KEY[event.key];
  if (fromKey) return fromKey;

  if (event.code.startsWith("Key") && event.code.length === 4) {
    return `KEYCODE_${event.code.slice(3).toUpperCase()}`;
  }
  if (event.code.startsWith("Digit") && event.code.length === 6) {
    return `KEYCODE_${event.code.slice(5)}`;
  }

  return KEY_BY_CODE[event.code] ?? null;
}

const EMULATOR_NAMED_KEYS = new Set([
  "Backspace",
  "Delete",
  "Enter",
  "Tab",
  "Escape",
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "ArrowDown",
  "Home",
  "End",
  "PageUp",
  "PageDown",
  "Insert",
]);

export function mapKeyboardEventToEmulatorKey(
  event: KeyboardEventLike,
): string | null {
  if (event.isComposing) return null;
  if (event.ctrlKey || event.metaKey || event.altKey) return null;

  let key = event.key;
  if (key === "Esc") key = "Escape";
  if (key === "Spacebar") key = " ";

  if (key === "" || key === "Dead" || key === "Unidentified") return null;
  if (key === "Shift" || key === "Control" || key === "Alt" || key === "Meta")
    return null;

  if (key.length === 1) return key;
  if (EMULATOR_NAMED_KEYS.has(key)) return key;
  if (/^F\d{1,2}$/.test(key)) return key;

  return null;
}

export function mapKeyboardEventToDeviceKey(
  event: KeyboardEventLike,
  deviceType?: DeviceType,
): string | null {
  if (deviceType === "emulator" || deviceType === "ios-simulator") {
    return mapKeyboardEventToEmulatorKey(event);
  }
  return mapKeyboardEventToAndroidKey(event);
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;

  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

/**
 * Video element for emulator stream with touch and mouse event capture.
 * Coordinates are normalized to 0.0-1.0, accounting for object-fit letterboxing.
 */
export function EmulatorStream({
  stream,
  dataChannel,
  deviceType,
  peerConnection,
  adaptiveFps = false,
  configuredFps = 30,
}: EmulatorStreamProps) {
  const videoRef = useRef<HTMLVideoElement>(null);

  // Attach stream to video element and monitor health
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.srcObject = stream;

    if (!stream) return;

    const tracks = stream.getVideoTracks();
    console.log(
      `[DeviceStream] attached stream: ${tracks.length} video track(s), active=${stream.active}`,
    );
    for (const t of tracks) {
      console.log(
        `[DeviceStream] track ${t.id}: readyState=${t.readyState} enabled=${t.enabled} muted=${t.muted}`,
      );
    }

    // Monitor video playback health — detect stale frames
    let lastTime = -1;
    let staleCount = 0;
    let lastPacketsReceived = 0;
    let lastBytesReceived = 0;
    const healthCheck = setInterval(async () => {
      const ct = video.currentTime;
      if (lastTime >= 0 && ct === lastTime && !video.paused) {
        staleCount++;

        // Query WebRTC stats to see if RTP packets are still arriving
        let statsInfo = "";
        if (peerConnection && peerConnection.connectionState !== "closed") {
          try {
            const stats = await peerConnection.getStats();
            for (const report of stats.values()) {
              if (report.type === "inbound-rtp" && report.kind === "video") {
                const pkts = report.packetsReceived ?? 0;
                const bytes = report.bytesReceived ?? 0;
                const lost = report.packetsLost ?? 0;
                const pktsDelta = pkts - lastPacketsReceived;
                const bytesDelta = bytes - lastBytesReceived;
                lastPacketsReceived = pkts;
                lastBytesReceived = bytes;
                statsInfo = ` rtp: +${pktsDelta}pkts/+${bytesDelta}bytes (total=${pkts}, lost=${lost})`;
              }
            }
          } catch {
            /* pc may be closing */
          }
        }

        if (staleCount === 1) {
          console.warn(
            `[DeviceStream] video stale: currentTime=${ct.toFixed(3)} not advancing${statsInfo}`,
          );
        } else if (staleCount % 6 === 0) {
          // Log every 30s (6 × 5s intervals)
          const track = stream.getVideoTracks()[0];
          console.warn(
            `[DeviceStream] video still stale (${staleCount * 5}s): currentTime=${ct.toFixed(3)}, track=${track?.readyState ?? "none"}, streamActive=${stream.active}${statsInfo}`,
          );
        } else {
          console.warn(
            `[DeviceStream] video stale (${staleCount * 5}s)${statsInfo}`,
          );
        }
      } else {
        if (staleCount > 0) {
          console.log(
            `[DeviceStream] video resumed after ${staleCount * 5}s stale`,
          );
        }
        staleCount = 0;
        // Track baseline RTP stats when healthy
        if (peerConnection && peerConnection.connectionState !== "closed") {
          try {
            const stats = await peerConnection.getStats();
            for (const report of stats.values()) {
              if (report.type === "inbound-rtp" && report.kind === "video") {
                lastPacketsReceived = report.packetsReceived ?? 0;
                lastBytesReceived = report.bytesReceived ?? 0;
              }
            }
          } catch {
            /* ignore */
          }
        }
      }
      lastTime = ct;
    }, 5000);

    // Monitor stream-level events
    const onRemoveTrack = (e: MediaStreamTrackEvent) => {
      console.warn(
        `[DeviceStream] stream removetrack: ${e.track.kind} ${e.track.id}`,
      );
    };
    const onInactive = () => {
      console.warn("[DeviceStream] stream became inactive");
    };
    stream.addEventListener("removetrack", onRemoveTrack);
    stream.addEventListener("inactive", onInactive);

    return () => {
      clearInterval(healthCheck);
      stream.removeEventListener("removetrack", onRemoveTrack);
      stream.removeEventListener("inactive", onInactive);
    };
  }, [stream, peerConnection]);

  // Adaptive fps: monitor packet loss and send fps_hint over DataChannel.
  useEffect(() => {
    if (!adaptiveFps || !peerConnection || !dataChannel) return;

    let lastPacketsReceived = 0;
    let lastPacketsLost = 0;
    let degradedSince: number | null = null;

    const interval = setInterval(async () => {
      if (
        peerConnection.connectionState === "closed" ||
        dataChannel.readyState !== "open"
      )
        return;

      let receivedDelta = 0;
      let lostDelta = 0;
      try {
        const stats = await peerConnection.getStats();
        for (const report of stats.values()) {
          if (report.type === "inbound-rtp" && report.kind === "video") {
            const pkts: number = report.packetsReceived ?? 0;
            const lost: number = report.packetsLost ?? 0;
            receivedDelta = pkts - lastPacketsReceived;
            lostDelta = Math.max(0, lost - lastPacketsLost);
            lastPacketsReceived = pkts;
            lastPacketsLost = lost;
          }
        }
      } catch {
        return; // pc may be closing
      }

      const total = receivedDelta + lostDelta;
      const lossRate = total > 0 ? lostDelta / total : 0;

      if (lossRate > ADAPTIVE_LOSS_THRESHOLD) {
        if (!degradedSince) {
          // First bad interval — drop fps immediately.
          degradedSince = Date.now();
          dataChannel.send(
            JSON.stringify({ type: "fps_hint", fps: ADAPTIVE_DEGRADED_FPS }),
          );
          console.warn(
            `[DeviceStream] adaptive: loss rate ${(lossRate * 100).toFixed(1)}% > ${ADAPTIVE_LOSS_THRESHOLD * 100}%, dropping to ${ADAPTIVE_DEGRADED_FPS}fps`,
          );
        } else {
          // Still degraded — reset recovery clock.
          degradedSince = Date.now();
        }
      } else if (degradedSince !== null) {
        const lossFreeMs = Date.now() - degradedSince;
        if (lossFreeMs >= ADAPTIVE_RECOVERY_SECONDS * 1000) {
          degradedSince = null;
          dataChannel.send(
            JSON.stringify({ type: "fps_hint", fps: configuredFps }),
          );
          console.log(
            `[DeviceStream] adaptive: loss-free for ${ADAPTIVE_RECOVERY_SECONDS}s, restoring to ${configuredFps}fps`,
          );
        }
      }
    }, ADAPTIVE_CHECK_INTERVAL_MS);

    return () => clearInterval(interval);
  }, [adaptiveFps, peerConnection, dataChannel, configuredFps]);

  const canSend = useCallback(() => {
    return dataChannel && dataChannel.readyState === "open";
  }, [dataChannel]);

  const sendKey = useCallback(
    (key: string) => {
      if (!canSend() || !dataChannel) return;
      dataChannel.send(JSON.stringify({ type: "key", key }));
    },
    [canSend, dataChannel],
  );

  // Capture keyboard events globally while streaming an Android target so
  // hardware keyboards work without requiring explicit focus inside the video.
  useEffect(() => {
    if (!supportsKeyboardInput(deviceType)) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (!canSend() || !dataChannel) return;
      if (isEditableTarget(event.target)) return;

      const key = mapKeyboardEventToDeviceKey(event, deviceType);
      if (!key) return;

      event.preventDefault();
      sendKey(key);
    };

    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [canSend, dataChannel, deviceType, sendKey]);

  const sendTouches = useCallback(
    (
      touches: Array<{
        clientX: number;
        clientY: number;
        id: number;
        pressure: number;
      }>,
      video: HTMLVideoElement,
    ) => {
      if (!canSend() || !dataChannel) return;
      const rect = getVideoRect(video);
      const mapped = touches
        .map((t) => {
          const normalized =
            t.pressure <= 0
              ? mapReleaseToNormalized(t.clientX, t.clientY, rect)
              : mapTouchToNormalized(t.clientX, t.clientY, rect);
          if (!normalized) return null;
          return {
            x: normalized.x,
            y: normalized.y,
            pressure: t.pressure,
            id: t.id,
          };
        })
        .filter((t): t is NonNullable<typeof t> => t !== null);
      if (mapped.length === 0) return;
      dataChannel.send(JSON.stringify({ type: "touch", touches: mapped }));
    },
    [canSend, dataChannel],
  );

  // --- Touch handlers (native, non-passive to allow preventDefault) ---

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const handleTouchStart = (e: TouchEvent) => {
      e.preventDefault();
      sendTouches(
        Array.from(e.touches).map((t) => ({
          clientX: t.clientX,
          clientY: t.clientY,
          id: t.identifier,
          pressure: t.force || 0.5,
        })),
        video,
      );
    };

    const handleTouchMove = (e: TouchEvent) => {
      e.preventDefault();
      sendTouches(
        Array.from(e.touches).map((t) => ({
          clientX: t.clientX,
          clientY: t.clientY,
          id: t.identifier,
          pressure: t.force || 0.5,
        })),
        video,
      );
    };

    const handleTouchEnd = (e: TouchEvent) => {
      e.preventDefault();
      // On touchend, event.touches is empty — use changedTouches with pressure 0 (release)
      sendTouches(
        Array.from(e.changedTouches).map((t) => ({
          clientX: t.clientX,
          clientY: t.clientY,
          id: t.identifier,
          pressure: 0,
        })),
        video,
      );
    };

    const opts = { passive: false } as const;
    video.addEventListener("touchstart", handleTouchStart, opts);
    video.addEventListener("touchmove", handleTouchMove, opts);
    video.addEventListener("touchend", handleTouchEnd, opts);
    video.addEventListener("touchcancel", handleTouchEnd, opts);

    return () => {
      video.removeEventListener("touchstart", handleTouchStart);
      video.removeEventListener("touchmove", handleTouchMove);
      video.removeEventListener("touchend", handleTouchEnd);
      video.removeEventListener("touchcancel", handleTouchEnd);
    };
  }, [sendTouches]);

  // --- Mouse handlers (desktop fallback) ---

  const mouseDown = useRef(false);

  const handleMouseDown = useCallback(
    (e: React.MouseEvent<HTMLVideoElement>) => {
      e.preventDefault();
      mouseDown.current = true;
      sendTouches(
        [{ clientX: e.clientX, clientY: e.clientY, id: 0, pressure: 0.5 }],
        e.currentTarget,
      );
    },
    [sendTouches],
  );

  const handleMouseMove = useCallback(
    (e: React.MouseEvent<HTMLVideoElement>) => {
      if (!mouseDown.current) return;
      e.preventDefault();
      sendTouches(
        [{ clientX: e.clientX, clientY: e.clientY, id: 0, pressure: 0.5 }],
        e.currentTarget,
      );
    },
    [sendTouches],
  );

  const handleMouseUp = useCallback(
    (e: React.MouseEvent<HTMLVideoElement>) => {
      if (!mouseDown.current) return;
      mouseDown.current = false;
      e.preventDefault();
      sendTouches(
        [{ clientX: e.clientX, clientY: e.clientY, id: 0, pressure: 0 }],
        e.currentTarget,
      );
    },
    [sendTouches],
  );

  // Reset mouse state if pointer leaves the element
  const handleMouseLeave = useCallback(
    (e: React.MouseEvent<HTMLVideoElement>) => {
      if (!mouseDown.current) return;
      mouseDown.current = false;
      sendTouches(
        [{ clientX: e.clientX, clientY: e.clientY, id: 0, pressure: 0 }],
        e.currentTarget,
      );
    },
    [sendTouches],
  );

  return (
    <video
      ref={videoRef}
      className={styles.video}
      autoPlay
      playsInline
      muted
      tabIndex={0}
      aria-label="Device stream"
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseLeave}
    />
  );
}
