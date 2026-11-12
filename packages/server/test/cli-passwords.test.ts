import { describe, expect, it } from "vitest";
import {
  type PasswordOption,
  REMOTE_ACCESS_PASSWORD,
  SETUP_AUTH_PASSWORD,
  takePassword,
} from "../src/cli-passwords.js";

const files: Record<string | number, string> = {
  "/secret": "from-file-pw\n",
  0: "-from-stdin\r\n",
};
const readFile = (path: string | 0) => {
  const content = files[path];
  if (content === undefined) throw new Error(`ENOENT: ${path}`);
  return content;
};

function take(option: PasswordOption, argv: string[], envPassword?: string) {
  const args = [...argv, "--port", "1"];
  const env: NodeJS.ProcessEnv =
    envPassword === undefined ? {} : { [option.envName]: envPassword };
  const result = takePassword(args, option, env, readFile);
  expect(env).toEqual({});
  return { result, args };
}

describe.each([SETUP_AUTH_PASSWORD, REMOTE_ACCESS_PASSWORD])(
  "$flag password sources",
  (option) => {
    const { flag, fileFlag } = option;

    it.each([
      [[flag, "plain-pw"], undefined, "plain-pw"],
      [[`${flag}=-dash-pw`], undefined, "-dash-pw"],
      [[flag], "env-pw", "env-pw"],
      [[fileFlag, "/secret"], "unused", "from-file-pw"],
      [[fileFlag, "-"], undefined, "-from-stdin"],
      [[], "unused", undefined],
    ])(
      "%j with env %s gives %s and leaves other flags",
      (argv, env, password) => {
        const { result, args } = take(option, argv, env);
        expect(result).toEqual({ password });
        expect(args).toEqual(["--port", "1"]);
      },
    );

    it.each([
      [[flag], "requires a password"],
      [[flag, "-dash"], "requires a password"],
      [[flag, "a", fileFlag, "/secret"], "one way"],
      [[fileFlag, "/missing"], "Cannot read"],
    ])("%j is refused", (argv, message) => {
      const { result } = take(option, argv);
      expect(result).toMatchObject({ error: expect.stringContaining(message) });
    });
  },
);
