// @vitest-environment node
import { expect, it } from "vitest";
import { scanButtonSource } from "./buttonElements";

it("counts raw roles without treating shared button links as exceptions", () => {
  const rows = scanButtonSource(
    "Owner.tsx",
    `<>
    <Link role="button" className={buttonClassName({variant: "ghost"})} />
    <ButtonBase role="button" />
    <div role="button" className="custom" />
    <button role="button" />
  </>`,
  );
  expect(rows.map((row) => [row.tag, row.kind])).toEqual([
    ["div", "role-button"],
    ["button", "raw"],
  ]);
});
