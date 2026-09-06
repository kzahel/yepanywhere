// @vitest-environment node

import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

// The themed tooltip, the session hover card, and the risk affordance each own
// their module; the frontmost-surface contract follows them there rather than
// staying pinned to the legacy stylesheet.
const tooltipModuleUrl = new URL(
  "../../components/ui/TooltipLayer.module.css",
  import.meta.url,
);
const hovercardModuleUrl = new URL(
  "../../components/SessionHoverCard.module.css",
  import.meta.url,
);
const riskModuleUrl = new URL(
  "../../components/RiskAffordance.module.css",
  import.meta.url,
);

describe("themed tooltip CSS contract", () => {
  it("keeps passive hints frontmost and explicit reading interactive", async () => {
    const tooltipCss = await readFile(tooltipModuleUrl, "utf8");
    const hovercardCss = await readFile(hovercardModuleUrl, "utf8");
    const riskCss = await readFile(riskModuleUrl, "utf8");
    const declarations = /\.root\s*\{([^}]*)\}/.exec(tooltipCss)?.[1] ?? "";
    const surfaceDeclarations =
      /\.surface\s*\{([^}]*)\}/.exec(tooltipCss)?.[1] ?? "";
    const interactiveDeclarations =
      /\.interactive\s*\{([^}]*)\}/.exec(tooltipCss)?.[1] ?? "";
    const enlargedDeclarations =
      /\.enlarged\s*\{([^}]*)\}/.exec(tooltipCss)?.[1] ?? "";
    const glossaryEnlargedDeclarations =
      /\.glossary\.enlarged\s*\{([^}]*)\}/.exec(tooltipCss)?.[1] ?? "";
    const richRootDeclarations =
      /^\.tooltipVisible\s*\{([^}]*)\}/m.exec(riskCss)?.[1] ?? "";
    const richDeclarations =
      /^\.tooltip\s*\{([^}]*)\}/m.exec(riskCss)?.[1] ?? "";
    const hovercardDeclarations =
      /\.root\s*\{([^}]*)\}/.exec(hovercardCss)?.[1] ?? "";

    expect(declarations).toMatch(/position:\s*fixed\s*;/);
    expect(declarations).toMatch(/z-index:\s*2147483647\s*;/);
    expect(declarations).toMatch(/pointer-events:\s*none\s*;/);
    expect(declarations).toMatch(/user-select:\s*none\s*;/);
    expect(declarations).toMatch(/max-width:\s*min\(520px,/);
    expect(declarations).toMatch(/composes:\s*surface\s*;/);
    expect(surfaceDeclarations).toMatch(/font-weight:\s*500\s*;/);
    expect(interactiveDeclarations).toMatch(/pointer-events:\s*auto\s*;/);
    expect(interactiveDeclarations).toMatch(/user-select:\s*text\s*;/);
    expect(enlargedDeclarations).toMatch(
      /max-width:\s*min\(calc\(520px \+ 4\.25em\),/,
    );
    expect(enlargedDeclarations).toMatch(/max-height:\s*min\(/);
    expect(enlargedDeclarations).toMatch(
      /var\(--font-size-sm\)\s*\+\s*0\.5px\s*\+\s*var\(--tooltip-font-size-offset, 0px\)/,
    );
    expect(glossaryEnlargedDeclarations).toMatch(
      /var\(--font-size-sm\)\s*\+\s*1\.5px\s*\+\s*var\(--tooltip-font-size-offset, 0px\)/,
    );
    expect(richRootDeclarations).toMatch(/z-index:\s*2147483647\s*;/);
    expect(richDeclarations).toMatch(/z-index:\s*2147483647\s*;/);
    expect(hovercardDeclarations).toMatch(/z-index:\s*2147483647\s*;/);
    expect(hovercardDeclarations).toMatch(/pointer-events:\s*auto\s*;/);
  });
});
