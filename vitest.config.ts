/**
 * Root-invoked vitest resolves each test file through its owning package's
 * project below, so `pnpm vitest run <files>` from the repo root behaves
 * exactly like that package's own runner — client files get jsdom + globals
 * (React Testing Library registers auto-cleanup only when test globals exist)
 * plus its setup file; server files get the hermetic-env setup. Without this,
 * root runs silently dropped every per-package test option and could fail
 * spuriously (RTL DOM accumulating across tests). `pnpm test` (pnpm -r test)
 * runs per package and is unaffected. The root package does not depend on
 * vitest, so this config exports a plain object rather than importing
 * `vitest/config`.
 */
export default {
  test: {
    projects: [
      "packages/client/vitest.config.ts",
      "packages/server/vitest.config.ts",
      "packages/shared",
      "packages/relay",
    ],
  },
};
