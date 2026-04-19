import assert from "node:assert/strict";
import { createServer } from "node:net";
import test from "node:test";
import { findAvailablePort } from "./dev-port.js";

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

test("findAvailablePort returns the preferred port when it is free", async () => {
  const port = await findAvailablePort(0);
  assert.equal(typeof port, "number");
  assert.ok(port >= 0);
});

test("findAvailablePort skips occupied ports", async () => {
  const occupiedA = createServer();
  const occupiedB = createServer();

  await listen(occupiedA, 45120);
  await listen(occupiedB, 45121);

  try {
    const port = await findAvailablePort(45120);
    assert.equal(port, 45122);
  } finally {
    await close(occupiedA);
    await close(occupiedB);
  }
});
