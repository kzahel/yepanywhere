// Owned native HTTP/SSE peer and provider-owned DB. No model or real credentials.
import { createServer } from "node:http";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

const args = process.argv.slice(2);
if (args.includes("--version")) {
  console.log("1.18.18");
  process.exit(0);
}
if (args[0] === "models") {
  console.log("opencode/fixture");
  process.exit(0);
}
if (args[0] !== "serve") throw Error("Unsupported owned OpenCode command");
const root = join(process.env.XDG_DATA_HOME, "opencode"),
  cwd = process.cwd();
mkdirSync(root, { recursive: true });
const db = new DatabaseSync(
  process.env.YEP_E2E_OPENCODE_FILELESS === "1"
    ? ":memory:"
    : join(root, "opencode.db"),
);
db.exec(`PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS project(id TEXT PRIMARY KEY, worktree TEXT);
CREATE TABLE IF NOT EXISTS session(id TEXT PRIMARY KEY, project_id TEXT, parent_id TEXT, agent TEXT, directory TEXT, title TEXT, model TEXT, time_created INTEGER, time_updated INTEGER);
CREATE TABLE IF NOT EXISTS message(id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
CREATE TABLE IF NOT EXISTS part(id TEXT PRIMARY KEY, session_id TEXT, message_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);`);
db.prepare("INSERT OR IGNORE INTO project VALUES (?,?)").run(
  "owned-project",
  cwd,
);
const log = process.env.YEP_E2E_OPENCODE_REQUESTS,
  gate = process.env.YEP_E2E_OPENCODE_GATE;
const record = (row) => appendFileSync(log, JSON.stringify(row) + "\n");
record({
  op: "serve",
  pid: process.pid,
  protected: Boolean(process.env.OPENCODE_SERVER_PASSWORD),
});
const expected = process.env.OPENCODE_SERVER_PASSWORD
  ? "Basic " +
    Buffer.from(
      process.env.OPENCODE_SERVER_USERNAME +
        ":" +
        process.env.OPENCODE_SERVER_PASSWORD,
    ).toString("base64")
  : undefined;
const clients = new Set();
const event = (type, properties) => {
  for (const res of clients)
    res.write("data: " + JSON.stringify({ type, properties }) + "\n\n");
};
const ready = (path) =>
  new Promise((resolve) => {
    if (existsSync(path)) return resolve();
    const t = setInterval(() => {
      if (existsSync(path)) {
        clearInterval(t);
        resolve();
      }
    }, 10);
    t.unref();
  });
const info = (id) => {
  const s = db.prepare("SELECT * FROM session WHERE id=?").get(id);
  return (
    s && {
      id: s.id,
      projectID: s.project_id,
      directory: s.directory,
      title: s.title,
      time: { created: s.time_created, updated: s.time_updated },
    }
  );
};
const putMessage = (sessionId, role, text) => {
  const id = "msg_" + randomUUID(),
    now = Date.now(),
    meta = {
      id,
      sessionID: sessionId,
      role,
      time: {
        created: now,
        ...(role === "assistant" ? { completed: now } : {}),
      },
    };
  const part = {
    id: "prt_" + randomUUID(),
    sessionID: sessionId,
    messageID: id,
    type: "text",
    text,
  };
  db.prepare("INSERT INTO message VALUES (?,?,?,?,?)").run(
    id,
    sessionId,
    now,
    now,
    JSON.stringify(meta),
  );
  db.prepare("INSERT INTO part VALUES (?,?,?,?,?,?)").run(
    part.id,
    sessionId,
    id,
    now,
    now,
    JSON.stringify(part),
  );
  db.prepare("UPDATE session SET time_updated=? WHERE id=?").run(
    now,
    sessionId,
  );
  return { info: meta, parts: [part] };
};
const server = createServer(async (req, res) => {
  if (expected && req.headers.authorization !== expected) {
    res.writeHead(401);
    res.end();
    return;
  }
  const url = new URL(req.url, "http://localhost");
  if (url.pathname === "/event") {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.flushHeaders();
    clients.add(res);
    req.on("close", () => clients.delete(res));
    return;
  }
  let raw = "";
  for await (const c of req) raw += c;
  const body = raw ? JSON.parse(raw) : {};
  record({ op: "request", method: req.method, path: url.pathname, body });
  res.setHeader("Content-Type", "application/json");
  if (url.pathname === "/session" && req.method === "GET") {
    res.end(JSON.stringify(db.prepare("SELECT id FROM session").all()));
    return;
  }
  if (url.pathname === "/session" && req.method === "POST") {
    const id = "ses_" + randomUUID(),
      now = Date.now();
    db.prepare("INSERT INTO session VALUES (?,?,NULL,NULL,?,?,?,?,?)").run(
      id,
      "owned-project",
      cwd,
      body.title ?? "Owned OpenCode",
      "opencode/fixture",
      now,
      now,
    );
    res.end(JSON.stringify(info(id)));
    return;
  }
  const m = url.pathname.match(/^\/session\/([^/]+)(?:\/(message|abort))?$/);
  if (!m || !info(m[1])) {
    res.writeHead(404);
    res.end("{}");
    return;
  }
  const id = m[1];
  if (!m[2]) {
    res.end(JSON.stringify(info(id)));
    return;
  }
  if (m[2] === "abort") {
    res.end("{}");
    return;
  }
  if (req.method === "POST") {
    const text = body.parts
      .filter((p) => p.type === "text")
      .map((p) => p.text)
      .join("");
    const count = db
      .prepare(
        "SELECT COUNT(*) n FROM message WHERE session_id=? AND json_extract(data,'$.role')='user'",
      )
      .get(id).n;
    putMessage(id, "user", text);
    if (process.env.YEP_E2E_OPENCODE_REFUSE === "1") {
      res.writeHead(503);
      res.end("{}");
      return;
    }
    await ready(gate + ".stream");
    const answer = putMessage(
      id,
      "assistant",
      count === 0
        ? "OWNED_OPENCODE_CREATION_REPLY"
        : "OWNED_OPENCODE_CONTINUED_REPLY",
    );
    event("message.updated", {
      info: { ...answer.info, time: { created: answer.info.time.created } },
    });
    event("message.part.updated", { part: answer.parts[0] });
    await ready(gate + ".reply");
    event("message.updated", { info: answer.info });
    event("session.idle", { sessionID: id });
    res.end(JSON.stringify(answer));
    return;
  }
  const messages = db
    .prepare(
      "SELECT id,data FROM message WHERE session_id=? ORDER BY time_created",
    )
    .all(id)
    .map((m) => ({
      info: JSON.parse(m.data),
      parts: db
        .prepare("SELECT data FROM part WHERE message_id=?")
        .all(m.id)
        .map((p) => JSON.parse(p.data)),
    }));
  res.end(JSON.stringify(messages));
});
server.listen(Number(args[args.indexOf("--port") + 1]), "127.0.0.1");
const finish = () => {
  for (const c of clients) c.end();
  server.closeAllConnections();
  server.close(() => {
    db.close();
    process.exit(0);
  });
};
process.on("SIGTERM", finish);
process.stdin.resume();
process.stdin.on("end", finish);
