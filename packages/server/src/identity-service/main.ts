import { readFile } from "node:fs/promises";
import { createServer } from "node:https";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { serve } from "@hono/node-server";
import { getConnInfo } from "@hono/node-server/conninfo";
import { enforceOwnerOnlyPathPermissionsStrict } from "../utils/filePermissions.js";
import { oidcProvidersSchema } from "./oidc.js";
import { identityServiceOrigin } from "./crypto.js";
import { createIdentityService } from "./service.js";
import { IdentityServiceStore } from "./store.js";

export async function passwordFromStdin(
  input: AsyncIterable<Uint8Array> = process.stdin,
) {
  if (input === process.stdin && process.stdin.isTTY)
    throw new Error(
      "Read the password from private stdin, not arguments or an interactive terminal",
    );
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for await (const chunk of input) {
    bytes += chunk.byteLength;
    chunks.push(chunk);
    if (bytes > 256) throw new Error("Password input exceeds its byte bound");
  }
  return new TextDecoder("utf-8", { fatal: true })
    .decode(Buffer.concat(chunks))
    .replace(/\r?\n$/, "");
}

/** Offline administration and serving intentionally share exclusive ownership. */
export async function identityServiceMain(args = process.argv.slice(2)) {
  const { positionals, values } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      directory: { type: "string" },
      issuer: { type: "string" },
      "fixture-http": { type: "boolean", default: false },
      "tls-cert": { type: "string" },
      "tls-key": { type: "string" },
      "oidc-config": { type: "string" },
    },
  });
  if (!values.directory || !values.issuer)
    throw new Error(
      "Usage: identity-service --directory PRIVATE_DIR --issuer HTTPS_ORIGIN serve|local-account USERNAME|oidc-account ISSUER SUBJECT NAME",
    );
  const issuer = identityServiceOrigin(values.issuer, values["fixture-http"]);
  const store = new IdentityServiceStore(
    resolve(values.directory),
    issuer,
    values["fixture-http"],
  );
  await store.initialize();
  try {
    if (positionals[0] === "revoke-client" && positionals[1]) {
      await store.revokeClient(positionals[1]);
      await store.close();
      return;
    }
    if (positionals[0] === "rotate-signing-key") {
      await store.rotateSigningKey();
      await store.close();
      return;
    }
    if (positionals[0] === "forget-signing-key" && positionals[1]) {
      await store.forgetSigningKey(positionals[1]);
      await store.close();
      return;
    }
    if (positionals[0] === "local-account" && positionals[1]) {
      const id = await store.provisionLocal(
        positionals[1],
        await passwordFromStdin(),
      );
      process.stdout.write(`Local account ${id} provisioned\n`);
      await store.close();
      return;
    }
    if (
      positionals[0] === "oidc-account" &&
      positionals[1] &&
      positionals[2] &&
      positionals[3]
    ) {
      const id = await store.provisionOidc(
        positionals[1],
        positionals[2],
        positionals[3],
      );
      process.stdout.write(`External account ${id} provisioned\n`);
      await store.close();
      return;
    }
    if (positionals[0] !== "serve")
      throw new Error("Unknown identity service command");
    let oidcProviders: unknown;
    if (values["oidc-config"]) {
      const path = resolve(values["oidc-config"]);
      await enforceOwnerOnlyPathPermissionsStrict(path, "file");
      const content = await readFile(path);
      if (content.byteLength > 64 * 1024)
        throw new Error("Oversized OIDC configuration");
      oidcProviders = oidcProvidersSchema.parse(
        JSON.parse(content.toString("utf8")),
      );
    }
    const service = createIdentityService(store, {
        oidcProviders,
        remoteAddress: (c) => getConnInfo(c).remote.address,
      }),
      url = new URL(issuer);
    const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
    const server =
      url.protocol === "https:"
        ? serve({
            fetch: service.app.fetch,
            hostname: url.hostname,
            port,
            createServer,
            serverOptions: {
              cert: await readFile(values["tls-cert"] ?? ""),
              key: await readFile(values["tls-key"] ?? ""),
            },
          })
        : serve({ fetch: service.app.fetch, hostname: "127.0.0.1", port });
    const stop = () => {
      server.close(() => {
        void store.close();
      });
      if ("closeAllConnections" in server) server.closeAllConnections();
    };
    process.once("SIGTERM", stop);
    process.once("SIGINT", stop);
  } catch (error) {
    await store.close();
    throw error;
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  void identityServiceMain().catch(() => {
    process.stderr.write(
      "Identity Service command failed; check ownership, private configuration and account input\n",
    );
    process.exitCode = 1;
  });
}
