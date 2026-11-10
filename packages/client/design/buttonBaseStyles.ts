/** ButtonBase is for rich targets, never a second button design system. */
import type { ControlOverride } from "./controlOverrides";
import {
  checkControlAllowlist,
  type OverrideAllowance,
} from "./controlOverrideAllowlist";

/** Split CSS values without mistaking spaces/commas inside color functions. */
function cssParts(value: string, comma = false): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i <= value.length; i++) {
    const char = value[i];
    if (char === "(") depth++;
    if (char === ")") depth--;
    if (
      i === value.length ||
      (depth === 0 && (comma ? char === "," : /\s/.test(char!)))
    ) {
      const part = value.slice(start, i).trim();
      if (part) parts.push(part);
      start = i + 1;
    }
  }
  return parts;
}

function unpainted(value: string): boolean {
  const text = value
    .replace(/\s*!important$/, "")
    .trim()
    .toLowerCase();
  if (/^(?:transparent|none|initial|unset|0(?:px)?)$/.test(text)) return true;
  if (/^#(?:[\da-f]{3}0|[\da-f]{6}00)$/.test(text)) return true;
  const color = /^(rgba?|hsla?)\((.*)\)$/.exec(text);
  if (!color) return false;
  const channels = cssParts(color[2]!, true);
  const alpha = color[2]!.includes("/")
    ? color[2]!.split("/").at(-1)
    : channels.length === 4
      ? channels[3]
      : undefined;
  return alpha !== undefined && /^0(?:\.0+)?%?$/.test(alpha.trim());
}

function paintedBorder(value: string): boolean {
  const parts = cssParts(value.replace(/\s*!important$/, ""));
  if (parts.some((p) => /^(?:none|hidden|0(?:px)?)$/i.test(p))) return false;
  // The shorthand's remaining token is the color; width/style alone imply
  // currentColor. A transparent token inside color-mix is not its color.
  const colors = parts.filter(
    (p) =>
      !/^(?:thin|medium|thick|solid|dashed|dotted|double|groove|ridge|inset|outset|[\d.]+[a-z%]+)$/i.test(
        p,
      ),
  );
  return colors.length === 0 || colors.some((color) => !unpainted(color));
}

export function buttonBaseStyleReason(
  row: ControlOverride,
): string | undefined {
  if (
    row.rules.some((rule) =>
      rule.properties.some((p) => p.startsWith("unresolved")),
    )
  )
    return "unresolved classes or styles";
  const declarations = row.rules.flatMap((rule) => rule.declarations ?? []);
  const variables = new Map<string, string[]>();
  for (const { property, value } of declarations)
    if (property.startsWith("--"))
      variables.set(property, [
        ...new Set([...(variables.get(property) ?? []), value]),
      ]);
  // Keep every state-dependent definition: choosing the last declaration could
  // hide a painted default behind a transparent disabled/selected state.
  const resolveValues = (value: string, seen = new Set<string>()): string[] => {
    const match = /var\(\s*(--[\w-]+)(?:,([^()]*))?\)/.exec(value);
    if (!match || seen.has(match[1]!)) return [value];
    const replacements =
      variables.get(match[1]!) ?? (match[2] === undefined ? [] : [match[2]]);
    if (!replacements.length) return [value];
    return replacements.flatMap((replacement) =>
      resolveValues(
        value.slice(0, match.index) +
          replacement +
          value.slice(match.index + match[0].length),
        new Set(seen).add(match[1]!),
      ),
    );
  };
  const paint = (value: string) =>
    resolveValues(value).some((resolved) => !unpainted(resolved));
  const background = declarations.some(
    ({ property, value }) =>
      /^background(?:-color|-image)?$/.test(property) && paint(value),
  );
  const border = declarations.some(
    ({ property, value }) =>
      /^border(?:-(?:top|right|bottom|left|inline|block)(?:-(?:start|end))?)?(?:-style)?$/.test(
        property,
      ) && resolveValues(value).some(paintedBorder),
  );
  const shadow = declarations.some(
    ({ property, value }) => property === "box-shadow" && paint(value),
  );
  // A zero-blur shadow ring is a painted border even without border CSS.
  const ring = declarations.some(
    ({ property, value }) =>
      property === "box-shadow" &&
      resolveValues(value).some((resolved) =>
        cssParts(resolved, true).some((shadow) => {
          const parts = cssParts(shadow).filter((p) => p !== "inset");
          const isLength = (part: string) => /^[-\d.]+(?:[a-z%]+)?$/.test(part);
          const dimensions = parts.filter(isLength);
          const color = parts.filter((part) => !isLength(part)).join(" ");
          return (
            dimensions.length === 4 &&
            dimensions.slice(0, 3).every((p) => /^0(?:px)?$/.test(p)) &&
            Number.parseFloat(dimensions[3]!) > 0 &&
            (!color || !unpainted(color))
          );
        }),
      ),
  );
  const radius = declarations.some(
    ({ property, value }) => /^border.*radius$/.test(property) && paint(value),
  );
  const padding = declarations.some(
    ({ property, value }) => /^padding(?:-.*)?$/.test(property) && paint(value),
  );
  if (background && (border || ring)) return "background and border";
  if (ring) return "box-shadow border ring";
  if (background && radius && padding) return "filled rounded padded chip";
  if (
    !background &&
    !border &&
    !shadow &&
    declarations.some(
      ({ property, value }) =>
        ((property === "text-decoration" ||
          property === "text-decoration-line") &&
          /underline/.test(value)) ||
        (property === "color" &&
          /var\(--(?:link-color|accent[\w-]*|primary-color|app-yep-green[\w-]*)\b/.test(
            resolveValues(value).join(" "),
          )),
    )
  )
    return "link/accent text without chrome";
  return undefined;
}

export function checkButtonBaseAllowlist(
  rows: ControlOverride[],
  allowlist: Record<string, OverrideAllowance>,
  record = false,
) {
  // Reuse the exact count/reason/only-lower contract of the ownership gate.
  const result = checkControlAllowlist(
    rows.filter((row) => buttonBaseStyleReason(row)),
    { buttons: {}, controls: allowlist },
    record,
  );
  return {
    problems: result.problems.map((p) =>
      p
        .replace("controls/", "ButtonBase/")
        .replace("controls:check", "buttons:check"),
    ),
    next: result.next.controls,
  };
}
