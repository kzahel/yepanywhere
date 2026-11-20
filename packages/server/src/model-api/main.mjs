import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import { serve } from "@hono/node-server";
import { createModelApi } from "./routes.mjs";

const phase = "[model-api]";

async function start() {
  const env = process.env;
  const modulePath = env.YA_MODEL_API_PI_MODULE;
  const tokenFile = env.YA_MODEL_API_TOKEN_FILE;
  const modelIds = [
    ...new Set(
      (env.YA_MODEL_API_MODELS ?? "")
        .split(",")
        .map((id) => id.trim())
        .filter(Boolean),
    ),
  ];
  const port = Number(env.YA_MODEL_API_PORT ?? "3410");
  if (
    !modulePath ||
    !isAbsolute(modulePath) ||
    !tokenFile ||
    !isAbsolute(tokenFile) ||
    modelIds.length === 0
  ) {
    throw new Error(
      "Set YA_MODEL_API_PI_MODULE, YA_MODEL_API_TOKEN_FILE, and YA_MODEL_API_MODELS.",
    );
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("Invalid YA_MODEL_API_PORT.");
  const token = (await readFile(tokenFile, "utf8")).trim();
  if (!/^[A-Za-z0-9_-]{32,}$/u.test(token))
    throw new Error(
      "The model API token must be at least 32 URL-safe characters.",
    );

  const { ModelRuntime } = await import(pathToFileURL(modulePath).href);
  const runtime = await ModelRuntime.create({
    allowModelNetwork: false,
    modelsStorePath: join(dirname(tokenFile), "pi-models-store.json"),
  });
  const models = new Map();
  for (const id of modelIds) {
    const slash = id.indexOf("/");
    const model =
      slash > 0 && runtime.getModel(id.slice(0, slash), id.slice(slash + 1));
    if (!model) throw new Error(`Unknown configured Pi model ${id}.`);
    models.set(id, model);
  }
  const app = createModelApi({ models, runtime, token });
  const server = serve(
    { fetch: app.fetch, hostname: "127.0.0.1", port },
    (address) => {
      process.stdout.write(
        `${phase} Listening at http://127.0.0.1:${address.port}/v1\n`,
      );
    },
  );
  server.on("error", (error) => {
    process.stderr.write(`${phase} ${error.code ?? "listener failed"}\n`);
    process.exitCode = 1;
  });
  for (const signal of ["SIGTERM", "SIGINT"]) {
    process.once(signal, () => {
      server.close();
      server.closeAllConnections();
      runtime.settleCredentialWrites?.().catch(() => {
        process.stderr.write(`${phase} Pi credential writes did not settle.\n`);
        process.exitCode = 1;
      });
    });
  }
}

start().catch((error) => {
  process.stderr.write(`${phase} ${error.message}\n`);
  process.exitCode = 1;
});
