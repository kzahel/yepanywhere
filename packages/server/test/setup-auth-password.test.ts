import { describe, expect, it } from "vitest";
import { takeSetupAuthPassword } from "../src/setup-auth-password.js";

const files: Record<string | number, string> = {
  "/secret": "from-file-pw\n",
  0: "-from-stdin\r\n",
};
const readFile = (path: string | 0) => {
  const content = files[path];
  if (content === undefined) throw new Error(`ENOENT: ${path}`);
  return content;
};

function take(argv: string[], envPassword?: string) {
  const args = [...argv, "--port", "1"];
  const env: NodeJS.ProcessEnv =
    envPassword === undefined ? {} : { YEP_AUTH_PASSWORD: envPassword };
  const result = takeSetupAuthPassword(args, env, readFile);
  expect(env).toEqual({});
  return { result, args };
}

describe("--setup-auth password sources", () => {
  it.each([
    [["--setup-auth", "plain-pw"], undefined, "plain-pw"],
    [["--setup-auth=-dash-pw"], undefined, "-dash-pw"],
    [["--setup-auth"], "env-pw", "env-pw"],
    [["--setup-auth-pwfile", "/secret"], "unused", "from-file-pw"],
    [["--setup-auth-pwfile", "-"], undefined, "-from-stdin"],
    [[], "unused", undefined],
  ])(
    "%j with env %s gives %s and leaves other flags",
    (argv, env, password) => {
      const { result, args } = take(argv, env);
      expect(result).toEqual({ password });
      expect(args).toEqual(["--port", "1"]);
    },
  );

  it.each([
    [["--setup-auth"], undefined, "requires a password"],
    [["--setup-auth", "-dash"], undefined, "requires a password"],
    [
      ["--setup-auth", "a", "--setup-auth-pwfile", "/secret"],
      undefined,
      "one way",
    ],
    [["--setup-auth-pwfile", "/missing"], undefined, "Cannot read"],
  ])("%j with env %s is refused", (argv, env, message) => {
    const { result } = take(argv, env);
    expect(result).toMatchObject({ error: expect.stringContaining(message) });
  });
});
