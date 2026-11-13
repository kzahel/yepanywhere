#!/usr/bin/env node

/**
 * A local mesh of standalone YA servers, paired in both directions.
 *
 * Each node is a real source server started through `ya:instance` on its own
 * data directory, fixed port and provider state, so nothing here reads or
 * writes the developer's default profile or native provider logins. Nodes are
 * paired through the owner invitation ceremony (topics/peer-access.md), which
 * needs only an owner login on each side. `smoke` then exercises the v0 peer
 * route over every directed edge and exits nonzero when a check fails.
 *
 * Inference is not configured here. A node has no provider login of its own;
 * route sessions through the Agent Auth Router when a check needs a model.
 */

import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const instanceTool = join(rootDir, "scripts/ya-instance.mjs");

const USAGE = `Usage: pnpm mesh:testbed <command> [options]

Commands:
  up        Start the nodes, give each an owner login, a scratch project and
            v0 session commands, then pair every node with every other node.
            Safe to repeat: running nodes and existing pairings are kept.
  status    Show each node's URL, server id and login, and each edge's state.
  smoke     Check discovery and reads over every directed edge through the
            v0 peer route. Calls no model. Exits 1 when a check fails.
            --inference adds one real routed session around the ring
            (a->b, b->c, ..., last->a): create, retry, follow, reply,
            follow-up prompt, stop. Run "router" first.
  router    Connect each node to the local Agent Auth Router and grant it
            the named pools, so sessions can run without a provider login.
            Needs the router's CLI: set AAR_CLI if "aar" is not on PATH.
  down      Stop the nodes and keep their data. --purge also disconnects
            each node from the router and removes its data.

Options:
  --nodes a,b,c      Node names (default a,b,c; 2-8 nodes)
  --name NAME        Mesh name; node profiles are NAME-<node> (default mesh)
  --base-port N      First node's port; later nodes add 10 each (default 3480)
  --ui               up: serve the built web client on each node it starts
                     (build it first: pnpm --filter client build). Without
                     this a node serves only its API.
  --json             status/smoke: machine-readable output
  --pools A,B        router: pool names or ids to grant every node
  --inference        smoke: also run real routed sessions (uses model quota)
  --provider P       smoke --inference: claude or codex (default claude)
  --model ID         smoke --inference: model id from the pool's catalog
                     (required; the router has no default model)
  --pool NAME        smoke --inference: router pool (default: first granted)
  --purge            down: remove the nodes' data directories

Node data lives in ~/.yep-anywhere-NAME-<node>. Its testbed/ subdirectory
holds the node's owner password (mode 0600), isolated provider directories
and scratch project.`;

function fail(message) {
  console.error(`mesh:testbed: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = {
    command,
    nodes: ["a", "b", "c"],
    name: "mesh",
    basePort: 3480,
  };
  for (let index = 0; index < rest.length; index++) {
    const arg = rest[index];
    const value = () => {
      const next = rest[++index];
      if (next === undefined) fail(`${arg} needs a value`);
      return next;
    };
    if (arg === "--nodes") options.nodes = value().split(",").filter(Boolean);
    else if (arg === "--name") options.name = value();
    else if (arg === "--base-port") options.basePort = Number(value());
    else if (arg === "--json") options.json = true;
    else if (arg === "--ui") options.ui = true;
    else if (arg === "--pools")
      options.pools = value().split(",").filter(Boolean);
    else if (arg === "--purge") options.purge = true;
    else if (arg === "--inference") options.inference = true;
    else if (arg === "--provider") options.provider = value();
    else if (arg === "--model") options.model = value();
    else if (arg === "--pool") options.pool = value();
    else if (arg === "-h" || arg === "--help") options.command = "help";
    else fail(`unknown option ${arg}\n\n${USAGE}`);
  }
  const safe = /^[a-z0-9][a-z0-9-]{0,23}$/;
  if (!safe.test(options.name)) fail("--name must be lowercase [a-z0-9-]");
  if (
    options.nodes.length < 2 ||
    options.nodes.length > 8 ||
    new Set(options.nodes).size !== options.nodes.length ||
    options.nodes.some((node) => !safe.test(node))
  )
    fail("--nodes needs 2-8 distinct lowercase [a-z0-9-] names");
  if (
    !Number.isInteger(options.basePort) ||
    options.basePort < 1024 ||
    options.basePort + 10 * options.nodes.length > 65535
  )
    fail("--base-port must leave room for every node below 65536");
  return options;
}

function describeNodes(options) {
  return options.nodes.map((name, index) => {
    const profile = `${options.name}-${name}`;
    const dataDir = join(homedir(), `.yep-anywhere-${profile}`);
    const port = options.basePort + 10 * index;
    return {
      name,
      profile,
      dataDir,
      testbedDir: join(dataDir, "testbed"),
      port,
      url: `http://127.0.0.1:${port}`,
      peerRoute: `ws://127.0.0.1:${port}/peer/ws`,
    };
  });
}

