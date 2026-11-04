import {
  baselineProviders,
  nativeProviders,
  type NativeProvider,
} from "./runtimes.js";

const selected =
  process.env.YEP_NATIVE_TEST_PROVIDERS === "all"
    ? [...nativeProviders]
    : (process.env.YEP_NATIVE_TEST_PROVIDERS?.split(",") ?? [
        ...baselineProviders,
      ]);
for (const provider of selected)
  if (!nativeProviders.includes(provider as NativeProvider))
    throw Error(
      `Provider ${provider} has no qualified native local-model fixture; refusing a fake or paid fallback`,
    );
export const providers = nativeProviders.filter((provider) =>
  selected.includes(provider),
);
