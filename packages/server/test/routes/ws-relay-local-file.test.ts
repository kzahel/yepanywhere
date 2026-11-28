import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { HttpBindings } from "@hono/node-server";
import type { RelayResponse, YepMessage } from "@yep-anywhere/shared";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getAuthenticatedSrpTransport } from "../../src/middleware/authenticated-transport.js";
import { createLocalFileRoutes } from "../../src/routes/local-file.js";
import {
  createConnectionState,
  handleRequest,
} from "../../src/routes/ws-relay-handlers.js";

describe("WebSocket relay local-file requests", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "yep-relay-local-file-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("returns local-file route responses through an authenticated relay", async () => {
    const allowedDir = path.join(tempDir, "allowed");
    await mkdir(allowedDir, { recursive: true });

    const filePath = path.join(allowedDir, "probe.json");
    await writeFile(filePath, '{"ok":true}');

    const app = new Hono<{ Bindings: HttpBindings }>();
    app.route(
      "/api/local-file",
      createLocalFileRoutes({
        allowedPaths: [allowedDir],
      }),
    );

    const sent: YepMessage[] = [];
    const connState = createConnectionState();
    connState.authState = "authenticated";
    connState.sessionKey = new Uint8Array(32);

    await handleRequest(
      {
        type: "request",
        id: "local-file-1",
        method: "GET",
        path: `/api/local-file?path=${encodeURIComponent(filePath)}`,
      },
      (message) => sent.push(message),
      { send: () => {}, close: () => {} },
      app,
      "http://localhost",
      connState,
    );

    expect(sent).toHaveLength(1);
    const response = sent[0] as RelayResponse;
    expect(response).toMatchObject({
      body: { ok: true },
      id: "local-file-1",
      status: 200,
      type: "response",
    });
    expect(response.headers?.["content-type"]).toBe(
      "application/json; charset=utf-8",
    );
  });

  it("injects proof context only for established SRP transport", async () => {
    const app = new Hono<{ Bindings: HttpBindings }>();
    app.get("/inspect", (c) =>
      c.json({
        hasSrpContext: !!getAuthenticatedSrpTransport(c.env),
      }),
    );
    const ws = { send: () => {}, close: () => {} };
    const trustedState = createConnectionState();
    trustedState.connectionPolicy = "local_cookie_trusted";
    trustedState.authState = "authenticated";
    const trustedResponses: YepMessage[] = [];

    await handleRequest(
      {
        type: "request",
        id: "trusted",
        method: "GET",
        path: "/inspect",
        headers: {
          "X-Security-Client-Transport": "srp",
        },
      },
      (message) => trustedResponses.push(message),
      ws,
      app,
      "http://localhost",
      trustedState,
    );

    expect(trustedResponses[0]).toMatchObject({
      body: { hasSrpContext: false },
    });

    const srpState = createConnectionState({
      transport: "relay",
    });
    srpState.authState = "authenticated";
    srpState.sessionKey = new Uint8Array(32);
    srpState.username = "testuser";
    srpState.sessionId = "session-id";
    srpState.transportNonce = "fresh-transport-nonce";
    srpState.authenticationMethod = "srp-resume";
    const srpResponses: YepMessage[] = [];

    await handleRequest(
      {
        type: "request",
        id: "srp",
        method: "GET",
        path: "/inspect",
      },
      (message) => srpResponses.push(message),
      ws,
      app,
      "http://localhost",
      srpState,
    );

    expect(srpResponses[0]).toMatchObject({
      body: { hasSrpContext: true },
    });
  });
});
