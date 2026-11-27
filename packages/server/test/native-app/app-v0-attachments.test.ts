import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { appBarrier } from "../native-provider/app-fixture.js";
import { apiCommand } from "../support/api-command-request.js";
import { nativeAppTestFixture } from "./fixture.js";
import { quoteShellWord } from "../../src/utils/posixShell.js";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO/Sx4sAAAAASUVORK5CYII=",
  "base64",
);
const note = Buffer.from("OWNED_ATTACHMENT_TEXT");
const digest = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");

function filePath(body: unknown, name: string): string | undefined {
  if (typeof body === "string")
    return body.split(`- [${name}](<`)[1]?.split(">)")[0];
  if (body && typeof body === "object")
    return Object.values(body)
      .map((value) => filePath(value, name))
      .find(Boolean);
}

describe.runIf(process.env.YEP_NATIVE_APP_TESTS === "1")(
  "native v0 attachments",
  () => {
    it.for(["claude", "codex"] as const)(
      "%s receives materialized image and file references at creation and in a queued prompt",
      { timeout: 80_000 },
      async (provider, context) => {
        const f = await nativeAppTestFixture(provider, context, {
          agentApiManagement: true,
        });
        await f.ready();
        const { project } = await f.api("/projects", { path: f.project });
        const base = `${f.baseUrl}/v0/servers/self`;
        const get = async (path: string) => {
          const response = await fetch(base + path, { signal: context.signal });
          expect(response.status, await response.clone().text()).toBe(200);
          return response.json();
        };
        const post = async (path: string, body: object) => {
          const request = apiCommand(body);
          const response = await fetch(base + path, {
            ...request,
            method: "POST",
            headers: { ...request.headers, "X-Yep-Anywhere": "true" },
            signal: context.signal,
          });
          expect(response.status, await response.clone().text()).toBe(202);
          return response.json();
        };
        const upload = (name: string, mimeType: string, data: Buffer) =>
          post(`/projects/${project.id}/attachments?offset=0`, {
            requestId: `native-file-${name}`,
            name,
            mimeType,
            size: data.length,
            sha256: digest(data),
            data: data.toString("base64"),
          });
        const image = await upload("screenshot.png", "image/png", png);
        const text = await upload("notes.txt", "text/plain", note);
        const creation = {
          requestId: "native-file-create",
          projectId: project.id,
          provider,
          prompt: "",
          permissionMode: "bypassPermissions",
          model: provider === "claude" ? "claude-haiku-5-5" : "gpt-6.1-sol",
          attachmentIds: [image.attachmentId, text.attachmentId],
        };
        const { id } = await post("/sessions", creation);
        expect(await post("/sessions", creation)).toMatchObject({ id });
        const initial = await f.model.next();
        const created = await appBarrier(async () => {
          const receipt = await get(`/receipts/${id}`);
          return receipt.state === "accepted" && receipt;
        }, "native attachment creation accepted");
        const imagePath = filePath(initial.body, "screenshot.png");
        const textPath = filePath(initial.body, "notes.txt");
        expect(imagePath).toBeTruthy();
        expect(textPath).toBeTruthy();
        expect(await readFile(imagePath!)).toEqual(png);
        expect(await readFile(textPath!)).toEqual(note);

        const input = {
          requestId: "native-file-followup",
          type: "prompt",
          text: "Check the attached screenshot",
          attachmentIds: [image.attachmentId],
        };
        const inputPath = `/sessions/${created.sessionId}/inputs`;
        const queued = await post(inputPath, input);
        expect(queued).toMatchObject({
          state: "accepted",
          input: { status: "queued" },
        });
        expect(await post(inputPath, input)).toMatchObject({ id: queued.id });
        initial.finish("INITIAL_ATTACHMENTS_OBSERVED");
        const followup = await f.model.next();
        const followupPath = filePath(followup.body, "screenshot.png");
        expect(followupPath).toBeTruthy();
        // Exercise the launch-bound controller bridge from the real provider tool.
        const script = join(f.project, "check-attachment.cjs");
        await writeFile(
          script,
          `
const { request } = require("node:http"), { readFileSync } = require("node:fs"), { createHash } = require("node:crypto");
function post(path, key, body) {
  return new Promise((resolve, reject) => {
    const options = {
      method: "POST",
      socketPath: process.env.AGENT_YA_V0_SOCKET,
      headers: { Authorization: process.env.AGENT_YA_V0_AUTHORIZATION, "Content-Type": "application/json", "Idempotency-Key": key },
    };
    const req = request(new URL(path, process.env.AGENT_YA_V0_URL), options, (response) => {
      let text = "";
      response.on("data", (chunk) => { text += chunk; });
      response.on("end", () => response.statusCode === 202 ? resolve(JSON.parse(text)) : reject(new Error(text)));
    });
    req.on("error", reject);
    req.setTimeout(10_000, () => req.destroy(new Error("launch API timed out")));
    req.end(JSON.stringify(body));
  });
}
(async () => {
  const data = readFileSync(${JSON.stringify(followupPath)});
  const sha256 = createHash("sha256").update(data).digest("hex");
  const base = "/v0/servers/self";
  const { attachmentId } = await post(base + ${JSON.stringify(`/projects/${project.id}/attachments?offset=0`)}, "native-launch-upload", {
    name: "tool-upload.png", mimeType: "image/png", size: data.length, sha256, data: data.toString("base64"),
  });
  await post(base + ${JSON.stringify(inputPath)}, "native-launch-followup", {
    type: "prompt", text: "LAUNCH_BOUND_ATTACHMENT", attachmentIds: [attachmentId],
  });
  console.log("LAUNCH_BOUND_ATTACHMENT_STAGED", sha256);
})().catch((error) => { console.error(error.message); process.exitCode = 1; });
`,
        );
        const command = `${quoteShellWord(process.execPath)} ${quoteShellWord(script)}`;
        if (provider === "claude")
          followup.tool("Bash", {
            command,
            description: "Read the provided screenshot",
          });
        else
          followup.tool(
            "exec",
            `const r=await tools.exec_command({cmd:${JSON.stringify(command)}});text(r.output);`,
          );
        const afterTool = await f.model.next();
        expect(JSON.stringify(afterTool.body)).toContain(
          `LAUNCH_BOUND_ATTACHMENT_STAGED ${digest(png)}`,
        );
        afterTool.finish("FOLLOWUP_ATTACHMENT_READ");
        const nested = await f.model.next();
        const nestedPath = filePath(nested.body, "tool-upload.png");
        expect(nestedPath).toBeTruthy();
        expect(await readFile(nestedPath!)).toEqual(png);
        nested.finish("LAUNCH_BOUND_ATTACHMENT_READ");
        await appBarrier(async () => {
          const receipt = await get(`/receipts/${queued.id}`);
          return receipt.delivery === "consumed" && receipt;
        }, "queued attachment consumed by provider");
      },
    );
  },
);
