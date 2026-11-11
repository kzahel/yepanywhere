import { useLayoutEffect, useRef } from "react";
import { attachSpeechWaveformRenderer } from "../lib/speechWaveform";
import styles from "./SpeechWaveform.module.css";

const SILENCE_DB = -80;
const CLIP_PEAK = 0.8;
const CLIP_DB = 20 * Math.log10(CLIP_PEAK);
const PREVIEW_ENVELOPE = [
  0.07, 0.09, 0.12, 0.18, 0.27, 0.39, 0.47, 0.4, 0.32, 0.23, 0.16, 0.11, 0.08,
  0.07, 0.09, 0.13, 0.21, 0.34, 0.5, 0.63, 0.54, 0.43, 0.51, 0.37, 0.25, 0.16,
  0.11, 0.08, 0.07, 0.09, 0.14, 0.22, 0.33, 0.45, 0.56, 0.49, 0.38, 0.29, 0.2,
  0.14, 0.1, 0.08, 0.07, 0.09, 0.13, 0.2, 0.31, 0.45, 0.58, 0.68, 0.55, 0.44,
  0.35, 0.27, 0.2, 0.14, 0.1, 0.08,
] as const;

function peakForHeightRatio(heightRatio: number): number {
  const decibels = SILENCE_DB + heightRatio * (CLIP_DB - SILENCE_DB);
  return 10 ** (decibels / 20);
}

const PREVIEW_SAMPLES = Float32Array.from(
  PREVIEW_ENVELOPE,
  (heightRatio, index) =>
    peakForHeightRatio(heightRatio) * (index % 2 === 0 ? 1 : -1),
);

interface WaveformColors {
  center: string;
  shoulder: string;
  peak: string;
}

function createWaveformGradient(
  context: CanvasRenderingContext2D,
  height: number,
  colors: WaveformColors,
): CanvasGradient {
  const gradient = context.createLinearGradient(0, 0, 0, height);
  gradient.addColorStop(0, colors.peak);
  gradient.addColorStop(0.32, colors.shoulder);
  gradient.addColorStop(0.5, colors.center);
  gradient.addColorStop(0.68, colors.shoulder);
  gradient.addColorStop(1, colors.peak);
  return gradient;
}

function normalizedAmplitude(peak: number): number {
  if (peak <= 0) return 0;
  const decibels = 20 * Math.log10(Math.min(CLIP_PEAK, peak));
  return Math.min(
    1,
    Math.max(0, (decibels - SILENCE_DB) / (CLIP_DB - SILENCE_DB)),
  );
}

function peakForColumn(
  samples: Float32Array,
  sampleCount: number,
  column: number,
  columnCount: number,
): number {
  if (sampleCount === 0) return 0;
  const start = Math.floor((column * sampleCount) / columnCount);
  const end = Math.max(
    start + 1,
    Math.floor(((column + 1) * sampleCount) / columnCount),
  );
  let peak = 0;
  for (let index = start; index < Math.min(end, sampleCount); index += 1) {
    peak = Math.max(peak, Math.abs(samples[index] ?? 0));
  }
  return normalizedAmplitude(peak);
}

function drawWaveform(
  canvas: HTMLCanvasElement,
  context: CanvasRenderingContext2D,
  samples: Float32Array,
  sampleCount: number,
  halfHeights: Float32Array,
  width: number,
  height: number,
  colors: WaveformColors,
): void {
  if (width === 0 || height === 0) return;

  const deviceScale = Math.max(1, window.devicePixelRatio || 1);
  const backingWidth = Math.max(1, Math.round(width * deviceScale));
  const backingHeight = Math.max(1, Math.round(height * deviceScale));
  const resized =
    canvas.width !== backingWidth || canvas.height !== backingHeight;
  if (resized) {
    canvas.width = backingWidth;
    canvas.height = backingHeight;
  }
  context.setTransform(deviceScale, 0, 0, deviceScale, 0, 0);
  if (resized || typeof context.fillStyle === "string") {
    context.fillStyle = createWaveformGradient(context, height, colors);
  }
  context.clearRect(0, 0, width, height);
  if (sampleCount === 0) return;

  const columnCount = Math.max(1, Math.ceil(width));
  const midpoint = height / 2;
  for (let column = 0; column <= columnCount; column += 1) {
    const sampleColumn = Math.min(column, columnCount - 1);
    halfHeights[column] = Math.max(
      1,
      peakForColumn(samples, sampleCount, sampleColumn, columnCount) * midpoint,
    );
  }

  context.beginPath();
  context.moveTo(0, midpoint - (halfHeights[0] ?? 1));
  for (let column = 1; column <= columnCount; column += 1) {
    const x = Math.min(width, column);
    context.lineTo(x, midpoint - (halfHeights[column] ?? 1));
  }
  for (let column = columnCount; column >= 0; column -= 1) {
    const x = Math.min(width, column);
    context.lineTo(x, midpoint + (halfHeights[column] ?? 1));
  }
  context.closePath();
  context.fill();
}

export function SpeechWaveform({ preview = false }: { preview?: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;

    let halfHeights = new Float32Array(0);
    const computedStyle = getComputedStyle(canvas);
    const fallbackColor = computedStyle.color;
    const colors = {
      center:
        computedStyle
          .getPropertyValue("--speech-waveform-center-color")
          .trim() || fallbackColor,
      shoulder:
        computedStyle
          .getPropertyValue("--speech-waveform-shoulder-color")
          .trim() || fallbackColor,
      peak:
        computedStyle.getPropertyValue("--speech-waveform-peak-color").trim() ||
        fallbackColor,
    };
    const render = (samples: Float32Array, sampleCount: number) => {
      const bounds = canvas.getBoundingClientRect();
      const width = Math.max(0, bounds.width);
      const height = Math.max(0, bounds.height);
      const requiredColumns = Math.max(1, Math.ceil(width)) + 1;
      if (halfHeights.length < requiredColumns) {
        halfHeights = new Float32Array(requiredColumns);
      }
      drawWaveform(
        canvas,
        context,
        samples,
        sampleCount,
        halfHeights,
        width,
        height,
        colors,
      );
    };
    if (preview) {
      render(PREVIEW_SAMPLES, PREVIEW_SAMPLES.length);
      const resizeObserver =
        typeof ResizeObserver === "undefined"
          ? null
          : new ResizeObserver(() =>
              render(PREVIEW_SAMPLES, PREVIEW_SAMPLES.length),
            );
      resizeObserver?.observe(canvas);
      return () => resizeObserver?.disconnect();
    }
    const detachRenderer = attachSpeechWaveformRenderer(render);
    return detachRenderer;
  }, [preview]);

  return (
    <div
      className={styles.waveform}
      data-composer-speech-waveform=""
      data-composer-elastic="true"
      data-speech-waveform="true"
      aria-hidden="true"
    >
      <canvas ref={canvasRef} className={styles.canvas} />
    </div>
  );
}
