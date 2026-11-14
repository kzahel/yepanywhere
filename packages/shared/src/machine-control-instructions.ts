export const MACHINE_CONTROL_INSTRUCTIONS_NOTICE =
  "Machine Control instructions added";

/** The command is already quoted for the launch's shell; no command is run here. */
export function machineControlInstructions(
  version: string,
  command: string,
): string {
  return [
    "[Installed Machine Control]",
    `Machine Control ${version} is available on this agent's execution host.`,
    `For desktop/browser control, first read its workflow with: ${command} agent instructions`,
    "Invoke that exact command path if your shell replaces PATH. The host target is this execution machine.",
    "Discovery and these instructions grant no access. Follow MC doctor/claims and native access approval; do not start a second resident, switch to the operator's machine, or automatically retry an uncertain mutation.",
    "Closing this YA session does not revoke independently granted MC access. Use MC Stop or native grant expiry to revoke it.",
    "MC owns its access, arming, lifecycle and updates. YA session selection only advertises the command; it does not contain unrelated same-user shell access. Administrator authentication is a separately selected helper.",
    "[/Installed Machine Control]",
  ].join("\n");
}

/** Match the complete YA template, including historical fragments without a closer. */
export function findMachineControlInstructions(text: string): string | null {
  const candidates = text.matchAll(
    /^\[Installed Machine Control\]\nMachine Control (\S+) is available on this agent's execution host\.\nFor desktop\/browser control, first read its workflow with: ((?:& )?'[^\n]+') agent instructions\n/gm,
  );
  for (const match of candidates) {
    const current = machineControlInstructions(match[1]!, match[2]!);
    const legacy = current.slice(0, -"\n[/Installed Machine Control]".length);
    for (const fragment of [current, legacy]) {
      const remaining = text.slice(match.index);
      if (
        remaining.startsWith(fragment) &&
        (fragment === current ||
          remaining.length === fragment.length ||
          remaining.slice(fragment.length).startsWith("\n\n"))
      )
        return fragment;
    }
  }
  return null;
}

/** Only a complete MC fragment at the end identifies this old YA wrapper. */
export function splitMachineControlPrompt(
  text: string,
): { context: string; prompt: string } | null {
  const opener = "[Global context]\n";
  if (!text.startsWith(opener)) return null;
  const fragment = findMachineControlInstructions(text);
  if (!fragment) return null;
  const end = text.indexOf(fragment) + fragment.length;
  const delimiter = "\n\n---\n\n";
  if (!text.slice(end).startsWith(delimiter)) return null;
  return {
    context: text.slice(opener.length, end),
    prompt: text.slice(end + delimiter.length),
  };
}

export function stripMachineControlPrompt(text: string): string {
  return splitMachineControlPrompt(text)?.prompt ?? text;
}