function directory(...parts) {
  const path = join(...parts);
  mkdirSync(path, { recursive: true, mode: 0o700 });
  return path;
}

/**
 * A node sees no developer provider state and no agent or model credentials:
 * transcripts, logins and API keys all resolve inside its testbed directory.
 * HOME stays, so the Agent Auth Router's default control socket is reachable.
 */
function nodeEnvironment(node, ui) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => {
      const name = key.toUpperCase();
      return (
        !/^(AGENT_|AGENTCTL_|YEP_|YA_)/.test(name) &&
        !/^(ANTHROPIC_|CLAUDE_|CLAUDECODE|CODEX_|OPENAI_|GEMINI_|ANTIGRAVITY_|GOOGLE_|GROK_|XAI_|PI_|OPENCODE_)/.test(
          name,
        ) &&
        !/(?:_API_KEY|_TOKEN|_SECRET|_PASSWORD)$/.test(name) &&
        !["PORT", "PORT_FILE", "AUTH_DISABLED", "NODE_OPTIONS"].includes(name)
      );
    }),
  );
  const providers = directory(node.testbedDir, "providers");
  return {
    ...env,
    CLAUDE_CONFIG_DIR: directory(providers, "claude"),
    CODEX_HOME: directory(providers, "codex"),
    GEMINI_CLI_HOME: directory(providers, "gemini-home"),
    GEMINI_HOME: directory(providers, "gemini-home", ".gemini"),
    GEMINI_SESSIONS_DIR: directory(providers, "gemini-sessions"),
    PI_CODING_AGENT_DIR: directory(providers, "pi"),
    PI_SESSIONS_DIR: directory(providers, "pi", "sessions"),
    GROK_HOME: directory(providers, "grok"),
    GROK_SESSIONS_DIR: directory(providers, "grok", "sessions"),
    ENABLED_PROVIDERS: "claude,codex",
    YEP_EXTERNAL_SESSIONS: "false",
    OPEN_BROWSER: "false",
    // A source server otherwise proxies pages to a Vite port nothing serves.
    ...(ui ? { NODE_ENV: "production" } : { SERVE_FRONTEND: "false" }),
  };
}

