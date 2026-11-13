import { expect, it } from "vitest";
import { assertTargetPath } from "../../src/core-api/http-contracts.js";

it("confines opaque requests before URL normalization without rewriting their query", () => {
  const root = "/v0/servers/worker";
  expect(() =>
    assertTargetPath(
      `${root}/future-operation?cwd=C%3A%5Cwork&tag=a&tag=b`,
      "worker",
    ),
  ).not.toThrow();
  for (const path of [
    "/v0/servers/other/sessions",
    "/api/sessions",
    "https://other.invalid/v0/servers/worker",
    `${root}/../other/sessions`,
    `${root}/%2e%2e/other`,
    `${root}/%252e%252e/other`,
    `${root}/%2fapi`,
    `${root}/%5capi`,
    `${root}/bad%zz`,
    `${root}/sessions#fragment`,
  ])
    expect(() => assertTargetPath(path, "worker"), path).toThrow();
});
