/** Runs in Chromium. Measures event-loop/frame opportunities, not physical paint. */
export function installTranscriptProbe() {
  const fixture = window.__transcriptFixture;
  let active = false;
  let lastFrame = null;
  let raf;
  let timer;
  let observer;
  let rows = [];
  let pending = [];
  let frames = [];
  let longTasks = [];
  let keys = [];
  let expected = "";
  let input;
  let keydown;
  let inputHandler;
  const markers = [];
  function frame() {
    const now = performance.now();
    if (active && lastFrame !== null) frames.push(now - lastFrame);
    lastFrame = now;
    if (active) {
      for (const item of pending) {
        if (item.domAt !== undefined) continue;
        const node = document.querySelector(
          `[data-render-id="${CSS.escape(item.renderId)}"] [data-message-render-content]`,
        );
        const scroller = node?.closest("[data-session-messages]");
        if (!node || !scroller) continue;
        const clip = {
          top: 0,
          bottom: innerHeight,
          left: 0,
          right: innerWidth,
        };
        let hidden = false;
        for (let element = node; element; element = element.parentElement) {
          const style = getComputedStyle(element);
          if (
            style.visibility !== "visible" ||
            Number(style.opacity) === 0 ||
            style.display === "none"
          ) {
            hidden = true;
            break;
          }
          // HTML/body overflow propagates to the viewport. A fixed mobile
          // shell can leave their layout boxes at height 0 without clipping it.
          if (element === document.body || element === document.documentElement)
            continue;
          const bounds = element.getBoundingClientRect();
          if (
            element === scroller ||
            /hidden|clip|auto|scroll/.test(style.overflowY)
          ) {
            clip.top = Math.max(clip.top, bounds.top);
            clip.bottom = Math.min(clip.bottom, bounds.bottom);
          }
          if (
            element === scroller ||
            /hidden|clip|auto|scroll/.test(style.overflowX)
          ) {
            clip.left = Math.max(clip.left, bounds.left);
            clip.right = Math.min(clip.right, bounds.right);
          }
        }
        if (hidden || clip.bottom <= clip.top || clip.right <= clip.left)
          continue;
        const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
        for (let text = walker.nextNode(); text; text = walker.nextNode()) {
          const start = text.data.indexOf(item.marker);
          if (
            start < 0 ||
            /[a-z0-9-]/i.test(text.data[start - 1] ?? "") ||
            /[a-z0-9-]/i.test(text.data[start + item.marker.length] ?? "")
          )
            continue;
          const range = document.createRange();
          range.setStart(text, start);
          range.setEnd(text, start + item.marker.length);
          const box = range.getBoundingClientRect();
          if (
            box.width <= 0 ||
            box.height <= 0 ||
            box.bottom <= Math.max(0, clip.top) ||
            box.top >= Math.min(innerHeight, clip.bottom) ||
            box.right <= Math.max(0, clip.left) ||
            box.left >= Math.min(innerWidth, clip.right)
          )
            continue;
          item.domAt = performance.now();
          item.domLatencyMs = item.domAt - item.at;
          break;
        }
      }
      pending = pending.filter((item) => item.domAt === undefined);
    }
    raf = requestAnimationFrame(frame);
  }
  raf = requestAnimationFrame(frame);
  window.__transcriptProbe = {
    async calibrate() {
      const samples = [];
      let previous;
      for (let i = 0; i < 60; i++) {
        const now = await new Promise(requestAnimationFrame);
        if (previous !== undefined) samples.push(now - previous);
        previous = now;
      }
      return samples;
    },
    prepare(count) {
      rows = fixture.prepare(
        Array.from({ length: count }, (_, i) => `probe-${i}-end`),
      );
    },
    start({ count, intervalMs, stallMs = 0 }) {
      if (active || rows.length !== count)
        throw new Error("Unprepared/active probe");
      active = true;
      lastFrame = performance.now();
      frames = [];
      longTasks = [];
      keys = [];
      markers.length = 0;
      pending = [];
      input = document.querySelector("[data-composer-input]");
      if (input?.value !== "") throw new Error("Expected empty real composer");
      expected = "";
      keydown = (event) => {
        if (event.key.length !== 1) return;
        expected += event.key;
        const key = {
          expected,
          at: event.timeStamp,
          latencyMs: null,
          value: null,
          valueAtFrame: null,
        };
        keys.push(key);
        // Negative control delays the actual input event within its key task.
        if (stallMs && keys.length === 1) {
          const end = performance.now() + stallMs;
          while (performance.now() < end) {
            /* intentional negative control */
          }
        }
      };
      inputHandler = () => {
        const key = keys.at(-1);
        if (!key || key.latencyMs !== null) return;
        key.value = input.value;
        requestAnimationFrame(() => {
          key.latencyMs = performance.now() - key.at;
          key.valueAtFrame = input.value;
        });
      };
      input.addEventListener("keydown", keydown, true);
      input.addEventListener("input", inputHandler);
      observer = new PerformanceObserver((list) => {
        for (const item of list.getEntries())
          longTasks.push({ at: item.startTime, ms: item.duration });
      });
      observer.observe({ type: "longtask" });
      const start = performance.now();
      let index = 0;
      const send = () => {
        const scheduledAt = start + index * intervalMs;
        const marker = `probe-${index}-end`;
        const batch = rows[index];
        const renderId = `${batch.at(-1).uuid}-0`;
        const applied = fixture.append(batch);
        const item = {
          marker,
          renderId,
          scheduledAt,
          at: applied.at,
          latenessMs: Math.max(0, applied.at - scheduledAt),
        };
        markers.push(item);
        pending.push(item);
        index++;
        if (index < count)
          timer = setTimeout(
            send,
            Math.max(0, start + index * intervalMs - performance.now()),
          );
      };
      timer = setTimeout(send, 0);
    },
    finish() {
      active = false;
      clearTimeout(timer);
      for (const item of observer.takeRecords())
        longTasks.push({ at: item.startTime, ms: item.duration });
      observer.disconnect();
      input.removeEventListener("keydown", keydown, true);
      input.removeEventListener("input", inputHandler);
      return {
        frames,
        longTasks,
        keys,
        markers,
        pending: pending.length,
        inputValue: input.value,
        mountedRows: document.querySelectorAll("[data-message-render-row]")
          .length,
        snapshot: fixture.snapshot(),
      };
    },
    dispose() {
      clearTimeout(timer);
      cancelAnimationFrame(raf);
    },
  };
}
