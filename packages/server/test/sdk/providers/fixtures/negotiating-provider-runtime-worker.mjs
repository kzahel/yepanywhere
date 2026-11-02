import { writeFileSync } from "node:fs";
import { join } from "node:path";

const root = process.env.YA_LAUNCH_PROBE_ROOT;
const mode = process.env.YA_LAUNCH_PROBE_MODE;
process.on("message", (message) => {
  if (message?.type === "shutdown") process.exit(0);
});
process.on("disconnect", () => process.exit(0));
writeFileSync(join(root, "started"), String(process.pid));
if (mode === "early-ready") process.send({ type: "ready", metadata: {} });
else if (mode !== "old") {
  process.send({
    type: "launchHello",
    protocolVersion: 1,
    features: mode === "supported" ? ["test-launch"] : [],
  });
}

let input = "";
for await (const chunk of process.stdin) input += chunk;
writeFileSync(join(root, "effects"), input);
process.send({ type: "ready", metadata: { queueDepth: 0 } });
