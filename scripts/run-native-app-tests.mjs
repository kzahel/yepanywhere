import {
  nativeTestReporters,
  runNativeQualification,
} from "./run-native-qualification.mjs";

if (!["linux", "darwin"].includes(process.platform) || process.versions.bun)
  throw Error(
    "Native app reload qualification requires the supported POSIX Node provider host",
  );
const args = process.argv.slice(2);
const browser = args[0] === "--browser";
if (browser) args.shift();
const command = browser
  ? [
      "--filter",
      "@yep-anywhere/client",
      "exec",
      "playwright",
      "test",
      "--config",
      "playwright.native-app.config.ts",
    ]
  : [
      "--filter",
      "@yep-anywhere/server",
      "test",
      "test/native-app",
      ...nativeTestReporters(),
    ];
process.exitCode = await runNativeQualification(
  [...command, ...args],
  { YEP_NATIVE_APP_TESTS: "1" },
  "nativeAppHost",
);
