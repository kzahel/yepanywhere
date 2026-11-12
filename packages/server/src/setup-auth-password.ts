/**
 * Where `yepanywhere --setup-auth` takes the new local password from.
 *
 * - `--setup-auth <password>`: a value that does not begin with `-`;
 * - `--setup-auth=<password>`: any value, including one beginning with `-`;
 * - `--setup-auth-pwfile <path>`: the file's contents, `-` for stdin;
 * - bare `--setup-auth`: the `YEP_AUTH_PASSWORD` environment variable.
 *
 * The file and environment forms keep the password out of the process table
 * and shell history. A file's single trailing newline is dropped. The
 * environment variable is removed from `env` whether or not it is used, so
 * it never reaches the server or the agents it starts.
 */

export const SETUP_AUTH_PASSWORD_ENV = "YEP_AUTH_PASSWORD";

export type SetupAuthPasswordResult =
  | { password: string | undefined }
  | { error: string };

const SOURCES =
  "--setup-auth <password>, --setup-auth=<password>, --setup-auth-pwfile <path|->, or --setup-auth with YEP_AUTH_PASSWORD set";

/** Remove the setup-auth flags from `args` and resolve the password. */
export function takeSetupAuthPassword(
  args: string[],
  env: NodeJS.ProcessEnv,
  readFile: (path: string | 0) => string,
): SetupAuthPasswordResult {
  const fromEnv = env[SETUP_AUTH_PASSWORD_ENV];
  delete env[SETUP_AUTH_PASSWORD_ENV];

  const found: string[] = [];
  let requested = false;

  const inline = args.findIndex((arg) => arg.startsWith("--setup-auth="));
  if (inline !== -1) {
    requested = true;
    found.push(args[inline]!.slice("--setup-auth=".length));
    args.splice(inline, 1);
  }

  const flag = args.indexOf("--setup-auth");
  if (flag !== -1) {
    requested = true;
    const value = args[flag + 1];
    if (value !== undefined && !value.startsWith("-")) {
      found.push(value);
      args.splice(flag, 2);
    } else {
      args.splice(flag, 1);
      if (fromEnv !== undefined) found.push(fromEnv);
    }
  }

  const pwfile = args.indexOf("--setup-auth-pwfile");
  if (pwfile !== -1) {
    requested = true;
    const path = args[pwfile + 1];
    if (path === undefined || (path.startsWith("-") && path !== "-"))
      return { error: "--setup-auth-pwfile requires a file path, or -" };
    args.splice(pwfile, 2);
    try {
      found.push(readFile(path === "-" ? 0 : path).replace(/\r?\n$/, ""));
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return { error: `Cannot read --setup-auth-pwfile: ${reason}` };
    }
  }

  if (!requested) return { password: undefined };
  if (found.length > 1)
    return { error: `Give the --setup-auth password one way: ${SOURCES}` };
  if (!found[0])
    return { error: `--setup-auth requires a password: ${SOURCES}` };
  return { password: found[0] };
}
