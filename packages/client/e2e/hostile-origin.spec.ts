import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, test } from "./fixtures.js";

// Security regression guard. Any web page can give itself the opaque
// `Origin: null` by framing a sandboxed srcdoc iframe. YA once trusted that
// origin for credentialed CORS and WebSocket upgrades (93ca8e3df, 80b1a440f),
// which let any page a local user opened drive an unauthenticated server.
//
// The attacker page is served by a real loopback listener so browser
// local-network protections cannot be what blocks the probe (a routed,
// in-process response has no loopback address); the unsandboxed control frame
// proves the same probe reaches and reads the server.

// Plain source string: page.evaluate must not receive transpiler helpers.
const PROBE = `
async function probe(base, wsUrl) {
  const out = {};
  try {
    const response = await fetch(base + "/api/version", {
      credentials: "include",
      headers: { "X-Yep-Anywhere": "true" },
    });
    out.http = "status " + response.status;
  } catch {
    out.http = "blocked";
  }
  out.ws = await new Promise((resolve) => {
    const socket = new WebSocket(wsUrl);
    const timer = setTimeout(() => resolve("timeout"), 5000);
    socket.onopen = () =>
      socket.send(JSON.stringify({
        type: "request",
        id: "probe",
        method: "GET",
        path: "/health",
        headers: { "X-Yep-Anywhere": "true" },
      }));
    socket.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.type === "response" && message.id === "probe") {
        clearTimeout(timer);
        resolve("response " + message.status);
        socket.close();
      }
    };
    socket.onclose = (event) => {
      clearTimeout(timer);
      resolve("closed " + event.code);
    };
  });
  parent.postMessage(out, "*");
}`;

interface ProbeResult {
  http: string;
  ws: string;
}

test.describe("hostile browser origins", () => {
  let attacker: Server;
  let attackerPage: string;

  test.beforeAll(async () => {
    attacker = createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<!doctype html><title>attacker</title>");
    });
    await new Promise<void>((resolve) =>
      attacker.listen(0, "127.0.0.1", resolve),
    );
    const { port } = attacker.address() as AddressInfo;
    attackerPage = `http://127.0.0.1:${port}/attacker.html`;
  });

  test.afterAll(async () => {
    await new Promise((resolve) => attacker.close(resolve));
  });

  test("a sandboxed iframe cannot read or drive the server", async ({
    page,
    baseURL,
    wsURL,
  }) => {
    await page.goto(attackerPage);

    const run = (sandboxed: boolean) =>
      page.evaluate(
        ({ sandboxed, base, wsUrl, source }) =>
          new Promise<ProbeResult>((resolve) => {
            const frame = document.createElement("iframe");
            if (sandboxed) frame.setAttribute("sandbox", "allow-scripts");
            window.addEventListener("message", function onMessage(event) {
              if (event.source !== frame.contentWindow) return;
              window.removeEventListener("message", onMessage);
              frame.remove();
              resolve(event.data as ProbeResult);
            });
            frame.srcdoc = `<script>${source}\nprobe(${JSON.stringify(
              base,
            )}, ${JSON.stringify(wsUrl)});</script>`;
            document.body.append(frame);
          }),
        { sandboxed, base: baseURL, wsUrl: wsURL, source: PROBE },
      );

    // Control: the frame inherits the attacker page's loopback origin.
    expect(await run(false)).toEqual({
      http: "status 200",
      ws: "response 200",
    });
    // Attack: the same frame sandboxed sends `Origin: null`. The socket closes
    // with 4003 from the origin check, or fails its upgrade (1006) when an
    // earlier spec in the shared run registered an artifact origin.
    const attack = await run(true);
    expect(attack.http).toBe("blocked");
    expect(attack.ws).toMatch(/^closed (4003|1006)$/);
  });
});
