import { spawn, type ChildProcess } from "node:child_process";
import { randomInt } from "node:crypto";
import { realpath } from "node:fs/promises";
import { request } from "node:http";
import { connect } from "node:net";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  prepareSessionSandbox,
  sandboxPortBrokerSocketPath,
} from "../session-sandbox.js";
import { filterEnvForChildProcess } from "../sdk/providers/env-filter.js";
import {
  processTreeSpawnOptions,
  signalProcessTree,
} from "../utils/processTree.js";

export interface ProjectServiceCommand {
  projectPath: string;
  cwd: string;
  argv: string[];
  portEnv: string;
  readyPath: string;
  readyStatus: number;
  startupTimeoutMs: number;
  stopGraceMs: number;
  sandboxStateRoot?: string;
  basePath?: { env: string; value: string };
}

export type ProjectServiceProcessState =
  | "starting"
  | "running"
  | "stopping"
  | "stopped"
  | "failed";

/** One project service launch; no provider session or host TCP listener. */
export class ProjectServiceProcess {
  // Below every default ephemeral range (Linux 32768+, macOS and Windows
  // 49152+): outgoing connections inside the sandbox take their source ports
  // from that range, and one held 40614 when a CI service tried to listen.
  readonly port = randomInt(10_000, 32_768);
  state: ProjectServiceProcessState = "starting";
  error?: string;
  log = "";
  private child?: ChildProcess;
  private exited?: Promise<void>;
  private readonly startup = new AbortController();
  private stopping?: Promise<void>;
  private started = false;
  private stopRequested = false;

  constructor(
    private readonly command: ProjectServiceCommand,
    private readonly onSpawn?: (pid: number) => () => void,
  ) {}

  get brokerSocket(): string | undefined {
    return this.child?.pid && this.state === "running"
      ? sandboxPortBrokerSocketPath(this.child.pid)
      : undefined;
  }

  async start(): Promise<void> {
    if (this.started || this.state !== "starting")
      throw new Error("Project service launch has already been used");
    this.started = true;
    try {
      const root = await realpath(this.command.projectPath);
      const cwd = await realpath(resolve(root, this.command.cwd));
      const local = relative(root, cwd);
      if (isAbsolute(local) || local === ".." || local.startsWith(`..${sep}`))
        throw new Error("Project service working directory escapes project");
      const sandbox = await prepareSessionSandbox({
        level: "project-write",
        networkFirewall: true,
        provider: "claude",
        projectPath: root,
        stateRoot: this.command.sandboxStateRoot,
      });
      if (
        sandbox?.enforcement.state !== "enforced" ||
        sandbox.enforcement.networkFirewall !== true
      )
        throw new Error(
          "Project service requires an enforced sandbox firewall",
        );
      this.startup.signal.throwIfAborted();
      const environment = filterEnvForChildProcess(process.env);
      environment[this.command.portEnv] = String(this.port);
      if (this.command.basePath)
        environment[this.command.basePath.env] = this.command.basePath.value;
      // env changes cwd after Bubblewrap installs the anchored project mount.
      const wrapped = sandbox.wrapSpawn(
        "/usr/bin/env",
        [`--chdir=${cwd}`, "--", ...this.command.argv],
        environment,
      );
      let child: ChildProcess;
      try {
        child = spawn(wrapped.command, wrapped.args, {
          cwd: wrapped.cwd,
          env: wrapped.env,
          stdio: wrapped.stdio,
          ...processTreeSpawnOptions,
        });
      } finally {
        wrapped.release();
      }
      this.child = child;
      let releaseOwnership: (() => void) | undefined;
      child.stdin?.end();
      for (const [stream, source] of [
        [child.stdout, "stdout"],
        [child.stderr, "stderr"],
      ] as const) {
        stream?.on("data", (chunk: Buffer) => {
          this.log =
            `${this.log}[service ${source}] ${chunk.toString("utf8")}`.slice(
              -64 * 1024,
            );
        });
      }
      this.exited = new Promise((done) => {
        child.once("error", (error) => {
          this.error = error.message;
          this.state = "failed";
        });
        child.once("close", (code, signal) => {
          releaseOwnership?.();
          if (this.state === "stopping") this.state = "stopped";
          else {
            this.state = "failed";
            this.error ??= `Project service exited (${signal ?? code})`;
          }
          this.startup.abort();
          done();
        });
      });
      if (child.pid) releaseOwnership = this.onSpawn?.(child.pid);
      const deadline = Date.now() + this.command.startupTimeoutMs;
      while (Date.now() < deadline) {
        this.startup.signal.throwIfAborted();
        if (child.pid && (await this.probe(child.pid))) {
          this.startup.signal.throwIfAborted();
          this.state = "running";
          return;
        }
        await delay(100, undefined, { signal: this.startup.signal });
      }
      throw new Error("Project service readiness timed out");
    } catch (error) {
      const cancelled = this.stopRequested;
      if (!cancelled)
        this.error ??= error instanceof Error ? error.message : String(error);
      if (this.child) await this.stop();
      this.state = cancelled ? "stopped" : "failed";
      if (!cancelled && this.log.trim())
        this.error = `${this.error}\n${this.log.slice(-4096).trim()}`;
      throw new Error(this.error ?? "Project service start was cancelled");
    }
  }

  async isListening(): Promise<boolean> {
    const pid = this.child?.pid;
    return (
      !!pid && ((await this.probe(pid, true)) || (await this.probe(pid, true)))
    );
  }

  private probe(pid: number, acceptAnyStatus = false): Promise<boolean> {
    return new Promise((done) => {
      const req = request(
        {
          createConnection: () => {
            const socket = connect(sandboxPortBrokerSocketPath(pid));
            socket.write(`${this.port}\n`);
            return socket;
          },
          path: this.command.readyPath,
          method: "GET",
          headers: { host: `127.0.0.1:${this.port}` },
          signal: this.startup.signal,
        },
        (response) => {
          const ready =
            acceptAnyStatus || response.statusCode === this.command.readyStatus;
          response.destroy();
          done(ready);
        },
      );
      req.setTimeout(1000, () => {
        // A slow response does not establish a missing listener. Only startup
        // readiness treats a timeout as failure; an existing app stays alive.
        done(acceptAnyStatus);
        req.destroy();
      });
      req.once("error", () => done(false));
      req.once("close", () => done(false));
      req.end();
    });
  }

  stop(): Promise<void> {
    this.stopRequested = true;
    this.startup.abort();
    this.stopping ??= this.stopChild().finally(() => {
      this.stopping = undefined;
    });
    return this.stopping;
  }

  private async stopChild(): Promise<void> {
    const child = this.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) {
      this.state = "stopped";
      return;
    }
    this.state = "stopping";
    signalProcessTree(child, "SIGTERM");
    const timeout = new AbortController();
    try {
      await Promise.race([
        this.exited,
        delay(this.command.stopGraceMs, undefined, { signal: timeout.signal }),
      ]);
    } finally {
      timeout.abort();
    }
    if (child.exitCode === null && child.signalCode === null) {
      this.state = "failed";
      this.error = "Project service did not stop within its grace period";
      throw new Error(this.error);
    }
    this.state = "stopped";
  }
}
