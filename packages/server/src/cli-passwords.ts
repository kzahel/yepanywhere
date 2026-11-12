/**
 * Where the headless setup commands take a password from. For a value flag
 * such as `--setup-auth`:
 *
 * - `<flag> <password>`: a value that does not begin with `-`;
 * - `<flag>=<password>`: any value, including one beginning with `-`;
 * - `<file flag> <path>`: the file's contents, `-` for stdin;
 * - a bare `<flag>`: the option's environment variable.
 *
 * The file and environment forms keep the password out of the process table
 * and shell history. A file's single trailing newline is dropped. The
 * environment variable is removed from `env` whether or not it is used, so
 * it never reaches the server or the agents it starts.
 */

export interface PasswordOption {
  flag: string;
  fileFlag: string;
  envName: string;
}

export const SETUP_AUTH_PASSWORD: PasswordOption = {
  flag: "--setup-auth",
  fileFlag: "--setup-auth-pwfile",
  envName: "YEP_AUTH_PASSWORD",
};

export const REMOTE_ACCESS_PASSWORD: PasswordOption = {
  flag: "--password",
  fileFlag: "--password-file",
  envName: "YEP_REMOTE_ACCESS_PASSWORD",
};

export type PasswordResult =
  | { password: string | undefined }
  | { error: string };

/** Remove one password option's flags from `args` and resolve it. */
export function takePassword(
  args: string[],
  option: PasswordOption,
  env: NodeJS.ProcessEnv,
  readFile: (path: string | 0) => string,
): PasswordResult {
  const { flag, fileFlag, envName } = option;
  const fromEnv = env[envName];
  delete env[envName];

  const found: string[] = [];
  let requested = false;

  const inline = args.findIndex((arg) => arg.startsWith(`${flag}=`));
  if (inline !== -1) {
    requested = true;
    found.push(args[inline]!.slice(flag.length + 1));
    args.splice(inline, 1);
  }

  const bare = args.indexOf(flag);
  if (bare !== -1) {
    requested = true;
    const value = args[bare + 1];
    if (value !== undefined && !value.startsWith("-")) {
      found.push(value);
      args.splice(bare, 2);
    } else {
      args.splice(bare, 1);
      if (fromEnv !== undefined) found.push(fromEnv);
    }
  }

  const file = args.indexOf(fileFlag);
  if (file !== -1) {
    requested = true;
    const path = args[file + 1];
    if (path === undefined || (path.startsWith("-") && path !== "-"))
      return { error: `${fileFlag} requires a file path, or -` };
    args.splice(file, 2);
    try {
      found.push(readFile(path === "-" ? 0 : path).replace(/\r?\n$/, ""));
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return { error: `Cannot read ${fileFlag}: ${reason}` };
    }
  }

  const sources = `${flag} <password>, ${flag}=<password>, ${fileFlag} <path|->, or ${flag} with ${envName} set`;
  if (!requested) return { password: undefined };
  if (found.length > 1)
    return { error: `Give the ${flag} password one way: ${sources}` };
  if (!found[0]) return { error: `${flag} requires a password: ${sources}` };
  return { password: found[0] };
}