function instance(args, env) {
  return execFileSync(process.execPath, [instanceTool, ...args], {
    cwd: rootDir,
    env: env ?? process.env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function recordedInstances() {
  return JSON.parse(instance(["list", "--json"]));
}

function runningRecord(node, records = recordedInstances()) {
  return records.find(
    (entry) =>
      resolve(entry.dataDir ?? "") === node.dataDir &&
      entry.status === "running",
  );
}

function readState(node) {
  const path = join(node.testbedDir, "state.json");
  if (!existsSync(path)) return;
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeState(node, state) {
  directory(node.testbedDir);
  const path = join(node.testbedDir, "state.json");
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

/** One node's ordinary HTTP API, carrying its owner cookie once logged in. */
class NodeClient {
  constructor(node) {
    this.node = node;
    this.cookie = undefined;
  }
  async request(path, { method = "GET", body, headers = {} } = {}) {
    const response = await fetch(`${this.node.url}${path}`, {
      method,
      headers: {
        "X-Yep-Anywhere": "true",
        ...(this.cookie ? { Cookie: this.cookie } : {}),
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...headers,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await response.text();
    let json;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    return { status: response.status, headers: response.headers, text, json };
  }
  async expect(path, init, accepted = [200, 201, 202, 204]) {
    const reply = await this.request(path, init);
    if (!accepted.includes(reply.status))
      throw new Error(
        `${this.node.name}: ${init?.method ?? "GET"} ${path} returned ${reply.status} ${reply.text.slice(0, 300)}`,
      );
    return reply;
  }
  /** Owner proof is a real owner cookie; open localhost is not enough. */
  async login(password) {
    const status = (await this.expect("/api/auth/status")).json;
    if (!status.enabled)
      await this.expect("/api/auth/enable", {
        method: "POST",
        body: { password },
      });
    const reply = await this.expect("/api/auth/login", {
      method: "POST",
      body: { password },
    });
    const cookie = reply.headers
      .getSetCookie()
      .map((value) => value.split(";")[0])
      .find((value) => value.startsWith("yep-anywhere-session="));
    if (!cookie) throw new Error(`${this.node.name}: login set no cookie`);
    this.cookie = cookie;
  }
}

async function connect(node) {
  const state = readState(node);
  if (!state?.password)
    fail(
      `${node.profile} has no testbed state; run "up", or "down --purge" to reset`,
    );
  const client = new NodeClient(node);
  await client.login(state.password);
  return client;
}

/** Operations a peer grant can name: every server-addressed v0 operation. */
async function grantableOperations(client) {
  const schema = (await client.expect("/v0/schema")).json;
  const operations = [];
  for (const [path, methods] of Object.entries(schema.paths ?? {}))
    if (path.includes("{serverId}"))
      for (const operation of Object.values(methods))
        if (operation?.operationId) operations.push(operation.operationId);
  if (!operations.length) throw new Error("served schema names no operations");
  return operations;
}

async function up(options) {
  const nodes = describeNodes(options);
  if (
    options.ui &&
    !existsSync(join(rootDir, "packages/client/dist/index.html"))
  )
    fail("--ui needs a built client: run pnpm --filter client build");
  const records = recordedInstances();
  for (const node of nodes) {
    if (runningRecord(node, records)) {
      console.log(`${node.name}: already running at ${node.url}`);
      continue;
    }
    if (!readState(node))
      writeState(node, { password: randomBytes(18).toString("base64url") });
    process.stdout.write(`${node.name}: starting on port ${node.port}... `);
    instance(
      ["start", "--profile", node.profile, "--port", String(node.port)],
      nodeEnvironment(node, options.ui),
    );
    console.log("ready");
  }

  const clients = new Map();
  for (const node of nodes) {
    const client = await connect(node);
    clients.set(node.name, client);
    await client.expect("/api/settings", {
      method: "PUT",
      body: { agentApiEnabled: true, agentApiManagementEnabled: true },
    });
    const project = directory(node.testbedDir, "project");
    await client.expect("/api/projects", {
      method: "POST",
      body: { path: project, gitInit: false },
    });
    const state = readState(node);
    state.serverId = (await client.expect("/v0")).json.serverId;
    state.url = node.url;
    state.project = project;
    writeState(node, state);
  }

  for (const source of nodes)
    for (const target of nodes) {
      if (source === target) continue;
      const from = clients.get(source.name);
      const to = clients.get(target.name);
      const targetId = readState(target).serverId;
      const sourceId = readState(source).serverId;
      const existing = (await from.expect("/api/peers")).json.outgoing.find(
        (peer) => peer.targetServerId === targetId,
      );
      if (existing) continue;
      const operations = await grantableOperations(to);
      const invitation = (
        await to.expect("/api/peers/incoming", {
          method: "POST",
          body: {
            sourceServerId: sourceId,
            authentication: "refresh-v1",
            allProjects: true,
            projects: [],
            operations,
            expiresAt: Date.now() + 89 * 24 * 60 * 60_000,
            acknowledgeExecutionAuthority: "server-account",
          },
        })
      ).json;
      await from.expect("/api/peers/outgoing", {
        method: "POST",
        body: {
          invitation,
          route: { kind: "direct", url: target.peerRoute },
          operations,
          allowAgentSessions: true,
        },
      });
      console.log(`paired ${source.name} -> ${target.name}`);
    }
  console.log("");
  await status(options);
}

async function edgeState(client, targetId) {
  const reply = await client.request(`/v0/servers/${targetId}/capabilities`);
  return reply.status === 200
    ? "ok"
    : `${reply.status} ${reply.json?.error?.code ?? "error"}`;
}

async function status(options) {
  const nodes = describeNodes(options);
  const records = recordedInstances();
  const report = [];
  for (const node of nodes) {
    const state = readState(node);
    const running = !!runningRecord(node, records);
    const entry = {
      node: node.name,
      profile: node.profile,
      url: node.url,
      running,
      serverId: state?.serverId ?? null,
      password: state?.password ?? null,
      project: state?.project ?? null,
      edges: {},
    };
    report.push(entry);
  }
  for (const entry of report) {
    if (!entry.running || !entry.password) continue;
    const client = await connect(nodes.find((n) => n.name === entry.node));
    for (const other of report) {
      if (other === entry || !other.serverId) continue;
      entry.edges[other.node] = await edgeState(client, other.serverId);
    }
  }
  if (options.json) return console.log(JSON.stringify(report, null, 2));
  for (const entry of report) {
    console.log(
      `${entry.node}  ${entry.running ? "running" : "stopped"}  ${entry.url}  ${entry.serverId ?? "(not set up)"}`,
    );
    if (entry.password) console.log(`   owner password: ${entry.password}`);
    const edges = Object.entries(entry.edges)
      .map(([name, state]) => `${entry.node}->${name} ${state}`)
      .join("   ");
    if (edges) console.log(`   ${edges}`);
  }
}

/** Reads over one directed edge, as an owner on the source's ordinary API. */
async function smokeEdge(client, source, target, check) {
  const targetId = readState(target).serverId;
  const edge = `${source.name}->${target.name}`;
  const base = `/v0/servers/${targetId}`;
  const get = async (name, path, verify, status = 200) => {
    try {
      let reply = await client.request(path);
      // Just after a start the session catalog is honestly unsure of absence
      // and says to retry; wait for its first discovery, briefly.
      for (
        let attempt = 0;
        attempt < 20 && reply.json?.error?.code === "catalog_not_ready";
        attempt++
      ) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        reply = await client.request(path);
      }
      const problems = [];
      if (reply.status !== status)
        problems.push(`status ${reply.status} ${reply.text.slice(0, 200)}`);
      if (reply.headers.get("cache-control") !== "no-store")
        problems.push(`cache-control ${reply.headers.get("cache-control")}`);
      if (reply.status === status) {
        const problem = verify?.(reply);
        if (problem) problems.push(problem);
      }
      check(edge, name, problems);
      return reply;
    } catch (error) {
      check(edge, name, [String(error?.message ?? error)]);
    }
  };

  await get("listed", "/v0/servers", (reply) =>
    reply.json.items.some((item) => item.id === targetId && !item.local)
      ? undefined
      : "target is not listed as a peer",
  );
  await get("identity", base, (reply) =>
    reply.json.id === targetId &&
    reply.headers.get("x-ya-server-id") === targetId
      ? undefined
      : "reply does not carry the target's identity",
  );
  await get("access", `${base}/access`, (reply) => {
    const expected = ["sessions", "createSession", "prompt", "cancel", "stop"];
    const missing = expected.filter(
      (operation) => !reply.json.operations.includes(operation),
    );
    return reply.json.principal?.kind !== "peer"
      ? "target did not see a peer principal"
      : missing.length
        ? `grant lacks ${missing.join(",")}`
        : undefined;
  });
  await get("capabilities", `${base}/capabilities`, (reply) =>
    Array.isArray(reply.json.operations) ? undefined : "no operation list",
  );
  await get("target help", `${base}/help`, (reply) =>
    reply.text.includes("Operation index") ? undefined : "not the help guide",
  );
  await get(
    "focused schema",
    `${base}/schema?operation=createSession`,
    (reply) =>
      reply.text.includes("createSession") ? undefined : "schema lacks it",
  );
  await get("projects", `${base}/projects`, (reply) =>
    reply.json.items.some((item) => item.path === readState(target).project)
      ? undefined
      : "target's scratch project is not listed",
  );
  await get("providers", `${base}/providers`, (reply) =>
    reply.json.items.length ? undefined : "no providers",
  );
  await get("sessions", `${base}/sessions?limit=5`, (reply) =>
    Array.isArray(reply.json.items) ? undefined : "no session page",
  );
  await get(
    "unknown session",
    `${base}/sessions/mesh-smoke-missing-session`,
    undefined,
    404,
  );
  await get(
    "unknown route",
    `${base}/mesh-smoke-unknown-route`,
    undefined,
    404,
  );
}

const INFERENCE_DEADLINE_MS = 180_000;

/**
 * One real session on the target, driven from the source over the peer route.
 * Every reply along the way must succeed: an agent following its own work
 * cannot tell a transient 404 from a failed launch.
 */
async function inferenceEdge(client, source, target, options, check) {
  const targetId = readState(target).serverId;
  const edge = `${source.name}->${target.name}`;
  const base = `/v0/servers/${targetId}`;
  const provider = options.provider ?? "claude";
  const token = randomBytes(4).toString("hex").toUpperCase();
  const deadline = Date.now() + INFERENCE_DEADLINE_MS;
  const step = async (name, run) => {
    try {
      const problem = await run();
      check(edge, name, problem ? [problem] : []);
      return !problem;
    } catch (error) {
      check(edge, name, [String(error?.message ?? error)]);
      return false;
    }
  };
  const command = (path, key, body) =>
    client.request(`${base}${path}`, {
      method: "POST",
      body,
      headers: { "Idempotency-Key": key },
    });
  /** Follow a receipt until `done`; any non-200 reply is itself a failure. */
  const settle = async (receiptId, done) => {
    let cursor;
    for (;;) {
      const reply = await client.request(
        `${base}/receipts/${receiptId}/follow?waitMs=4000${cursor ? `&after=${cursor}` : ""}`,
      );
      if (reply.status !== 200)
        throw new Error(
          `receipt follow returned ${reply.status} ${reply.text.slice(0, 160)}`,
        );
      cursor = reply.json.cursor ?? cursor;
      const receipt =
        reply.json.receipt ??
        (await client.expect(`${base}/receipts/${receiptId}`)).json;
      if (receipt.state === "failed" || receipt.state === "uncertain")
        throw new Error(
          `receipt ${receipt.state}: ${receipt.failure?.code} ${receipt.failure?.message}`,
        );
      if (done(receipt)) return receipt;
      if (Date.now() > deadline) throw new Error("receipt did not settle");
    }
  };
  /** Follow the conversation until an agent message contains `text`. */
  const answered = async (sessionId, text) => {
    let cursor;
    for (;;) {
      const reply = await client.request(
        `${base}/sessions/${sessionId}/conversation/follow?waitMs=4000${cursor ? `&after=${cursor}` : ""}`,
      );
      if (reply.status !== 200)
        throw new Error(
          `conversation follow returned ${reply.status} ${reply.text.slice(0, 160)}`,
        );
      cursor = reply.json.cursor ?? cursor;
      const messages = reply.json.conversation?.messages ?? [];
      if (
        messages.some(
          (message) =>
            message.role === "agent" &&
            message.content.some((part) => part.text?.includes(text)),
        )
      )
        return;
      if (Date.now() > deadline) throw new Error(`no agent reply had ${text}`);
    }
  };

  let pool;
  let project;
  let created;
  let sessionId;
  const key = `mesh-${source.name}-${target.name}-${token}`;
  const ready = await step("routed pool", async () => {
    const selection = (
      await client.expect(`${base}/selection?provider=${provider}`)
    ).json;
    pool = (selection.pools ?? []).find(
      (entry) =>
        !options.pool ||
        entry.name === options.pool ||
        entry.id === options.pool,
    );
    project = (await client.expect(`${base}/projects`)).json.items.find(
      (item) => item.path === readState(target).project,
    );
    const offered = [
      ...new Set(
        (selection.accounts ?? [])
          .filter((account) => pool?.accountIds?.includes(account.id))
          .flatMap((account) => (account.models ?? []).map((m) => m.id)),
      ),
    ];
    return !pool
      ? `target offers no ${provider} router pool; run "router --pools ..."`
      : !project
        ? "target's scratch project is not listed"
        : !options.model
          ? `name a model with --model; ${pool.name} offers ${offered.join(", ")}`
          : undefined;
  });
  if (!ready) return;
  const body = {
    projectId: project.id,
    provider,
    prompt: `Reply with exactly this text and nothing else: MESH-${token}-ONE`,
    permissionMode: "default",
    routerPoolId: pool.id,
    ...(options.model ? { model: options.model } : {}),
  };
  if (
    !(await step("create", async () => {
      const reply = await command("/sessions", key, body);
      created = reply.json;
      return reply.status === 202 && created?.id
        ? undefined
        : `status ${reply.status} ${reply.text.slice(0, 200)}`;
    }))
  )
    return;
  await step("identical retry", async () => {
    const reply = await command("/sessions", key, body);
    return reply.json?.id === created.id
      ? undefined
      : `retry returned ${reply.status} ${reply.json?.id}`;
  });
  if (
    !(await step("launch", async () => {
      sessionId = (
        await settle(
          created.id,
          (receipt) => receipt.state === "accepted" && receipt.sessionId,
        )
      ).sessionId;
    }))
  )
    return;
  await step("first reply", () => answered(sessionId, `MESH-${token}-ONE`));
  await step("routing readback", async () => {
    const detail = (await client.expect(`${base}/sessions/${sessionId}`)).json;
    return detail.routing?.mode !== "aar" || detail.routing.poolId !== pool.id
      ? `routing ${JSON.stringify(detail.routing)}`
      : options.model && detail.settings?.model !== options.model
        ? `model ${detail.settings?.model}`
        : undefined;
  });
  await step("follow-up prompt", async () => {
    const reply = await command(
      `/sessions/${sessionId}/prompts`,
      `${key}-two`,
      {
        prompt: `Reply with exactly this text and nothing else: MESH-${token}-TWO`,
      },
    );
    if (reply.status !== 202)
      return `status ${reply.status} ${reply.text.slice(0, 200)}`;
    await settle(reply.json.id, (receipt) => receipt.delivery === "consumed");
    await answered(sessionId, `MESH-${token}-TWO`);
  });
  await step("pending requests", async () => {
    const reply = await client.request(
      `${base}/sessions/${sessionId}/requests`,
    );
    return reply.status === 200 && Array.isArray(reply.json.items)
      ? undefined
      : `status ${reply.status} ${reply.text.slice(0, 200)}`;
  });
  await step("provenance", async () => {
    const reply = await client.request(
      `${base}/sessions/${sessionId}/relationships`,
    );
    return reply.json?.creation?.id === created.id &&
      reply.json.creation.creator?.serverId === readState(source).serverId
      ? undefined
      : `status ${reply.status} creation ${reply.json?.creation?.id}`;
  });
  await step("stop", async () => {
    const reply = await command(
      `/sessions/${sessionId}/stop`,
      `${key}-stop`,
      {},
    );
    if (reply.status !== 202)
      return `status ${reply.status} ${reply.text.slice(0, 200)}`;
    const receipt = await settle(
      reply.json.id,
      (current) => current.state === "accepted",
    );
    if (receipt.result?.stopped !== true)
      return `result ${JSON.stringify(receipt.result)}`;
    const detail = await client.request(`${base}/sessions/${sessionId}`);
    return detail.status === 200
      ? undefined
      : `stopped session read returned ${detail.status}`;
  });
}

async function smoke(options) {
  const nodes = describeNodes(options);
  const results = [];
  const check = (edge, name, problems) =>
    results.push({ edge, check: name, ok: !problems.length, problems });
  const clients = new Map();
  for (const node of nodes) clients.set(node.name, await connect(node));
  for (const source of nodes)
    for (const target of nodes)
      if (source !== target)
        await smokeEdge(clients.get(source.name), source, target, check);
  // A server never routes to itself as a peer, and never routes onward.
  for (const node of nodes) {
    const client = clients.get(node.name);
    const self = await client.request("/v0/servers/self/access");
    check(`${node.name}->self`, "local access", [
      ...(self.status === 200 && self.json.principal?.kind === "superuser"
        ? []
        : [`status ${self.status} principal ${self.json?.principal?.kind}`]),
    ]);
  }
  if (options.inference)
    await Promise.all(
      nodes.map((source, index) =>
        inferenceEdge(
          clients.get(source.name),
          source,
          nodes[(index + 1) % nodes.length],
          options,
          check,
        ),
      ),
    );
  const failed = results.filter((result) => !result.ok);
  if (options.json) console.log(JSON.stringify(results, null, 2));
  else {
    for (const result of failed)
      console.log(
        `FAIL ${result.edge} ${result.check}: ${result.problems.join("; ")}`,
      );
    console.log(
      `${results.length - failed.length}/${results.length} checks passed over ${nodes.length * (nodes.length - 1)} edges`,
    );
  }
  if (failed.length) process.exit(1);
}

/** The router's owner CLI; grants are an owner act the node cannot perform. */
function routerOwner(operation, body = {}) {
  const [command, ...args] = (process.env.AAR_CLI ?? "aar")
    .split(" ")
    .filter(Boolean);
  try {
    return JSON.parse(
      execFileSync(command, [...args, "owner", operation], {
        input: JSON.stringify(body),
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
      }),
    );
  } catch (error) {
    throw new Error(
      `Agent Auth Router owner ${operation} failed (set AAR_CLI to its CLI): ${
        error?.stderr?.toString().trim() || error?.message
      }`,
    );
  }
}

async function router(options) {
  if (!options.pools?.length) fail("router needs --pools NAME[,NAME]");
  const nodes = describeNodes(options);
  const pools = routerOwner("overview").pools ?? [];
  const poolIds = options.pools.map((wanted) => {
    const pool = pools.find((p) => p.id === wanted || p.name === wanted);
    if (!pool)
      fail(
        `no router pool "${wanted}"; have ${pools.map((p) => p.name).join(", ")}`,
      );
    return pool.id;
  });
  for (const node of nodes) {
    const client = await connect(node);
    const state = readState(node);
    const summary = (await client.expect("/api/agent-auth-router")).json;
    if (summary.state === "disconnected" || !state.routerIntegrationId) {
      if (summary.state !== "disconnected")
        await client.expect("/api/agent-auth-router/disconnect", {
          method: "POST",
        });
      // Pairing names every node "Yep Anywhere"; the new id is the one the
      // owner did not list before. Nodes pair one at a time for that reason.
      const before = new Set(
        routerOwner("overview").integrations.map((entry) => entry.id),
      );
      await client.expect("/api/agent-auth-router/connect", {
        method: "POST",
        body: {},
      });
      const created = routerOwner("overview").integrations.filter(
        (entry) => !before.has(entry.id),
      );
      if (created.length !== 1)
        throw new Error(
          `${node.name}: expected one new router integration, saw ${created.length}`,
        );
      state.routerIntegrationId = created[0].id;
      writeState(node, state);
    }
    const integration = routerOwner("overview").integrations.find(
      (entry) => entry.id === state.routerIntegrationId,
    );
    if (!integration)
      throw new Error(`${node.name}: its router integration no longer exists`);
    const granted = new Set(integration.poolIds);
    if (poolIds.some((id) => !granted.has(id)))
      routerOwner("grants/save", {
        id: integration.id,
        revision: integration.revision,
        poolIds: [...new Set([...integration.poolIds, ...poolIds])],
      });
    console.log(
      `${node.name}: router integration ${integration.id} granted ${options.pools.join(", ")}`,
    );
  }
}

async function disconnectRouter(node) {
  const state = readState(node);
  if (!state?.routerIntegrationId) return;
  try {
    const client = await connect(node);
    await client.expect("/api/agent-auth-router/disconnect", {
      method: "POST",
    });
    console.log(`${node.name}: disconnected from the router`);
  } catch (error) {
    console.log(
      `${node.name}: could not disconnect router integration ${state.routerIntegrationId}; revoke it in the router (${error?.message})`,
    );
  }
}

async function down(options) {
  const nodes = describeNodes(options);
  const records = recordedInstances();
  for (const node of nodes) {
    if (runningRecord(node, records)) {
      if (options.purge) await disconnectRouter(node);
      instance(["stop", "--profile", node.profile]);
      console.log(`${node.name}: stopped`);
    } else console.log(`${node.name}: not running`);
    if (options.purge) {
      const leftover = readState(node)?.routerIntegrationId;
      if (leftover && !runningRecord(node, records))
        console.log(
          `${node.name}: was stopped, so router integration ${leftover} is still granted; revoke it in the router`,
        );
      rmSync(node.dataDir, { recursive: true, force: true });
      console.log(`${node.name}: removed ${node.dataDir}`);
    }
  }
}

const options = parseArgs(process.argv.slice(2));
try {
  if (options.command === "up") await up(options);
  else if (options.command === "status") await status(options);
  else if (options.command === "smoke") await smoke(options);
  else if (options.command === "router") await router(options);
  else if (options.command === "down") await down(options);
  else {
    console.log(USAGE);
    process.exit(options.command === "help" ? 0 : 1);
  }
} catch (error) {
  fail(error?.stderr?.toString().trim() || error?.message || String(error));
}
