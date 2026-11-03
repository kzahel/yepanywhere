import { describe, expect, it } from "vitest";
import { createRelayApiError } from "../lib/connection/RelayProtocol";
import { isHandoffRequiredRefusal } from "./refusal";

const relayError = (body: unknown) =>
  createRelayApiError({
    type: "response",
    id: "request",
    status: 409,
    headers: {},
    body,
  });

describe("isHandoffRequiredRefusal", () => {
  it("accepts the resume guard's refusal by field or by its text", () => {
    expect(
      isHandoffRequiredRefusal(
        relayError({ error: "unsafe tail", recovery: "handoff-required" }),
      ),
    ).toBe(true);
    expect(
      isHandoffRequiredRefusal(
        relayError({ error: "… Start a handoff session instead." }),
      ),
    ).toBe(true);
  });

  it("leaves other 409s, such as a router account refusal, to their own message", () => {
    expect(
      isHandoffRequiredRefusal(
        relayError({
          error:
            "The pinned router account (kyle) needs to sign in again: its login in AAR expired or was cleared.",
        }),
      ),
    ).toBe(false);
    expect(
      isHandoffRequiredRefusal(
        relayError({ error: "compaction failed", recovery: "full-resume" }),
      ),
    ).toBe(false);
  });
});
