import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const projectionDirectory = resolve(process.cwd(), "../shared/src/transcript");
const legacyFacadePath = resolve(
  process.cwd(),
  "src/lib/preprocessMessages.ts",
);
const sourceDirectories = [
  resolve(process.cwd(), "src"),
  resolve(process.cwd(), "scripts"),
  resolve(process.cwd(), "../server/src"),
  resolve(process.cwd(), "../server/test"),
  resolve(process.cwd(), "../shared/src/transcript"),
];
const canonicalWebConsumerFiles = [
  "src/components/renderers/tools/TaskNestedContent.tsx",
  "src/lib/sessionDetail/renderItems.ts",
  "src/pages/SessionPage.tsx",
];

const forbiddenDependencies = [
  {
    label: "client package",
    pattern:
      /(?:from|import)\s*[(]?\s*["'][^"']*(?:client\/src|@yep-anywhere\/client)/u,
  },
  {
    label: "React runtime",
    pattern: /from\s+["'](?:react|react-dom)(?:\/[^"']*)?["']/u,
  },
  {
    label: "browser global",
    pattern:
      /\b(?:window|document|navigator|localStorage|sessionStorage)(?:\.|\[)/u,
  },
  {
    label: "web lifecycle scheduler",
    pattern: /\b(?:setTimeout|setInterval|requestAnimationFrame)\s*\(/u,
  },
  {
    label: "web application layer",
    pattern:
      /from\s+["'][^"']*\/(?:components|contexts|hooks|pages|stores?|transport)(?:\/|["'])/u,
  },
  {
    label: "legacy compatibility façade",
    pattern: /from\s+["'][^"']*preprocessMessages(?:\.[^"']*)?["']/u,
  },
];

const legacyFacadeImport =
  /from\s+["'][^"']*preprocessMessages(?:\.[^"']*)?["']/u;
const directCompilerOrCacheImport =
  /from\s+["'](?:@yep-anywhere\/shared\/transcript\/compiler|[^"']*transcriptProjection\/cache)(?:\.[^"']*)?["']/u;

function collectTypeScriptFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      return collectTypeScriptFiles(path);
    }
    return /\.tsx?$/u.test(entry.name) ? [path] : [];
  });
}

function normalizePathForComparison(filePath: string): string {
  return filePath.replaceAll("\\", "/").replace(/\/+$/u, "");
}

function hasPathSegment(filePath: string, segment: string): boolean {
  return normalizePathForComparison(filePath).split("/").includes(segment);
}

function isWithinDirectory(directory: string, filePath: string): boolean {
  const normalizedDirectory = normalizePathForComparison(directory);
  const normalizedFilePath = normalizePathForComparison(filePath);
  return normalizedFilePath.startsWith(`${normalizedDirectory}/`);
}

describe("transcript projection module boundary", () => {
  it("stays independent of React, browser state, and the legacy façade", () => {
    const moduleFiles = readdirSync(projectionDirectory)
      .filter((fileName) => fileName.endsWith(".ts"))
      .sort();

    expect(moduleFiles).toContain("compiler.ts");
    expect(moduleFiles).toContain("messageProjection.ts");

    for (const fileName of moduleFiles) {
      const source = readFileSync(
        resolve(projectionDirectory, fileName),
        "utf8",
      );
      for (const forbidden of forbiddenDependencies) {
        expect(
          source,
          `${fileName} imports or uses ${forbidden.label}`,
        ).not.toMatch(forbidden.pattern);
      }
    }
  });

  it("routes production web consumers through the canonical adapter", () => {
    for (const relativePath of canonicalWebConsumerFiles) {
      const source = readFileSync(resolve(process.cwd(), relativePath), "utf8");

      expect(source, relativePath).toContain(
        "getCachedWebTranscriptProjection",
      );
      expect(source, relativePath).not.toContain("preprocessMessages");
      expect(source, relativePath).not.toContain(
        "getCachedTranscriptProjection",
      );
      expect(source, relativePath).not.toContain(
        "compileWebTranscriptProjection",
      );
    }
  });

  it("keeps web cache and compiler assembly in the canonical adapter", () => {
    const adapterPath = resolve(
      process.cwd(),
      "src/lib/webTranscriptProjection.ts",
    );
    const source = readFileSync(adapterPath, "utf8");

    expect(source).toContain("getCachedTranscriptProjection");
    expect(source).toContain("compileTranscriptProjection");
    expect(source).toContain("compileWebTranscriptProjection");
    expect(source).toMatch(
      /getCachedTranscriptProjection\(\s*messages,\s*augments,\s*recentProjectPathLinksEnabled\s*\?\s*compileWebTranscriptProjectionWithRecentLinks\s*:\s*compileWebTranscriptProjectionBase,?\s*\)/u,
    );

    const productionFiles = collectTypeScriptFiles(
      resolve(process.cwd(), "src"),
    ).filter(
      (filePath) =>
        !hasPathSegment(filePath, "__tests__") &&
        !isWithinDirectory(projectionDirectory, filePath) &&
        !isWithinDirectory(
          resolve(process.cwd(), "src/lib/transcriptProjection"),
          filePath,
        ) &&
        filePath !== adapterPath,
    );
    for (const filePath of productionFiles) {
      const productionSource = readFileSync(filePath, "utf8");
      expect(productionSource, filePath).not.toMatch(
        directCompilerOrCacheImport,
      );
    }
  });

  it("does not restore the legacy facade or imports", () => {
    expect(existsSync(legacyFacadePath)).toBe(false);

    for (const directory of sourceDirectories) {
      for (const filePath of collectTypeScriptFiles(directory)) {
        const source = readFileSync(filePath, "utf8");
        expect(source, filePath).not.toMatch(legacyFacadeImport);
      }
    }
  });

  it("classifies Windows and POSIX source paths consistently", () => {
    expect(
      hasPathSegment("C:\\repo\\src\\__tests__\\cache.test.ts", "__tests__"),
    ).toBe(true);
    expect(
      isWithinDirectory(
        "C:\\repo\\src\\lib\\transcriptProjection",
        "C:\\repo\\src\\lib\\transcriptProjection\\compiler.ts",
      ),
    ).toBe(true);
    expect(
      isWithinDirectory(
        "/repo/src/lib/transcriptProjection",
        "/repo/src/lib/transcriptProjectionExtra/compiler.ts",
      ),
    ).toBe(false);
  });
});
