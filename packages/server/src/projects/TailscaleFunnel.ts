import { execFile } from "node:child_process";
import { userInfo } from "node:os";
import { promisify } from "node:util";
import type { ProjectAppFunnel } from "@yep-anywhere/shared/project-service";
import { z } from "zod";

const run = promisify(execFile);
const TIMEOUT_MS = 15_000;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const FUNNEL_PORTS_CAP = "https://tailscale.com/cap/funnel-ports";

const statusSchema = z.object({
  Self: z.object({
    DNSName: z.string().min(1),
    CapMap: z.record(z.string(), z.unknown()).nullish(),
  }),
});
const serveSchema = z.object({
  Web: z
    .record(
      z.string(),
      z.object({
        Handlers: z
          .record(z.string(), z.object({ Proxy: z.string().optional() }))
          .nullish(),
      }),
    )
    .nullish(),
  AllowFunnel: z.record(z.string(), z.boolean()).nullish(),
});
const prefsSchema = z.object({ OperatorUser: z.string().optional() });

/**
 * This host's Tailscale Funnel, driven through the local `tailscale` CLI
 * (topics/project-service.md § Direct serving). Funnel publishes this
 * node's own name, so every app shares one hostname and differs by HTTPS
 * port. Changing it needs root or the node's operator user; YA never
 * elevates, and reports the one-time operator command instead.
 */
export class TailscaleFunnel {
  private cached?: {
    hostPort: number;
    at: number;
    value: Promise<ProjectAppFunnel | null>;
  };

  constructor(
    private readonly binary = "tailscale",
    private readonly ttlMs = 10_000,
  ) {}

  /** App info reads this often; three CLI runs each time would add up. */
  status(hostPort: number): Promise<ProjectAppFunnel | null> {
    const cached = this.cached;
    if (cached?.hostPort === hostPort && Date.now() - cached.at < this.ttlMs)
      return cached.value;
    const value = this.read(hostPort);
    this.cached = { hostPort, at: Date.now(), value };
    value.catch(() => {
      if (this.cached?.value === value) this.cached = undefined;
    });
    return value;
  }

  private async json(args: string[]): Promise<unknown> {
    const { stdout } = await run(this.binary, args, {
      timeout: TIMEOUT_MS,
      maxBuffer: MAX_OUTPUT_BYTES,
    });
    return JSON.parse(stdout);
  }

  /** Null when `tailscale` is not installed or this node is not logged in. */
  private async read(hostPort: number): Promise<ProjectAppFunnel | null> {
    let self: z.infer<typeof statusSchema>["Self"];
    try {
      self = statusSchema.parse(await this.json(["status", "--json"])).Self;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      if (error instanceof z.ZodError) return null;
      throw error;
    }
    const node = self.DNSName.replace(/\.$/, "");
    const serve = serveSchema.parse(
      await this.json(["funnel", "status", "--json"]),
    );
    const prefs = prefsSchema.parse(await this.json(["debug", "prefs"]));
    const user = userInfo().username;
    const urls: string[] = [];
    const busy: number[] = [];
    for (const [hostAndPort, web] of Object.entries(serve.Web ?? {})) {
      const handlers = Object.entries(web.Handlers ?? {});
      const ours =
        handlers.length === 1 &&
        handlers[0]?.[0] === "/" &&
        isLoopbackTarget(handlers[0][1].Proxy, hostPort);
      if (ours && serve.AllowFunnel?.[hostAndPort])
        urls.push(httpsUrl(hostAndPort));
      else if (!ours) busy.push(Number(hostAndPort.split(":").pop()));
    }
    return {
      host: `https://${node}/`,
      ports: funnelPorts(self.CapMap),
      urls: urls.sort(),
      busy: busy.sort((a, b) => a - b),
      ...(process.getuid?.() !== 0 && prefs.OperatorUser !== user
        ? { setupCommand: `sudo tailscale set --operator=${user}` }
        : {}),
    };
  }

  /** Publish `hostPort` on `httpsPort`, or stop publishing that HTTPS port. */
  async set(httpsPort: number, hostPort: number, on: boolean): Promise<void> {
    this.cached = undefined;
    await run(
      this.binary,
      on
        ? [
            "funnel",
            "--bg",
            "--yes",
            `--https=${httpsPort}`,
            `http://127.0.0.1:${hostPort}`,
          ]
        : ["funnel", `--https=${httpsPort}`, "off"],
      { timeout: TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES },
    );
  }
}

function isLoopbackTarget(proxy: string | undefined, port: number): boolean {
  if (!proxy) return false;
  try {
    const url = new URL(proxy);
    return (
      url.protocol === "http:" &&
      ["127.0.0.1", "localhost"].includes(url.hostname) &&
      url.port === String(port) &&
      url.pathname === "/"
    );
  } catch {
    return false;
  }
}

function httpsUrl(hostAndPort: string): string {
  const [host, port] = hostAndPort.split(/:(?=\d+$)/);
  return port === "443" ? `https://${host}/` : `https://${host}:${port}/`;
}

/** `funnel-ports?ports=443,8443,10000`, the form `tailscale status` reports. */
function funnelPorts(caps: Record<string, unknown> | null | undefined) {
  for (const key of Object.keys(caps ?? {})) {
    if (!key.startsWith(`${FUNNEL_PORTS_CAP}?`)) continue;
    const ports = new URLSearchParams(key.slice(key.indexOf("?") + 1))
      .get("ports")
      ?.split(",")
      .map(Number)
      .filter((port) => Number.isInteger(port) && port > 0);
    if (ports) return ports;
  }
  return [];
}
