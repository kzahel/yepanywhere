import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n";
import { ParagraphQuoteRail } from "../ParagraphQuoteRail";

/**
 * An intersection observer that keeps the part of the real contract this
 * component's cost depends on: observing a target queues an initial
 * observation for it, delivered on a later frame whether or not anything
 * changed. A double whose `observe` is a bare spy hides the loop entirely.
 */
class QueueingIntersectionObserverMock {
  static instances: QueueingIntersectionObserverMock[] = [];
  readonly observed: Element[] = [];
  readonly callback: IntersectionObserverCallback;
  private queued: Element[] = [];
  private lastDelivered = new Map<Element, boolean>();

  constructor(callback: IntersectionObserverCallback) {
    this.callback = callback;
    QueueingIntersectionObserverMock.instances.push(this);
  }

  observe = (target: Element) => {
    this.observed.push(target);
    this.queued.push(target);
    this.lastDelivered.delete(target);
  };

  unobserve = (target: Element) => {
    const index = this.observed.indexOf(target);
    if (index >= 0) this.observed.splice(index, 1);
    this.lastDelivered.delete(target);
  };

  disconnect = () => {
    this.observed.length = 0;
    this.queued.length = 0;
    this.lastDelivered.clear();
  };

  /**
   * Deliver what the browser would deliver on the next frame: the initial
   * observation for every newly observed target, plus every observed target
   * whose intersection actually changed. A target that was already observed
   * and did not change is delivered nothing, which is the property the rail
   * has to rely on to go quiet.
   */
  deliverFrame(isIntersecting: (target: Element) => boolean): number {
    const due = new Set(this.queued);
    this.queued = [];
    for (const target of this.observed) {
      if (this.lastDelivered.get(target) !== isIntersecting(target)) {
        due.add(target);
      }
    }
    if (due.size === 0) return 0;
    const entries = [...due].map((target) => {
      const state = isIntersecting(target);
      this.lastDelivered.set(target, state);
      return { target, isIntersecting: state } as IntersectionObserverEntry;
    });
    this.callback(entries, this as unknown as IntersectionObserver);
    return entries.length;
  }
}

function Harness({
  html,
  paragraphQuoteCirclesEnabled = true,
}: {
  html?: string;
  paragraphQuoteCirclesEnabled?: boolean;
}) {
  const contentRef = useRef<HTMLDivElement>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  return (
    <div ref={surfaceRef} data-text-block>
      <ParagraphQuoteRail
        alwaysShowQuoteCircle={false}
        contentRef={contentRef}
        layoutKey="test"
        onQuoteBlock={() => {}}
        paragraphQuoteCirclesEnabled={paragraphQuoteCirclesEnabled}
        sourceRef={contentRef}
        surfaceRef={surfaceRef}
      />
      {html === undefined ? (
        <div ref={contentRef} data-text-block-content>
          <p>first paragraph</p>
          <p>second paragraph</p>
        </div>
      ) : (
        <div
          ref={contentRef}
          data-text-block-content
          // biome-ignore lint/security/noDangerouslySetInnerHtml: fixed test markup models Mermaid's generated SVG and retained source.
          dangerouslySetInnerHTML={{ __html: html }}
        />
      )}
    </div>
  );
}

function renderRail() {
  QueueingIntersectionObserverMock.instances.length = 0;
  vi.stubGlobal("IntersectionObserver", QueueingIntersectionObserverMock);
  render(
    <I18nProvider>
      <Harness />
    </I18nProvider>,
  );
  const observer = QueueingIntersectionObserverMock.instances[0];
  if (!observer) throw new Error("The rail did not create an observer");
  return observer;
}

describe("ParagraphQuoteRail", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("settles instead of re-arming while its block is off screen", () => {
    const observer = renderRail();
    const observesAfterMount = observer.observed.length;

    // Five frames in which the block never enters the scrollport. A rail that
    // reasserts parking re-observes its surface on every one of them, and each
    // re-observation schedules another measurement, so the page never idles.
    let deliveredAfterFirstFrame = 0;
    for (let frame = 0; frame < 5; frame++) {
      const delivered = observer.deliverFrame(() => false);
      if (frame > 0) deliveredAfterFirstFrame += delivered;
    }

    expect(observesAfterMount).toBe(1);
    expect(deliveredAfterFirstFrame).toBe(0);
  });

  it("observes its blocks when the block is on screen, and again after it returns", () => {
    const observer = renderRail();
    const surface = document.querySelector("[data-text-block]");
    if (!surface) throw new Error("Missing surface");

    observer.deliverFrame((target) => target === surface);
    // The surface plus both paragraphs.
    expect(observer.observed.length).toBe(3);

    // Scrolling away parks the rail back onto its surface alone.
    observer.deliverFrame(() => false);
    expect(observer.observed).toEqual([surface]);

    // Returning re-arms block observation rather than staying parked.
    observer.deliverFrame((target) => target === surface);
    expect(observer.observed.length).toBe(3);
  });

  const source =
    '<pre><code class="language-mermaid">graph TD\nA --> B</code></pre>';
  const diagram = `<div data-ya-code-block data-ya-code-view="rendered">
    <div data-ya-code-rendered><svg><foreignObject><div xmlns="http://www.w3.org/1999/xhtml"><p>Node A</p><p>Node B</p></div></foreignObject></svg></div>
    ${source}
  </div>`;

  function renderHtml(html: string, paragraphQuoteCirclesEnabled = true) {
    vi.stubGlobal("IntersectionObserver", undefined);
    return render(
      <I18nProvider>
        <Harness
          html={html}
          paragraphQuoteCirclesEnabled={paragraphQuoteCirclesEnabled}
        />
      </I18nProvider>,
    );
  }

  it.each([true, false])(
    "omits the rail for a diagram alone with paragraph mode %s",
    (paragraphMode) => {
      renderHtml(diagram, paragraphMode);
      expect(screen.queryByRole("button")).toBeNull();
    },
  );

  it("excludes diagram labels and retained source while keeping surrounding prose", async () => {
    renderHtml(
      `<p>Before</p>${diagram}<p>After</p><pre><code class="language-typescript">const value = 1;</code></pre>`,
    );
    await waitFor(() => {
      expect(
        document.querySelectorAll("[data-text-block-quote-paragraph]"),
      ).toHaveLength(3);
    });
    expect(
      document.querySelector("[data-text-block-quote-fallback]"),
    ).toBeNull();
  });

  it("excludes unrendered Mermaid source, including mixed-case language markers", () => {
    renderHtml(source.replace("language-mermaid", "language-Mermaid"));
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("keeps a delayed diagram excluded through source toggling and content replacement", async () => {
    renderHtml(source);
    const content = document.querySelector("[data-text-block-content]");
    if (!content) throw new Error("Missing content");
    content.innerHTML = diagram;
    await waitFor(() => expect(screen.queryByRole("button")).toBeNull());
    const block = content.querySelector<HTMLElement>("[data-ya-code-block]");
    if (!block) throw new Error("Missing diagram");
    block.dataset.yaCodeView = "source";
    expect(screen.queryByRole("button")).toBeNull();
    content.innerHTML = "<p>Now ordinary prose</p>";
    await waitFor(() => {
      expect(
        document.querySelectorAll("[data-text-block-quote-paragraph]"),
      ).toHaveLength(1);
    });
  });
});
