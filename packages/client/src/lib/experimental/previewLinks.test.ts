import { expect, it } from "vitest";
import { previewFullClientPath } from "./previewLinks";
import type { SavedHost } from "../hostStorage";
const host: SavedHost = {
  id: "h",
  displayName: "Machine",
  mode: "direct",
  srpUsername: "test",
  createdAt: "",
};
const session = { projectId: "project/a", id: "session/b" };
it("keeps full-client handoffs on the selected machine and deployment base", () => {
  expect(
    previewFullClientPath(
      { id: "local", displayName: "localhost", mode: "local" },
      session,
    ),
  ).toBe("/projects/project%2Fa/sessions/session%2Fb");
  expect(
    previewFullClientPath(
      { ...host, wsUrl: "wss://machine.example/ya/api/ws" },
      session,
    ),
  ).toBe(
    "https://machine.example/ya/projects/project%2Fa/sessions/session%2Fb",
  );
  expect(
    previewFullClientPath(
      { ...host, mode: "relay", relayUsername: "machine" },
      session,
    ),
  ).toBe("/-/relay/machine/projects/project%2Fa/sessions/session%2Fb");
  expect(
    previewFullClientPath({ ...host, wsUrl: "ws://machine.example/api/ws" }),
  ).toBe("http://machine.example/");
});
it.each([
  "javascript:alert(1)",
  "wss://name:password@machine.example/api/ws",
  "wss://machine.example/unknown-path",
])("does not guess a client location from %s", (wsUrl) => {
  expect(previewFullClientPath({ ...host, wsUrl }, session)).toBeNull();
});
