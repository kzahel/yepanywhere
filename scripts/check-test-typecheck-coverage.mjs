import { relative, resolve } from "node:path";
import ts from "typescript";

const packagesDirectory = resolve(import.meta.dirname, "../packages");
const configurations = {
  client: ["tsconfig.json", "tsconfig.e2e.json", "tsconfig.tools.json"],
  server: ["tsconfig.json", "tsconfig.test.json"],
  shared: ["tsconfig.json", "tsconfig.test.json"],
  relay: ["tsconfig.json", "tsconfig.test.json"],
  "push-broker": ["tsconfig.json", "tsconfig.test.json"],
};
const configHost = {
  ...ts.sys,
  onUnRecoverableConfigFileDiagnostic(diagnostic) {
    throw new Error(
      ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
    );
  },
};
const uncoveredFiles = [];
for (const [workspace, configs] of Object.entries(configurations)) {
  const directory = resolve(packagesDirectory, workspace);
  const coveredFiles = new Set();
  for (const config of configs) {
    const parsed = ts.getParsedCommandLineOfConfigFile(
      resolve(directory, config),
      {},
      configHost,
    );
    for (const diagnostic of parsed.errors) {
      configHost.onUnRecoverableConfigFileDiagnostic(diagnostic);
    }
    for (const file of parsed.fileNames) coveredFiles.add(file);
  }

  const files = ts.sys.readDirectory(
    directory,
    [".ts", ".tsx", ".mts", ".cts"],
    ["**/node_modules/**", "**/dist/**"],
  );
  for (const file of files) {
    const localPath = relative(directory, file).replaceAll("\\", "/");
    const isTest = /\.(test|spec)\.(tsx?|[cm]ts)$/.test(file);
    const isBrowserFixture =
      workspace === "client" && localPath.startsWith("e2e/");
    if ((isTest || isBrowserFixture) && !coveredFiles.has(file)) {
      uncoveredFiles.push(`${workspace}/${localPath}`);
    }
  }
}

if (uncoveredFiles.length > 0) {
  console.error("Test files missing from the root TypeScript gate:");
  for (const file of uncoveredFiles.sort()) {
    console.error(`  packages/${file}`);
  }
  process.exitCode = 1;
}
