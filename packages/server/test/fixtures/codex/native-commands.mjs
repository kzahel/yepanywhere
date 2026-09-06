#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

if (process.argv[2] === "--version") {
  console.log("codex-cli 0.153.4");
  process.exit(0);
}

const logPath = join(dirname(fileURLToPath(import.meta.url)), "requests.jsonl");
let threadId = "compact-session";
let sequence = 0;
const send = (value) =>
  console.log(JSON.stringify({ jsonrpc: "2.0", ...value }));
const notify = (method, params) => send({ method, params });

for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  appendFileSync(logPath, `${JSON.stringify(request)}\n`);
  if (request.id === undefined) continue;
  const reply = (result) => send({ id: request.id, result });
  switch (request.method) {
    case "initialize":
      reply({ userAgent: "native-commands-fixture" });
      break;
    case "skills/list":
      reply({ data: [{ cwd: process.cwd(), skills: [], errors: [] }] });
      break;
    case "thread/goal/get":
      reply({ goal: null });
      break;
    case "thread/start":
    case "thread/resume":
      threadId = request.params.threadId ?? threadId;
      reply({
        thread: { id: threadId },
        model: "gpt-6-astra",
        reasoningEffort: "high",
      });
      break;
    case "thread/compact/start": {
      reply({});
      const turn = {
        id: `compact-${++sequence}`,
        status: "inProgress",
        items: [],
        error: null,
      };
      notify("turn/started", { threadId, turn });
      const item = { id: `boundary-${sequence}`, type: "contextCompaction" };
      notify("item/started", { threadId, turnId: turn.id, item });
      notify("item/completed", { threadId, turnId: turn.id, item });
      notify("turn/completed", {
        threadId,
        turn: { ...turn, status: "completed" },
      });
      break;
    }
    case "turn/start": {
      const turn = {
        id: `message-${++sequence}`,
        status: "inProgress",
        items: [],
        error: null,
      };
      reply({ turn });
      notify("turn/started", { threadId, turn });
      if (request.params.input?.some((item) => item.text === "hold")) break;
      notify("turn/completed", {
        threadId,
        turn: { ...turn, status: "completed" },
      });
      break;
    }
    default:
      reply({});
  }
}
