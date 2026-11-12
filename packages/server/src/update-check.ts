/**
 * `YEP_UPDATE_CHECK=false` (or `0`, `no`, `off`) stops the server's update
 * checks against updates.yepanywhere.com: every app version check, and the
 * device bridge version check behind its status display. Downloading the
 * device bridge, an explicit action that needs the current bridge version,
 * still asks for it. Read per call, so it needs no wiring.
 */
export function isUpdateCheckEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const value = env.YEP_UPDATE_CHECK?.trim().toLowerCase();
  return !(
    value === "false" ||
    value === "0" ||
    value === "no" ||
    value === "off"
  );
}
