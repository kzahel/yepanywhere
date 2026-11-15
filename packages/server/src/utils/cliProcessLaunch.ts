import { win32 } from "node:path";

const commandMeta = /([()[\]%!^"`<>&|;, *?])/g;

function commandArgument(value: string, doubleEscape: boolean): string {
  let quoted = '"';
  let slashes = 0;
  for (const character of value) {
    if (character === "\\") {
      slashes++;
      continue;
    }
    quoted +=
      "\\".repeat(character === '"' ? slashes * 2 + 1 : slashes) + character;
    slashes = 0;
  }
  quoted += "\\".repeat(slashes * 2) + '"';
  quoted = quoted.replace(commandMeta, "^$1");
  return doubleEscape ? quoted.replace(commandMeta, "^$1") : quoted;
}

/** Explicit cmd invocation keeps npm shims usable without Node's shell+argv path. */
export function cliProcessLaunch(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  platform = process.platform,
) {
  if (platform !== "win32" || /\.(?:exe|com)$/i.test(command))
    return { command, args, windowsVerbatimArguments: false };
  const escaped = win32.normalize(command).replace(commandMeta, "^$1");
  const doubleEscape = /node_modules[\\/]\.bin[\\/].*\.cmd$/i.test(command);
  const line = [
    escaped,
    ...args.map((value) => commandArgument(value, doubleEscape)),
  ].join(" ");
  return {
    command: env.COMSPEC ?? env.ComSpec ?? "cmd.exe",
    args: ["/d", "/s", "/c", `"${line}"`],
    windowsVerbatimArguments: true,
  };
}
