// Owned native RPC peer and JSONL history. No model or real credentials.
import { createInterface } from "node:readline";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";
const args = process.argv.slice(2);
if (args.includes("--version")) {
  console.log("1.4.0");
  process.exit(0);
}
const cwd = process.cwd(),
  root = join(process.env.PI_CODING_AGENT_DIR, "sessions");
const resumed = args.includes("--session");
const nativeId = resumed
  ? JSON.parse(
      readFileSync(args[args.indexOf("--session") + 1], "utf8").split("\n")[0],
    ).id
  : randomUUID();
const file = resumed
  ? args[args.indexOf("--session") + 1]
  : join(root, "--owned--", Date.now() + "_" + nativeId + ".jsonl");
const log = process.env.YEP_E2E_PI_REQUESTS,
  gate = process.env.YEP_E2E_PI_GATE;
const record = (row) => appendFileSync(log, JSON.stringify(row) + "\n");
const send = (row) => console.log(JSON.stringify(row));
const reply = (q, data, success = true) =>
  send({
    type: "response",
    id: q.id,
    command: q.type,
    success,
    ...(data === undefined ? {} : { data }),
    ...(!success ? { error: "Owned preflight refusal" } : {}),
  });
const header = {
  type: "session",
  version: 3,
  id: nativeId,
  cwd,
  timestamp: new Date().toISOString(),
};
let parent = resumed
  ? JSON.parse(readFileSync(file, "utf8").trim().split("\n").at(-1)).id
  : null;
const put = (role, text) => {
  if (!existsSync(file)) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(header) + "\n");
  }
  const id = randomUUID();
  appendFileSync(
    file,
    JSON.stringify({
      type: "message",
      id,
      parentId: parent,
      timestamp: new Date().toISOString(),
      message: { role, content: [{ type: "text", text }] },
    }) + "\n",
  );
  parent = id;
};
const ready = (suffix) =>
  new Promise((resolve) => {
    if (existsSync(gate + suffix)) return resolve();
    const t = setInterval(() => {
      if (existsSync(gate + suffix)) {
        clearInterval(t);
        resolve();
      }
    }, 10);
    t.unref();
  });
record({
  op: "launch",
  nativeId,
  file,
  resumed,
  noSession: args.includes("--no-session"),
  pid: process.pid,
});
createInterface({ input: process.stdin })
  .on("line", (line) => {
    void (async () => {
      const q = JSON.parse(line);
      record({ op: "request", type: q.type, message: q.message, nativeId });
      if (q.type === "get_available_models")
        return reply(q, {
          models: [{ provider: "owned", id: "fixture", name: "Owned Pi" }],
        });
      if (q.type === "get_state")
        return reply(q, {
          sessionId: nativeId,
          sessionFile:
            process.env.YEP_E2E_PI_OUTSIDE_FILE === "1"
              ? join(process.env.HOME, "outside.jsonl")
              : process.env.YEP_E2E_PI_LAYOUT === "root"
                ? join(root, nativeId + ".jsonl")
                : process.env.YEP_E2E_PI_LAYOUT === "deep"
                  ? join(root, "one", "two", nativeId + ".jsonl")
                  : file,
          isStreaming: false,
        });
      if (q.type !== "prompt") return reply(q);
      if (process.env.YEP_E2E_PI_REFUSE === "1")
        return reply(q, undefined, false);
      put("user", q.message);
      await ready(".ack");
      reply(q, { disposition: "started" });
      send({ type: "agent_start" });
      await ready(".reply");
      const answer = resumed
        ? "OWNED_PI_CONTINUED_REPLY"
        : "OWNED_PI_CREATION_REPLY";
      put("assistant", answer);
      send({ type: "message_start", message: { role: "assistant" } });
      send({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: answer },
      });
      send({ type: "agent_settled" });
    })().catch((e) => {
      console.error(e);
      process.exit(1);
    });
  })
  .on("close", () => process.exit(0));
