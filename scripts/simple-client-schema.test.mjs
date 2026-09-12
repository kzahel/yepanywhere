import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { validateSimpleClientSchema } from "./lib/simple-client-schema.mjs";

const source = JSON.parse(
  readFileSync(
    new URL(
      "../packages/shared/contracts/simple-client.schema.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
test("accepts the bounded contract vocabulary", () =>
  validateSimpleClientSchema(source));
const mutations = {
  "unimplemented string constraint": (d) => {
    d.Id.format = "uuid";
  },
  "ignored ref sibling": (d) => {
    d.Conversation.properties.sessionId.maxLength = 2;
  },
  "missing collection limit": (d) => {
    delete d.Conversation.properties.messages.maxItems;
  },
  "optional fields": (d) => {
    d.Conversation.required.pop();
  },
  "inline enum bypassing Kotlin validation": (d) => {
    d.Conversation.properties.activity = { type: "string", enum: ["idle"] };
  },
  "overlapping fallback": (d) => {
    d.Content.oneOf.at(-1).properties.kind.not.enum.pop();
  },
  "unimplemented fallback constraint": (d) => {
    d.Content.oneOf.at(-1).minProperties = 2;
  },
  "nullable constraint ignored": (d) => {
    d.ConversationQuery.properties.anchorMessageId.anyOf[1].const = null;
  },
  "unbounded integer": (d) => {
    d.SnapshotEnvelope.properties.sequence.maximum = Number.MAX_SAFE_INTEGER;
  },
};
for (const [name, mutate] of Object.entries(mutations)) {
  test(`rejects ${name}`, () => {
    const schema = structuredClone(source);
    mutate(schema.$defs);
    assert.throws(() => validateSimpleClientSchema(schema));
  });
}
