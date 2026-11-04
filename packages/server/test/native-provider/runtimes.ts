import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { resolveClaudeSdkNativeExecutable } from "../../src/sdk/providers/claude.js";

export const nativeProviders = [
  "claude",
  "codex",
  "antigravity",
  "pi",
  "opencode",
  "grok",
  "claude-gateway",
  "claude-ollama",
  "codex-oss",
] as const;
export type NativeProvider = (typeof nativeProviders)[number];
export const baselineProviders: NativeProvider[] = ["claude", "codex"];
export const expectedVersions: Record<NativeProvider, string> = {
  claude: "2.1.312",
  "claude-gateway": "2.1.312",
  "claude-ollama": "2.1.312",
  codex: "0.166.0",
  "codex-oss": "0.166.0",
  antigravity: "1.4.5",
  pi: "1.5.0",
  opencode: "1.18.9",
  grok: "1.0.67",
};
export const isClaude = (provider: NativeProvider) =>
  provider.startsWith("claude");
export const isCodex = (provider: NativeProvider) =>
  provider.startsWith("codex");
const require = createRequire(import.meta.url);
const testTools = createRequire(
  require.resolve("@yep-anywhere/native-test-executables/package.json"),
);

/** No PATH/global-CLI fallback: optional test artifacts must be installed explicitly. */
export function nativeExecutable(provider: NativeProvider): string {
  let path: string;
  if (isClaude(provider)) {
    const bundled = resolveClaudeSdkNativeExecutable();
    if (!bundled) throw Error("Missing bundled real Claude runtime");
    path = bundled;
  } else if (isCodex(provider)) {
    const fromCodex = createRequire(
      testTools.resolve("@openai/codex/package.json"),
    );
    const arch =
      process.arch === "arm64"
        ? "aarch64"
        : process.arch === "x64"
          ? "x86_64"
          : undefined;
    const suffix = {
      darwin: "apple-darwin",
      linux: "unknown-linux-musl",
      win32: "pc-windows-msvc",
    }[process.platform as "darwin" | "linux" | "win32"];
    if (!arch || !suffix)
      throw Error(
        `Unsupported native Codex test platform ${process.platform}/${process.arch}`,
      );
    path = join(
      dirname(
        fromCodex.resolve(
          `@openai/codex-${process.platform}-${process.arch}/package.json`,
        ),
      ),
      "vendor",
      `${arch}-${suffix}`,
      "bin",
      process.platform === "win32" ? "codex.exe" : "codex",
    );
  } else if (provider === "pi") {
    path = join(
      dirname(
        (testTools.resolve.paths("@earendil-works/pi-coding-agent") ?? [])
          .map((directory) =>
            join(directory, "@earendil-works/pi-coding-agent/package.json"),
          )
          .find((path) => existsSync(path)) ??
          (() => {
            throw Error("Missing pinned Pi test package");
          })(),
      ),
      "dist",
      "bundle",
      "cli.js",
    );
  } else if (provider === "opencode") {
    const fromOpenCode = createRequire(
      testTools.resolve("opencode-ai/package.json"),
    );
    const os = process.platform === "win32" ? "windows" : process.platform;
    path = join(
      dirname(
        fromOpenCode.resolve(`opencode-${os}-${process.arch}/package.json`),
      ),
      "bin",
      process.platform === "win32" ? "opencode.exe" : "opencode",
    );
  } else {
    const name = `YEP_NATIVE_TEST_${provider.toUpperCase()}_PATH`;
    path =
      process.env[name] ??
      join(
        fileURLToPath(
          new URL(
            "../../../../node_modules/.cache/ya-native-provider-tests",
            import.meta.url,
          ),
        ),
        `${process.platform}-${process.arch}`,
        provider,
        expectedVersions[provider],
        provider === "antigravity" ? "agy_acp_server.par" : "grok",
      );
    if (!existsSync(path))
      throw Error(
        `Missing real ${provider} test runtime. Run pnpm test:providers:install or set ${name} to an owned test installation`,
      );
  }
  return path;
}
