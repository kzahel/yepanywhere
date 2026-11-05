import {
  nativeTestReporters,
  runNativeQualification,
} from "./run-native-qualification.mjs";

// Run the same selected suite on POSIX and Windows without shell env syntax.
process.exitCode = await runNativeQualification(
  ["test:providers", ...nativeTestReporters(), ...process.argv.slice(2)],
  { YEP_NATIVE_TEST_PROVIDERS: "all" },
  "nativeProviderHost",
);
