import { execFile, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, relative, isAbsolute } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it, vi } from "vitest";
import { toUrlProjectId } from "@yep-anywhere/shared";
import { CONFIG_ENV_VARS } from "../setup/config-env-vars.js";
import { standaloneYaEnvironment } from "../../../client/e2e/support/standalone-environment.js";
import {
  startYaServerProcess,
  restartYaServerProcess,
  disposeYaServerProcess,
  type YaServerProcess,
} from "../../../client/e2e/support/ya-server-process.js";

const exec = promisify(execFile);
const repoRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../..",
);
const moduleUrl = (path: string) => pathToFileURL(join(repoRoot, path)).href;

it("confines actual config/native/host resolution despite poisoned parent environment", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "s-profile-")));
  try {
    const home = join(root, "profile");
    const paths = {
      tempDir: root,
      profileDir: home,
      dataDir: join(home, "ya"),
      claudeSessionsDir: join(home, "claude", "projects"),
      codexSessionsDir: join(home, "codex", "sessions"),
      geminiSessionsDir: join(home, ".gemini", "tmp"),
    };
    const outerStartup = join(root, "outer-startup.sh");
    writeFileSync(
      outerStartup,
      "export OUTER_STARTUP_RAN=yes\nexport OPENAI_API_KEY=restored-foreign\nexport AGENT_SERVER_TOKEN=restored-foreign\nexport AGENTCTL_SESSION_ID=foreign-session\n",
    );
    const parent = { ...process.env };
    for (const key of CONFIG_ENV_VARS) parent[key] = "/foreign-parent";
    for (const key of [
      "HOME",
      "USERPROFILE",
      "APPDATA",
      "LOCALAPPDATA",
      "XDG_DATA_HOME",
      "XDG_RUNTIME_DIR",
      "TMPDIR",
      "TMP",
      "TEMP",
      "PI_CODING_AGENT_DIR",
      "GEMINI_CLI_HOME",
      "GROK_HOME",
      "YEP_PROVIDER_RUNTIME_SOCKET",
      "YEP_PROVIDER_RUNTIME_TOKEN",
      "YEP_PROVIDER_RUNTIME_DESCRIPTOR",
      "YEP_PROVIDER_WORKER_SOCKET",
      "YEP_PROVIDER_WORKER_TOKEN",
      "AGENT_SERVER_URL",
      "AGENT_SERVER_TOKEN",
      "NODE_OPTIONS",
      "BUN_OPTIONS",
      "OPENAI_API_KEY",
      "GOOGLE_APPLICATION_CREDENTIALS",
    ])
      parent[key] = "/foreign-parent";
    for (const name of [
      "BASH_ENV",
      "YEP_ORIGINAL_BASH_ENV",
      "YEP_ANYWHERE_ORIGINAL_BASH_ENV",
    ])
      parent[name] = outerStartup;
    parent.AGENTCTL_SESSION_ID = "foreign-session";
    for (const name of [
      "OpenAI_Api_Key",
      "Agent_Server_Token",
      "Yep_Provider_Worker_Token",
      "Home",
      "Claude_Config_Dir",
      "Auth_Disabled",
    ])
      parent[name] = "/mixed-case-foreign";
    const env = standaloneYaEnvironment(
      paths,
      join(root, "h"),
      false,
      {
        USE_MOCK_SDK: "true",
        OPENAI_API_KEY: "selected-fixture-only",
        YEP_PROVIDER_RUNTIME_SOCKET: "/forbidden-input",
        AGENT_SERVER_TOKEN: "forbidden-input",
        Agent_Server_Token: "mixed-case-forbidden-input",
        Yep_Provider_Runtime_Socket: "/mixed-case-forbidden-socket",
        Home: "/mixed-case-forbidden-home",
        xdg_data_home: "/mixed-case-forbidden-data",
        Gemini_Cli_Home: "/mixed-case-forbidden-gemini-home",
        BASH_ENV: outerStartup,
        AGENTCTL_SESSION_ID: "foreign-selected-session",
      },
      parent,
    );
    for (const name of Object.keys(env)) {
      if (
        [
          "AGENT_SERVER_TOKEN",
          "YEP_PROVIDER_RUNTIME_SOCKET",
          "YEP_PROVIDER_WORKER_TOKEN",
          "BASH_ENV",
          "ENV",
          "ZDOTDIR",
          "YEP_ORIGINAL_BASH_ENV",
          "YEP_ANYWHERE_ORIGINAL_BASH_ENV",
          "AGENTCTL_SESSION_ID",
        ].includes(name.toUpperCase())
      )
        throw new Error(`Foreign authority survived as ${name}`);
      if (
        [
          "HOME",
          "XDG_DATA_HOME",
          "CLAUDE_CONFIG_DIR",
          "GEMINI_CLI_HOME",
          "AUTH_DISABLED",
        ].includes(name.toUpperCase())
      )
        expect(name).toBe(name.toUpperCase());
    }
    if (process.platform !== "win32") {
      const shell = await new Promise<string>((resolve, reject) => {
        const child = spawn(
          "bash",
          [
            "--noprofile",
            "--norc",
            "-c",
            // biome-ignore lint/suspicious/noTemplateCurlyInString: Bash parameter expansion is the case under test
            'printf "%s|%s|%s|%s" "${OPENAI_API_KEY-unset}" "${OUTER_STARTUP_RAN-unset}" "${AGENT_SERVER_TOKEN-unset}" "${AGENTCTL_SESSION_ID-unset}"',
          ],
          { env, stdio: ["ignore", "pipe", "pipe"], timeout: 5000 },
        );
        let output = "";
        let error = "";
        child.stdout.on("data", (chunk) => {
          output += String(chunk);
        });
        child.stderr.on("data", (chunk) => {
          error += String(chunk);
        });
        child.on("error", reject);
        child.on("close", (code) =>
          code === 0
            ? resolve(output)
            : reject(new Error(error || `Bash probe exited ${code}`)),
        );
      });
      expect(shell).toBe("selected-fixture-only|unset|unset|unset");
    }
    const probe = `
      import {loadConfig} from ${JSON.stringify(moduleUrl("packages/server/src/config.ts"))};
      import {CLAUDE_PROJECTS_DIR,PI_SESSIONS_DIR,GROK_SESSIONS_DIR,DETACHED_PROJECT_PATH} from ${JSON.stringify(moduleUrl("packages/server/src/projects/paths.ts"))};
      import {OPENCODE_STORAGE_DIR,OPENCODE_DB_PATH} from ${JSON.stringify(moduleUrl("packages/server/src/sessions/opencode-reader.ts"))};
      import {resolveProviderHostPaths} from ${JSON.stringify(moduleUrl("scripts/provider-runtime-discovery.mjs"))};
      const c=loadConfig(); const h=resolveProviderHostPaths();
      console.log(JSON.stringify({paths:[c.dataDir,c.claudeSessionsDir,c.codexSessionsDir,c.geminiSessionsDir,c.piSessionsDir,CLAUDE_PROJECTS_DIR,PI_SESSIONS_DIR,GROK_SESSIONS_DIR,DETACHED_PROJECT_PATH,OPENCODE_STORAGE_DIR,OPENCODE_DB_PATH,...(h ? [h.runtimeDir,h.controlSocketPath] : [process.env.YEP_PROVIDER_HOST_RUNTIME_DIR])],authority:[process.env.AGENT_SERVER_TOKEN,process.env.YEP_PROVIDER_RUNTIME_SOCKET,process.env.YEP_PROVIDER_WORKER_TOKEN,process.env.GOOGLE_APPLICATION_CREDENTIALS],runtime:process.versions.bun??"node",selectedCredential:process.env.OPENAI_API_KEY==="selected-fixture-only",hosting:process.env.YEP_PROVIDER_HOST_ENABLED}));
    `;
    const result = await exec(
      process.env.YA_STANDALONE_TEST_RUNTIME ?? process.execPath,
      [
        "--import",
        "tsx",
        "--conditions",
        "source",
        "--input-type=module",
        "-e",
        probe,
      ],
      { cwd: repoRoot, env, timeout: 15000 },
    );
    const observed = JSON.parse(result.stdout.trim());
    for (const path of observed.paths) {
      expect(typeof path).toBe("string");
      const child = relative(root, path);
      expect(child.startsWith("..") || isAbsolute(child), path).toBe(false);
    }
    expect(observed.authority).toEqual([null, null, null, null]);
    expect(observed.selectedCredential).toBe(true);
    expect(observed.hosting).toBe("false");
    expect(typeof observed.runtime).toBe("string");
    if (!process.env.YA_STANDALONE_TEST_RUNTIME)
      expect(observed.runtime).toBe("node");
    expect(parent.AGENT_SERVER_TOKEN).toBe("/foreign-parent");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 20000);

