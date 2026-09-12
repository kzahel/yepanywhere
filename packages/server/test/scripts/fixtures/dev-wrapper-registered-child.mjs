#!/usr/bin/env node
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { createConnection, createServer } from "node:net";

const role = process.argv[process.argv.indexOf("--filter") + 1]
  .split("/")
  .pop();
const generation = process.env.YEP_SERVER_GENERATION;
const token = process.env.YEP_DEV_WRAPPER_TOKEN;
const port = Number(process.env.YEP_DEV_WRAPPER_PORT);
// Vite has a child (for example esbuild) in addition to the shell/pnpm chain.
const descendant =
  role === "client"
    ? spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
        stdio: "ignore",
      })
    : undefined;
if (descendant && process.platform !== "win32") {
  process.on("SIGTERM", () => {
    descendant.once("exit", () => process.exit(0));
    descendant.kill("SIGTERM");
  });
}
const control = createServer((socket) => {
  socket.on("data", () => {
    socket.end();
    socket.once("close", () => process.exit(0));
  });
});
await new Promise((resolve) => control.listen(0, "127.0.0.1", resolve));
if (role === "server") {
  await new Promise((resolve, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    let response = "";
    socket.setTimeout(2_000, () =>
      socket.destroy(new Error("register timeout")),
    );
    socket.on("error", reject);
    socket.on("connect", () => {
      socket.write(
        `${JSON.stringify({
          op: "registerBackend",
          token,
          generation,
          pid: process.pid,
        })}\n`,
      );
    });
    socket.on("data", (chunk) => {
      response += chunk;
      if (!response.includes("\n")) return;
      socket.destroy();
      const result = JSON.parse(response);
      if (result.ok) resolve();
      else reject(new Error(result.error));
    });
  });
}
appendFileSync(
  process.env.YA_TEST_WRAPPER_EVENTS,
  `${JSON.stringify({
    role,
    pid: process.pid,
    descendantPid: descendant?.pid,
    generation,
    port,
    token,
    controlPort: control.address().port,
  })}\n`,
);
