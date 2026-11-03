#!/usr/bin/env node
import {
  appendFileSync,
  readFileSync,
  existsSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

if (process.argv[2] === "--version") {
  console.log("codex-cli 0.153.4");
  process.exit(0);
}

const logPath = join(dirname(fileURLToPath(import.meta.url)), "requests.jsonl");
let goal = JSON.parse(
  readFileSync(join(dirname(logPath), "goal.json"), "utf8"),
);
let threadId = "compact-session";
let sequence = 0;
const send = (value) =>
  console.log(JSON.stringify({ jsonrpc: "2.0", ...value }));
const notify = (method, params) => send({ method, params });

// Optional controlled interleavings for the real adapter integration test.
let heldTurn;
let heldCompact;
const controlled = () => existsSync(join(dirname(logPath), "hold-compaction"));
const control = createServer((req, res) => {
  if (req.url === "/turn/finish" && heldTurn) {
    notify("turn/completed", {
      threadId,
      turn: { ...heldTurn, status: "completed" },
    });
    heldTurn = undefined;
  } else if (req.url === "/compact/boundary" && heldCompact) {
    notify("item/completed", {
      threadId,
      turnId: heldCompact.id,
      item: { id: "controlled-boundary", type: "contextCompaction" },
    });
  } else if (req.url === "/compact/finish" && heldCompact) {
    notify("turn/completed", {
      threadId,
      turn: { ...heldCompact, status: "completed" },
    });
    heldCompact = undefined;
  } else if (req.url === "/compact/fail" && heldCompact) {
    notify("turn/completed", {
      threadId,
      turn: {
        ...heldCompact,
        status: "failed",
        error: { message: "Controlled compact failure" },
      },
    });
    heldCompact = undefined;
  } else {
    res.writeHead(409);
    res.end("No matching held operation");
    return;
  }
  res.end("ok");
});
await new Promise((resolve) => control.listen(0, "127.0.0.1", resolve));
control.unref();
writeFileSync(
  join(dirname(logPath), "control-port"),
  String(control.address().port),
);
process.stdin.on("end", () => control.close());

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
      reply({ goal });
      break;
    case "thread/goal/set":
      goal = { ...goal, ...request.params };
      reply({ goal });
      notify("thread/goal/updated", { threadId, goal });
      if (request.params.objective === "Work autonomously") {
        notify("turn/started", {
          threadId,
          turn: {
            id: "autonomous",
            status: "inProgress",
            items: [],
            error: null,
          },
        });
      }
      break;
    case "thread/start":
    case "thread/resume":
      threadId = request.params.threadId ?? threadId;
      reply({
        thread: { id: threadId },
        model: "gpt-6-astra",
        reasoningEffort: "high",
      });
      if (goal) notify("thread/goal/updated", { threadId, goal });
      break;
    case "thread/compact/start": {
      if (existsSync(join(dirname(logPath), "refuse-compaction"))) {
        send({
          id: request.id,
          error: { code: -32600, message: "Controlled compact refusal" },
        });
        break;
      }
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
      if (controlled()) {
        heldCompact = turn;
        break;
      }
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
      if (request.params.input?.some((item) => item.text === "hold")) {
        heldTurn = turn;
        break;
      }
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