it("owns standalone creation, native history, profile restart and process cleanup", async () => {
  vi.stubEnv("YEP_PROVIDER_RUNTIME_SOCKET", "/foreign-parent-socket");
  vi.stubEnv("CLAUDE_CONFIG_DIR", "/foreign-parent-config");
  vi.stubEnv("PI_CODING_AGENT_DIR", "/foreign-parent-pi");
  let server: YaServerProcess | undefined;
  let projectPath = "";
  const nativeId = "019a0000-aaaa-7aaa-8aaa-aaaaaaaaaaaa";
  let retiredPid: number | undefined;
  let fixtureRoot = "";
  let hostRoot = "";
  try {
    server = await startYaServerProcess({
      label: "standalone identity lifecycle",
      serverExecutable: process.env.YA_STANDALONE_TEST_RUNTIME,
      standalone: {},
      env: { USE_MOCK_SDK: "true" },
      setupProfile(paths) {
        projectPath = join(paths.profileDir, "project");
        mkdirSync(projectPath, { recursive: true });
        const source = join(
          paths.claudeSessionsDir,
          projectPath.replace(/[/\\:]/g, "-"),
        );
        mkdirSync(source, { recursive: true });
        writeFileSync(
          join(source, nativeId + ".jsonl"),
          JSON.stringify({
            type: "user",
            uuid: "retained-user",
            sessionId: nativeId,
            cwd: projectPath,
            timestamp: "2026-11-01T00:00:00.000Z",
            message: {
              role: "user",
              content: "private standalone retained history",
            },
          }) + "\n",
        );
      },
    });
    expect(server.process.spawnfile).toBe(server.serverExecutable);
    fixtureRoot = server.tempDir;
    hostRoot = server.restartEnv.YEP_PROVIDER_HOST_RUNTIME_DIR!;
    expect(server.restartEnv.YEP_PROVIDER_RUNTIME_SOCKET).toBeUndefined();
    expect(server.registryFile).toBe(join(server.tempDir, "process.json"));
    const projectId = toUrlProjectId(projectPath);
    const created = await fetch(
      `${server.baseUrl}/api/projects/${projectId}/sessions`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Yep-Anywhere": "true",
        },
        body: JSON.stringify({
          message: "standalone owned baseline",
          mode: "default",
        }),
      },
    );
    expect(created.status, await created.clone().text()).toBe(200);
    expect((await created.json()).sessionId).toBeTruthy();
    const nativeUrl = `/api/projects/${projectId}/sessions/${nativeId}`;
    const first = await fetch(server.baseUrl + nativeUrl);
    expect(first.status, await first.clone().text()).toBe(200);
    expect(await first.text()).toContain("private standalone retained history");
    const firstPid = server.process.pid;
    server = await restartYaServerProcess(server);
    expect(server.process.pid).not.toBe(firstPid);
    const restored = await fetch(server.baseUrl + nativeUrl);
    expect(restored.status, await restored.clone().text()).toBe(200);
    expect(await restored.text()).toContain(
      "private standalone retained history",
    );
    retiredPid = server.process.pid;
    await disposeYaServerProcess(server);
    server = undefined;
    expect(existsSync(fixtureRoot)).toBe(false);
    expect(existsSync(hostRoot)).toBe(false);
    expect(() => process.kill(retiredPid!, 0)).toThrow();
  } finally {
    await disposeYaServerProcess(server ?? null);
    vi.unstubAllEnvs();
  }
}, 30000);

it("removes owned pre-launch storage when profile setup fails", async () => {
  let root = "";
  await expect(
    startYaServerProcess({
      label: "standalone setup failure",
      standalone: {},
      setupProfile(paths) {
        root = paths.tempDir;
        throw new Error("injected profile setup failure");
      },
    }),
  ).rejects.toThrow("injected profile setup failure");
  expect(root).not.toBe("");
  expect(existsSync(root)).toBe(false);
});
