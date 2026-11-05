// Controlled pinned app-server peer, with native on-disk history and explicit
// acknowledgement/reply barriers. No model traffic or inherited credentials.
import {
  appendFileSync,
  existsSync,
  openSync,
  closeSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";

if (process.argv.includes("--version")) {
  console.log("codex-cli 0.166.0");
  process.exit(0);
}
if (process.argv.includes("login")) {
  console.log("Logged in using API key");
  process.exit(0);
}
let native = "019a0000-cccc-7ccc-8ccc-cccccccccccc";
const cwd = process.env.YEP_E2E_CREATION_CWD;
let file = process.env.YEP_E2E_CREATION_NATIVE_FILE;
const store = dirname(file);
const log = process.env.YEP_E2E_CREATION_REQUESTS;
appendFileSync(`${log}.launches`, `${JSON.stringify(process.argv.slice(2))}\n`);
const gate = process.env.YEP_E2E_CREATION_GATE;
const write = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const respond = (id, result) => write({ id, result });
const notify = (method, params) => write({ method, params });
const row = (type, payload) =>
  appendFileSync(
    file,
    `${JSON.stringify({ timestamp: new Date().toISOString(), type, payload })}\n`,
  );
const model = {
  id: "gpt-6.1-sol",
  model: "gpt-6.1-sol",
  displayName: "Owned fixture model",
  description: "Controlled protocol",
  hidden: false,
  isDefault: true,
  supportedReasoningEfforts: [{ reasoningEffort: "high", description: "high" }],
  defaultReasoningEffort: "high",
  inputModalities: ["text"],
  supportsPersonality: false,
};
async function handle(message) {
  appendFileSync(log, `${JSON.stringify(message)}\n`);
  if (message.id === undefined) return;
  const { id, params = {}, method } = message;
  switch (method) {
    case "initialize":
      respond(id, { userAgent: "owned-controlled-codex" });
      break;
    case "account/read":
      respond(id, { account: { type: "apiKey" }, requiresOpenaiAuth: false });
      break;
    case "model/list":
      respond(id, { data: [model], nextCursor: null });
      break;
    case "skills/list":
      respond(id, { data: [{ cwd, skills: [], errors: [] }] });
      break;
    case "thread/start":
      while (
        process.env.YEP_E2E_CREATION_HOLD_BINDING === "true" &&
        !existsSync(`${gate}.binding`)
      )
        await new Promise((resolve) => setTimeout(resolve, 20));
      try {
        closeSync(openSync(`${log}.first-thread`, "wx"));
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        native = randomUUID();
      }
      file = join(store, `rollout-${native}.jsonl`);
      row("session_meta", {
        id: native,
        cwd,
        timestamp: new Date().toISOString(),
        originator: "yep-anywhere",
        cli_version: "0.166.0",
        source: "cli",
      });
      for (
        let index = 0;
        index < Number(process.env.YEP_E2E_CREATION_HISTORY_ROWS ?? 0);
        index++
      ) {
        row("response_item", {
          type: "message",
          id: `history-${index}`,
          role: index % 2 ? "assistant" : "user",
          content: [
            {
              type: index % 2 ? "output_text" : "input_text",
              text: `Historical context ${index}: bounded transcript with real queued compaction.`,
            },
          ],
        });
      }
      respond(id, {
        thread: {
          id: native,
          cwd,
          turns: [],
          status: { type: "idle" },
          path: file,
        },
        model: model.id,
        reasoningEffort: "high",
      });
      break;
    case "thread/fork": {
      if (
        params.path !== join(store, `rollout-${params.threadId}.jsonl`) ||
        !existsSync(params.path)
      )
        throw new Error("Wrong native copy address");
      while (!existsSync(`${gate}.fork`))
        await new Promise((resolve) => setTimeout(resolve, 20));
      native = randomUUID();
      file = join(store, `rollout-${native}.jsonl`);
      const rows = readFileSync(params.path, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      for (const entry of rows)
        if (entry.type === "session_meta") entry.payload.id = native;
      writeFileSync(
        file,
        rows.map((row) => JSON.stringify(row)).join("\n") + "\n",
      );
      respond(id, {
        thread: {
          id: native,
          cwd,
          turns: [],
          status: { type: "idle" },
          path: file,
        },
        model: model.id,
        reasoningEffort: "high",
      });
      break;
    }
    case "thread/resume":
      if (
        params.path !== join(store, `rollout-${params.threadId}.jsonl`) ||
        !existsSync(params.path)
      )
        throw new Error("Wrong native resume address");
      native = params.threadId;
      file = params.path;
      respond(id, {
        thread: {
          id: native,
          cwd,
          turns: [],
          status: { type: "idle" },
          path: file,
        },
        model: model.id,
        reasoningEffort: "high",
      });
      break;
    case "thread/compact/start": {
      respond(id, {});
      const turn = {
        id: `compact-${id}`,
        status: "inProgress",
        items: [],
        error: null,
      };
      notify("turn/started", { threadId: native, turn });
      const item = { id: `boundary-${id}`, type: "contextCompaction" };
      notify("item/started", { threadId: native, turnId: turn.id, item });
      while (!existsSync(`${gate}.compact-boundary`))
        await new Promise((resolve) => setTimeout(resolve, 20));
      notify("item/completed", { threadId: native, turnId: turn.id, item });
      while (!existsSync(`${gate}.compact-completion`))
        await new Promise((resolve) => setTimeout(resolve, 20));
      notify("turn/completed", {
        threadId: native,
        turn: { ...turn, status: "completed" },
      });
      break;
    }
    case "turn/start": {
      if (params.threadId !== native)
        throw new Error("Public id reached native input");
      const persistBeforeAck =
        process.env.YEP_E2E_CREATION_PERSIST_BEFORE_ACK === "true";
      if (!persistBeforeAck)
        while (!existsSync(`${gate}.ack`))
          await new Promise((resolve) => setTimeout(resolve, 20));
      const text = params.input
        .filter((item) => item.type === "text")
        .map((item) => item.text)
        .join("\n");
      const inputId = params.clientUserMessageId;
      row("response_item", {
        type: "message",
        id: inputId,
        role: "user",
        content: [{ type: "input_text", text }],
      });
      row("event_msg", {
        type: "user_message",
        message: text,
        client_id: inputId,
      });
      if (persistBeforeAck)
        while (!existsSync(`${gate}.ack`))
          await new Promise((resolve) => setTimeout(resolve, 20));
      const turn = {
        id: `turn-${inputId}`,
        status: "inProgress",
        items: [],
        error: null,
      };
      respond(id, { turn });
      notify("turn/started", { threadId: native, turn });
      while (!existsSync(`${gate}.reply`))
        await new Promise((resolve) => setTimeout(resolve, 20));
      row("response_item", {
        type: "message",
        id: `answer-${inputId}`,
        role: "assistant",
        content: [{ type: "output_text", text: "OWNED_CODEX_CREATION_REPLY" }],
      });
      notify("item/completed", {
        threadId: native,
        turnId: turn.id,
        item: {
          type: "agentMessage",
          id: `answer-${inputId}`,
          text: "OWNED_CODEX_CREATION_REPLY",
        },
      });
      notify("turn/completed", {
        threadId: native,
        turn: { ...turn, status: "completed" },
      });
      break;
    }
    default:
      respond(id, {});
  }
}
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  const lines = buffer.split("\n");
  buffer = lines.pop() ?? "";
  for (const line of lines)
    if (line.trim())
      void handle(JSON.parse(line)).catch((error) => {
        console.error(error);
        process.exit(1);
      });
});
// Match the native stdio owner's lifetime, including abrupt Hono loss while an
// artificial ACK barrier is held. Pending fixture timers must not orphan it.
process.stdin.on("end", () => {
  appendFileSync(log, `${JSON.stringify({ fixtureExit: process.pid })}\n`);
  process.exit(0);
});
