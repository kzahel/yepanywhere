import type { TestContext } from "vitest";
import {
  nativeAppFixture,
  type AppProvider,
} from "../native-provider/app-fixture.js";

/** Join construction even when the case expires before it can retain the fixture. */
export function nativeAppTestFixture(
  provider: AppProvider,
  context: TestContext,
  options: NonNullable<Parameters<typeof nativeAppFixture>[1]> = {},
) {
  const pending = nativeAppFixture(provider, {
    ...options,
    signal: context.signal,
  });
  context.onTestFinished(async () => {
    await (await pending).close();
  });
  return pending;
}
