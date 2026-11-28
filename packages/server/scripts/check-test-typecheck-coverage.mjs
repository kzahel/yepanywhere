import { relative, resolve } from "node:path";
import ts from "typescript";

const serverDirectory = resolve(import.meta.dirname, "..");
const configHost = {
  ...ts.sys,
  onUnRecoverableConfigFileDiagnostic(diagnostic) {
    throw new Error(
      ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
    );
  },
};
const coveredFiles = new Set();
for (const config of ["tsconfig.json", "tsconfig.test.json"]) {
  const parsed = ts.getParsedCommandLineOfConfigFile(
    resolve(serverDirectory, config),
    {},
    configHost,
  );
  for (const diagnostic of parsed.errors) {
    configHost.onUnRecoverableConfigFileDiagnostic(diagnostic);
  }
  for (const file of parsed.fileNames) coveredFiles.add(file);
}

const testFiles = ts.sys
  .readDirectory(
    serverDirectory,
    [".ts", ".tsx", ".mts", ".cts"],
    ["**/node_modules/**", "**/dist/**"],
  )
  .filter((file) => /\.(test|spec)\.(tsx?|[cm]ts)$/.test(file));
const uncoveredFiles = testFiles.filter((file) => !coveredFiles.has(file));
if (uncoveredFiles.length > 0) {
  console.error("Server tests missing from both TypeScript configurations:");
  for (const file of uncoveredFiles.sort()) {
    console.error(`  ${relative(serverDirectory, file)}`);
  }
  process.exitCode = 1;
}
