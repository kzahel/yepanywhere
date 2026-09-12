import { performance } from "node:perf_hooks";
import {
  readHostCapacity,
  readHostSample,
  summarizeHostWindow,
  assessHostEligibility,
} from "../../../scripts/perf-suite/host-profile.mjs";
import {
  prepareConversation,
  selectConversation,
  serializeConversationSnapshot,
} from "../src/experimental/conversation-projection.ts";
import { ConversationSubscriptions } from "../src/experimental/conversation-subscriptions.ts";

const capacity = await readHostCapacity();
const baselineStart = await readHostSample(capacity);
await new Promise((resolve) => setTimeout(resolve, 3000));
const baselineEnd = await readHostSample(capacity);
const baseline = summarizeHostWindow(capacity, baselineStart, baselineEnd);
const eligibility = assessHostEligibility(capacity, baseline, {
  maximumBaselineCpuBusyFraction: 0.8,
  maximumBaselineLoadPerEffectiveCpu: 2,
  maximumBaselineSwapGrowthMiB: 16,
  minimumEffectiveAvailableMemoryMiB: 1024,
  minimumEffectiveLogicalCpuCount: 2,
  minimumIdleLogicalCpuCount: 1,
});
const messages = Array.from({ length: 10 }, (_, i) => [
  { type: "user", uuid: `u${i}`, content: "Q".repeat(1024) },
  {
    type: "assistant",
    uuid: `a${i}`,
    content: [
      { type: "text", text: "A".repeat(1024) },
      {
        type: "tool_use",
        id: `tool${i}`,
        name: "Bash",
        input: { command: "echo test" },
      },
    ],
  },
  {
    type: "user",
    uuid: `result${i}`,
    content: [
      {
        type: "tool_result",
        tool_use_id: `tool${i}`,
        content: "completed",
        is_error: i % 3 === 0,
      },
    ],
  },
]).flat();
const input = {
  sessionId: "benchmark",
  messages,
  activity: "working",
  pendingRequests: [],
  sourceCoverage: { complete: true, earlierOutsideScope: "no" },
};
const query = {
  sessionId: input.sessionId,
  maxMessages: 20,
  anchorMessageId: null,
};
const results = [];
for (const consumers of [1, 10]) {
  const start = await readHostSample(capacity);
  const samples = [];
  let maximumSnapshotBytes = 0;
  for (let sample = 0; sample < 110; sample++) {
    const started = performance.now();
    const prepared = prepareConversation(input);
    if (prepared.kind !== "prepared")
      throw new Error("Benchmark input rejected");
    for (let consumer = 0; consumer < consumers; consumer++) {
      const snapshot = selectConversation(prepared, query, {
        subscriptionId: `consumer:${consumer}`,
        sequence: sample,
      });
      maximumSnapshotBytes = Math.max(
        maximumSnapshotBytes,
        Buffer.byteLength(serializeConversationSnapshot(snapshot)),
      );
    }
    if (sample >= 10) samples.push(performance.now() - started);
  }
  let reads = 0;
  let closes = 0;
  let deliveries = 0;
  const service = new ConversationSubscriptions(async () => ({
    read: async () => {
      reads++;
      return input;
    },
    close: () => {
      closes++;
    },
  }));
  const releases = [];
  const started = performance.now();
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      service.close();
      reject(new Error("Snapshot timeout"));
    }, 1000);
    for (let consumer = 0; consumer < consumers; consumer++)
      releases.push(
        service.subscribe(query, `consumer:${consumer}`, {
          send() {
            if (++deliveries === consumers) {
              clearTimeout(timeout);
              resolve();
            }
          },
          close() {},
        }),
      );
  });
  const initialDeliveryMs = performance.now() - started;
  for (const release of releases) release();
  service.close();
  const end = await readHostSample(capacity);
  samples.sort((a, b) => a - b);
  results.push({
    consumers,
    samples: samples.length,
    projectionAndEncodingP95Ms: samples[94],
    maximumSnapshotBytes,
    bytesPerConsumerSecondAtFiveUpdates: maximumSnapshotBytes * 5,
    sharedReads: reads,
    sourceCloses: closes,
    deliveries,
    initialDeliveryMs,
    hostWindow: summarizeHostWindow(capacity, start, end),
    start,
    end,
  });
}
console.log(
  JSON.stringify(
    {
      workload:
        "20 logical messages with 1 KiB prose each, compact activity/failure rows",
      host: { capacity, baselineStart, baselineEnd, baseline, eligibility },
      results,
    },
    null,
    2,
  ),
);
