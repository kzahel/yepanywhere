import { describe, expect, it } from "vitest";
import {
  nativeSessionViewerUrl,
  readSessionViewerPath,
  sessionViewerResourceHref,
} from "../sessionViewerUrl";

const base = "/remote/-/relay/host/projects/P/sessions";

describe("session viewer URLs", () => {
  it("moves to the native path and keeps resolving the YA session", () => {
    // Unknown until this client replaced the URL or asked the server.
    expect(readSessionViewerPath(`${base}/codex/n1`, "")).toMatchObject({
      projectId: "P",
      sessionId: undefined,
      native: { family: "codex", id: "n1" },
    });
    expect(
      nativeSessionViewerUrl(`${base}/ya1`, "?x=1", "#h", "ya1", "n1", "codex"),
    ).toBe(`${base}/codex/n1?x=1#h`);
    expect(readSessionViewerPath(`${base}/codex/n1`, "")).toMatchObject({
      sessionId: "ya1",
      resourcePathname: `${base}/ya1`,
    });
    expect(sessionViewerResourceHref(`https://h${base}/codex/n1?x=1`)).toBe(
      `https://h${base}/ya1?x=1`,
    );
    // Already shown: nothing to replace.
    expect(
      nativeSessionViewerUrl(`${base}/codex/n1`, "", "", "ya1", "n1", "codex"),
    ).toBeUndefined();
  });

  it("upgrades the legacy query form and keeps it for older servers", () => {
    const legacy = `${base}/n2`;
    expect(nativeSessionViewerUrl(`${base}/ya2`, "", "", "ya2", "n2")).toBe(
      `${legacy}?yaSessionId=ya2`,
    );
    expect(
      nativeSessionViewerUrl(legacy, "?yaSessionId=ya2", "", "ya2", "n2"),
    ).toBeUndefined();
    expect(
      nativeSessionViewerUrl(legacy, "?yaSessionId=ya2", "", "ya2", "n2", "pi"),
    ).toBe(`${base}/pi/n2`);
  });

  it("leaves equal ids and other sessions' pages alone", () => {
    expect(
      nativeSessionViewerUrl(`${base}/same`, "", "", "same", "same", "claude"),
    ).toBeUndefined();
    expect(
      nativeSessionViewerUrl(`${base}/other`, "", "", "ya3", "n3", "codex"),
    ).toBeUndefined();
    expect(readSessionViewerPath(`${base}/ya1/agents`, "")).toBeNull();
  });
});
