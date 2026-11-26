import { afterEach, describe, expect, it, vi } from "vitest";
import { NativeSourceTransport } from "../../src/lib/transport/NativeSourceTransport";
import { NativeTransportFixture } from "../../src/lib/transport/__tests__/nativeTransportFixture";

let transport: NativeSourceTransport | undefined;
afterEach(() => {
  transport?.dispose();
  vi.useRealTimers();
});
async function setup() {
  const host = new NativeTransportFixture();
  transport = new NativeSourceTransport(host.channel);
  await transport.ready;
  await vi.waitFor(() =>
    expect(transport?.status.getSnapshot().state).toBe("ready"),
  );
  return { host, source: transport };
}

describe("native lifecycle: observed recovery contract", () => {
  it("keeps exhausted network recovery visibly reconnecting", async () => {
    const { host, source } = await setup();
    await host.emit({ type: "state", phase: "FAILED", recoverable: true });
    // Source transport contract: retry exhaustion is not terminal disconnect.
    expect(source.status.getSnapshot().state).toBe("reconnecting");
  });
});
