import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { detectCodexCli } from "./sdk/cli-detection.js";

function parseCodexVersion(raw: string | undefined): string | null {
  if (!raw) return null;
  const match = raw.match(/\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?/);
  return match ? match[0] : null;
}

function readExpectedCodexVersionFromPackageJson(): string | null {
  const candidatePaths = [
    path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../../package.json",
    ),
    path.resolve(process.cwd(), "package.json"),
  ];

  for (const packageJsonPath of candidatePaths) {
    try {
      if (!fs.existsSync(packageJsonPath)) {
        continue;
      }

      const parsed = JSON.parse(
        fs.readFileSync(packageJsonPath, "utf-8"),
      ) as unknown;
      if (!parsed || typeof parsed !== "object") {
        continue;
      }

      const root = parsed as {
        yepAnywhere?: { codexCli?: { expectedVersion?: string } };
      };
      const expected = root.yepAnywhere?.codexCli?.expectedVersion;
      if (typeof expected === "string" && expected.trim().length > 0) {
        return expected.trim();
      }
    } catch {
      // Ignore malformed/unavailable package.json and try next candidate path.
    }
  }

  return null;
}

/** Advisory only: report a Codex CLI that differs from the audited target. */
export async function warnIfCodexVersionMismatch(config: {
  enabledProviders: readonly string[];
  codexCliPath?: string;
}): Promise<void> {
  // An excluded provider must not perform installation/ACL work merely to
  // produce an optional advisory. Empty configuration exposes all providers.
  if (
    config.enabledProviders.length > 0 &&
    !config.enabledProviders.some(
      (provider) => provider === "codex" || provider === "codex-oss",
    )
  ) {
    return;
  }

  const expectedRaw = readExpectedCodexVersionFromPackageJson();
  if (!expectedRaw) {
    return;
  }

  const expected = parseCodexVersion(expectedRaw) ?? expectedRaw;
  const codexInfo = await detectCodexCli(config.codexCliPath);
  if (!codexInfo.found || !codexInfo.version) {
    return;
  }

  const actual = parseCodexVersion(codexInfo.version) ?? codexInfo.version;
  if (actual === expected) {
    return;
  }

  console.warn(
    `[Codex] CLI version differs from YA's audited target: package.json yepAnywhere.codexCli.expectedVersion=${expected}, detected ${actual}. This is an advisory compatibility signal, not a hard requirement; YA gates known version-sensitive behavior where possible, but Codex app-server behavior may differ if the protocol changed.`,
  );
}
