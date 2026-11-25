import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  filterCodexConfigToml,
  prepareCodexBootHome,
} from "../../../src/sdk/providers/codex-boot-home.js";

const scratch = await mkdtemp(join(tmpdir(), "ya-codex-boot-home-"));
afterAll(() => rm(scratch, { recursive: true }));

async function operatorHome(name: string): Promise<string> {
  const home = join(scratch, name, "operator");
  await mkdir(join(home, "rules"), { recursive: true });
  await writeFile(join(home, "auth.json"), "{}");
  await writeFile(join(home, "AGENTS.md"), "operator boot");
  await writeFile(
    join(home, "config.toml"),
    'model = "m"\ndeveloper_instructions = """\nsecret\n"""\n[hooks.state]\nx = 1\n[features]\nhooks = true\n',
  );
  return home;
}

describe("Codex boot homes", () => {
  it("carries login, rules, rollouts and filtered config, never the operator boot", async () => {
    const operator = await operatorHome("fresh");
    const homeRoot = join(scratch, "fresh", "boot-homes");
    const home = await prepareCodexBootHome(
      { source: { text: "" }, apiClient: "learn-harness", homeRoot },
      operator,
    );
    expect(home).toBe(join(homeRoot, "codex", "learn-harness"));
    for (const entry of ["auth.json", "rules", "sessions"])
      expect(await readlink(join(home, entry))).toBe(join(operator, entry));
    await expect(lstat(join(home, "AGENTS.md"))).rejects.toThrow();
    const config = await readFile(join(home, "config.toml"), "utf8");
    expect(config).toContain('model = "m"');
    expect(config).toContain("[features]\nhooks = true");
    expect(config).not.toContain("secret");
    expect(config).not.toContain("hooks.state");
    // A second launch reuses the same home.
    expect(
      await prepareCodexBootHome(
        { source: { text: "x" }, apiClient: "learn-harness", homeRoot },
        operator,
      ),
    ).toBe(home);
  });

  it("refuses a directory it did not make or made for another client", async () => {
    const operator = await operatorHome("foreign");
    const homeRoot = join(scratch, "foreign", "boot-homes");
    await mkdir(join(homeRoot, "codex", "someone"), { recursive: true });
    await expect(
      prepareCodexBootHome(
        { source: { text: "" }, apiClient: "someone", homeRoot },
        operator,
      ),
    ).rejects.toThrow(/Boot home not owned by this client/);
    await prepareCodexBootHome({ source: { text: "" }, homeRoot }, operator);
    await writeFile(
      join(homeRoot, "codex", "_default", ".ya-boot-home"),
      JSON.stringify({ schema: 1, provider: "codex", apiClient: "_default" }),
    );
    await expect(
      prepareCodexBootHome({ source: { text: "" }, homeRoot }, operator),
    ).rejects.toThrow(/for another client/);
  });

  it("refuses rather than removes a real directory where a link belongs", async () => {
    const operator = await operatorHome("rollouts");
    const homeRoot = join(scratch, "rollouts", "boot-homes");
    const home = await prepareCodexBootHome(
      { source: { text: "" }, apiClient: "c", homeRoot },
      operator,
    );
    await rm(join(home, "sessions"));
    await mkdir(join(home, "sessions"));
    await writeFile(join(home, "sessions", "rollout.jsonl"), "{}");
    await expect(
      prepareCodexBootHome(
        { source: { text: "" }, apiClient: "c", homeRoot },
        operator,
      ),
    ).rejects.toThrow(/directory, not a link/);
    expect(
      await readFile(join(home, "sessions", "rollout.jsonl"), "utf8"),
    ).toBe("{}");
  });
});

describe("filterCodexConfigToml", () => {
  it("drops top-level instruction keys and hooks tables only", () => {
    expect(
      filterCodexConfigToml(
        [
          'instructions = "a"',
          "model_instructions_file = '/x'",
          "hooks.stop = 1",
          'model = "keep"',
          "[[hooks.pre]]",
          'command = "x"',
          '[projects."/p"]',
          'trust_level = "trusted"',
          'developer_instructions = "kept: not top level"',
        ].join("\n"),
      ),
    ).toBe(
      [
        'model = "keep"',
        '[projects."/p"]',
        'trust_level = "trusted"',
        'developer_instructions = "kept: not top level"',
      ].join("\n"),
    );
  });
});
