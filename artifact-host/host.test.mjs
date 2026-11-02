import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { MANAGED_ARTIFACT_MAX_FILE_BYTES } from "../packages/shared/dist/artifact-viewer.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { serve } from "./host.mjs";
import { loadShellAssets } from "./assets.mjs";
const origin =
  "https://artifact-0123456789abcdef0123456789abcdef.yepanywhere.com";
const assets = {
  "bootstrap.js": "bootstrap bytes",
  "worker.js": "worker bytes",
  "frame.js": "frame bytes",
};
const bootstrap =
  "/__ya/1/bootstrap.html?viewer=0123456789abcdef0123456789abcdef&parent=https%3A%2F%2Flatest.yepanywhere.com";
test("content host serves only fixed files on reserved hosts and allowed parents", async () => {
  const response = serve(new Request(origin + bootstrap), assets);
  assert.equal(response.status, 200);
  assert.match(
    response.headers.get("content-security-policy"),
    /frame-ancestors https:\/\/yepanywhere.com https:\/\/latest.yepanywhere.com/,
  );
  assert.equal(response.headers.get("origin-agent-cluster"), "?1");
  assert.match(
    await response.text(),
    /name="ya-parent-origin" content="https:\/\/latest.yepanywhere.com"/,
  );
  for (const path of [
    "/v/anything/index.html",
    "/api/version",
    "/__ya/2/worker.js",
    "/",
  ])
    assert.equal(serve(new Request(origin + path), assets).status, 404);
  assert.equal(
    serve(new Request("https://relay.yepanywhere.com" + bootstrap), assets)
      .status,
    404,
  );
  assert.equal(
    serve(
      new Request(
        origin + bootstrap.replace("latest.yepanywhere.com", "evil.example"),
      ),
      assets,
    ).status,
    400,
  );
  assert.equal(
    serve(new Request(origin + bootstrap, { method: "POST" }), assets).status,
    404,
  );
});
test("worker scope and HEAD stay bounded independently of artifact contents", async () => {
  const script = serve(new Request(origin + "/__ya/1/worker.js"), assets);
  assert.equal(await script.text(), "worker bytes");
  assert.equal(script.headers.get("service-worker-allowed"), "/v/");
  const head = serve(
    new Request(origin + "/__ya/1/frame.js", { method: "HEAD" }),
    assets,
  );
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");
});

test("the store extension is admitted by bootstrap and worker policies without admitting other extensions", async () => {
  const { id } = JSON.parse(
    await readFile(
      new URL(
        "../docs/distribution/chrome-extension/identity.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  const parent = `chrome-extension://${id}`;
  const url = new URL(origin + bootstrap);
  url.searchParams.set("parent", parent);
  const response = serve(new Request(url), assets);
  assert.equal(response.status, 200);
  assert.ok(response.headers.get("content-security-policy").includes(parent));
  assert.ok((await response.text()).includes(`content="${parent}"`));
  const shell = await loadShellAssets();
  const policy = runInNewContext(`${shell["worker.js"]}\nPOLICY`, {
    self: { addEventListener() {} },
  });
  assert.ok(policy.includes(parent));
  assert.ok(!policy.includes("chrome-extension: "));
  assert.ok(!policy.includes("chrome-extension://*"));
  url.searchParams.set(
    "parent",
    "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  );
  assert.equal(serve(new Request(url), assets).status, 400);
});

test("the standalone worker's file bound matches the server and parent", async () => {
  const source = await readFile(
    new URL("./worker.js", import.meta.url),
    "utf8",
  );
  const bound = runInNewContext(`${source}\nMAX_FILE_BYTES`, {
    self: { addEventListener() {} },
  });
  assert.equal(bound, MANAGED_ARTIFACT_MAX_FILE_BYTES);
});
