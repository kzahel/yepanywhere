import { PassThrough } from "node:stream";
import { expect, it } from "vitest";
// @ts-expect-error The host ledger intentionally runs as plain ESM.
import { ProviderRuntimeTurnLedger } from "../../../../../scripts/provider-runtime-turns.mjs";
import { ProviderSessionOwner } from "../../../src/sdk/providers/provider-session-owner.js";
import { startFakeProviderSession } from "./provider-runtime-fake.js";

it("queues two receipt-keyed turns behind busy provider work without steering or merging", async () => {
  let ledger: InstanceType<typeof ProviderRuntimeTurnLedger>;
  const records: Record<string, unknown>[] = [];
  const receipts: Record<string, unknown>[][] = [];
  const owner = new ProviderSessionOwner({
    runtimeId: "runtime",
    emitSupervisor: (message) => ledger.handleWorkerMessage(runtime, message),
  });
  const runtime = {
    runtimeId: "runtime",
    harness: "codex",
    providerSessionId: "target",
    child: {
      connected: true,
      send: (message: unknown) => owner.handleSupervisorMessage(message),
    },
  };
  ledger = new ProviderRuntimeTurnLedger({
    resolveRuntime: async () => runtime,
    writeReceipts: (rows: Record<string, unknown>[]) => receipts.push(rows),
  });
  await owner.start(async (hooks) => ({
    session: await startFakeProviderSession({}, hooks),
  }));
  owner.attach("controller", "generation", () => {});
  owner.begin();
  const send = async (submissionId: string, eventual: boolean) => {
    const socket = new PassThrough();
    socket.on("data", (data) => records.push(JSON.parse(data.toString())));
    await ledger.open(
      {
        id: submissionId,
        submissionId,
        target: { harness: "codex", providerSessionId: "target" },
        message: { text: submissionId },
        eventual,
      },
      socket,
    );
  };
  try {
    await owner.handleControllerRequest("controller", {
      type: "queuePush",
      message: { text: "hold" },
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    await send("immediate", false);
    expect(records.find((row) => row.id === "immediate")).toMatchObject({
      type: "error",
      outcome: "busy",
      accepted: false,
    });
    await send("first", true);
    await send("second", true);
    await send("first", true);
    expect(ledger.status("first")).toMatchObject({
      accepted: true,
      delivery: "queued",
    });
    expect(receipts.at(-1)?.filter((row) => row.accepted)).toHaveLength(2);
    expect(records.some((row) => row.type === "started")).toBe(false);
    await send("cancelled", true);
    expect(ledger.interrupt("cancelled").requested).toBe(true);
    expect(ledger.status("cancelled")).toMatchObject({
      delivery: "queued",
      outcome: "interrupted",
    });
    expect(records.some((row) => row.type === "started")).toBe(false);
    await owner.handleControllerRequest("controller", {
      type: "rpc",
      id: 1,
      method: "interrupt",
      args: [],
    });
    await expect.poll(() => ledger.status("second").state).toBe("terminal");
    for (const id of ["first", "second"]) {
      expect(ledger.status(id)).toMatchObject({
        accepted: true,
        delivery: "started",
        outcome: "completed",
      });
    }
    const events = records.filter(
      (row) => row.type === "providerEvent" && row.id === "second",
    );
    expect(JSON.stringify(events)).toContain("echo:second");
    expect(JSON.stringify(events)).not.toContain("echo:first");
    await owner.handleControllerRequest("controller", {
      type: "queuePush",
      message: { text: "hold" },
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    await send("doomed", true);
    await owner.shutdown("recipient died");
    expect(ledger.status("doomed")).toMatchObject({
      accepted: true,
      delivery: "queued",
      outcome: "not-alive",
    });
    await send("dead", true);
    expect(ledger.status("dead")).toMatchObject({
      accepted: false,
      outcome: "not-alive",
    });
  } finally {
    ledger.shutdown();
    await owner.shutdown("test cleanup");
  }
});
