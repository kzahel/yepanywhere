import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ServerSettingsService } from "../../src/services/ServerSettingsService.js";
import { DiscoverySqliteService } from "../../src/storage/discovery-sqlite.js";
import { IssueStore } from "../../src/services/issues/IssueStore.js";
import { IssueIndexer } from "../../src/services/issues/IssueIndexer.js";
import {
  DEFAULT_ISSUE_SETTINGS,
  type IssueSettings,
} from "@yep-anywhere/shared";
import { IssueCredentials } from "../../src/services/issues/credentials.js";
import { createIssueRoutes } from "../../src/routes/issues.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function dataDir(prefix: string) {
  const path = mkdtempSync(join(tmpdir(), prefix));
  directories.push(path);
  return path;
}

describe("issue tracker credentials", () => {
  it("reports presence and origin without ever returning a key", async () => {
    const credentials = new IssueCredentials({
      dataDir: dataDir("ya-issue-creds-"),
      env: { GITHUB_TOKEN: "env-secret" },
      cliToken: async () => null,
    });
    const before = await credentials.status();
    const github = before.find((row) => row.provider === "github")!;
    expect(github.active).toBe("GITHUB_TOKEN");
    expect(github.sources.map((s) => [s.name, s.present])).toEqual([
      ["Key stored in Settings", false],
      ["YEP_GITHUB_TOKEN", false],
      ["GITHUB_TOKEN", true],
      ["GH_TOKEN", false],
      ["gh auth token", false],
    ]);
    expect(JSON.stringify(before)).not.toContain("env-secret");
    expect(before.find((row) => row.provider === "jira")!.active).toBeNull();

    // A stored key outranks the environment, and clearing restores it.
    await credentials.store("github", "stored-secret");
    expect((await credentials.status())[0]!.active).toBe(
      "Key stored in Settings",
    );
    expect(await credentials.resolve("github")).toEqual({
      token: "stored-secret",
      source: "Key stored in Settings",
    });
    await credentials.store("github", "");
    expect(await credentials.resolve("github")).toEqual({
      token: "env-secret",
      source: "GITHUB_TOKEN",
    });
  });

  it("never probes gh when disabled and pins a named account without credential fallback", async () => {
    let policy: IssueSettings = {
      ...DEFAULT_ISSUE_SETTINGS,
      githubStatusEnabled: true,
      githubCli: { enabled: false, account: "work-user" },
    };
    const cliToken = vi.fn(
      async (_account?: string): Promise<string | null> => "cli-secret",
    );
    const cliIdentity = vi.fn(async () => ({
      accounts: ["personal", "work-user"],
      active: "personal",
    }));
    const creds = new IssueCredentials({
      env: { GITHUB_TOKEN: "env-secret" },
      settings: () => policy,
      cliToken,
      cliIdentity,
    });
    expect((await creds.resolve("github"))?.source).toBe("GITHUB_TOKEN");
    await creds.status();
    expect(cliToken).not.toHaveBeenCalled();
    expect(cliIdentity).not.toHaveBeenCalled();
    policy = { ...policy, githubCli: { enabled: true, account: "work-user" } };
    expect(await creds.resolve("github")).toEqual({
      token: "cli-secret",
      source: "gh auth token (work-user)",
    });
    expect(cliToken).toHaveBeenLastCalledWith("work-user");
    expect((await creds.status())[0]).toMatchObject({
      active: "gh auth token (work-user)",
      account: "work-user",
    });
    policy = {
      ...policy,
      githubCli: { enabled: true, account: "missing-user" },
    };
    cliToken.mockResolvedValueOnce(null);
    expect(await creds.resolve("github")).toBeNull();
    policy = { ...policy, githubStatusEnabled: false };
    cliToken.mockClear();
    cliIdentity.mockClear();
    await creds.status();
    expect(cliToken).not.toHaveBeenCalled();
    expect(cliIdentity).not.toHaveBeenCalled();
  });

  it("keeps stored keys out of settings and out of other readers", async () => {
    const dir = dataDir("ya-issue-creds-file-");
    const credentials = new IssueCredentials({ dataDir: dir, env: {} });
    await credentials.store("jira", "jira-secret");
    const path = join(dir, "issue-credentials.json");
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(path, "utf8")).toContain("jira-secret");
    const settings = new ServerSettingsService({ dataDir: dir });
    await settings.initialize();
    expect(JSON.stringify(settings.getSettings())).not.toContain("jira-secret");
    // A restarted server reads the same key back.
    expect(
      (await new IssueCredentials({ dataDir: dir, env: {} }).resolve("jira"))
        ?.token,
    ).toBe("jira-secret");
  });

  it("serves and stores credentials through the routes while discovery is off", async () => {
    const dir = dataDir("ya-issue-creds-routes-");
    const settings = new ServerSettingsService({ dataDir: dir });
    await settings.initialize();
    const db = new DiscoverySqliteService({ dataDir: dir });
    const indexer = new IssueIndexer(new IssueStore(db.getDatabase()), {
      settings: () =>
        settings.getSetting("issueAssociations") ?? DEFAULT_ISSUE_SETTINGS,
      changes: async () => ({
        mark: { catalogEpoch: "e", catalogGeneration: 1 },
        full: true,
        rows: [],
        removed: [],
        excluded: [],
      }),
      row: async () => undefined,
      read: async () => null,
    });
    const credentials = new IssueCredentials({
      dataDir: dir,
      env: {},
      cliToken: async () => null,
    });
    const app = createIssueRoutes(
      indexer,
      settings,
      async () => ({ available: false }),
      credentials,
    );
    const call = (path: string, method = "GET", body?: unknown) =>
      app.request(`/issues${path}`, {
        method,
        headers: { "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
      });
    try {
      // Discovery is disabled, so a data route is refused while this pair works.
      expect((await call("")).status).toBe(403);
      const listed = await (await call("/credentials")).json();
      expect(listed.credentials).toHaveLength(2);
      expect(JSON.stringify(listed)).not.toContain("key");

      expect(
        (await call("/credentials", "PUT", { provider: "nope", key: "x" }))
          .status,
      ).toBe(400);
      const saved = await call("/credentials", "PUT", {
        provider: "jira",
        key: "  route-secret  ",
      });
      expect(saved.status).toBe(200);
      const body = await saved.json();
      expect(JSON.stringify(body)).not.toContain("route-secret");
      expect(
        body.credentials.find(
          (row: { provider: string }) => row.provider === "jira",
        ).active,
      ).toBe("Key stored in Settings");
      expect((await credentials.resolve("jira"))?.token).toBe("route-secret");
    } finally {
      await indexer.close();
      db.close();
    }
  });

  it("rejects a half-configured confirmation block and stores a valid one", async () => {
    const dir = dataDir("ya-issue-confirm-");
    const settings = new ServerSettingsService({ dataDir: dir });
    await settings.initialize();
    const db = new DiscoverySqliteService({ dataDir: dir });
    const indexer = new IssueIndexer(new IssueStore(db.getDatabase()), {
      settings: () =>
        settings.getSetting("issueAssociations") ?? DEFAULT_ISSUE_SETTINGS,
      changes: async () => ({
        mark: { catalogEpoch: "e", catalogGeneration: 1 },
        full: true,
        rows: [],
        removed: [],
        excluded: [],
      }),
      row: async () => undefined,
      read: async () => null,
    });
    const app = createIssueRoutes(indexer, settings, async () => ({
      available: false,
    }));
    const put = (body: unknown) =>
      app.request("/issues/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    const base = { enabled: true, scope: "viewed", recentDays: 7 };
    try {
      expect(
        (
          await put({
            ...base,
            confirmation: { enabled: true, jiraSite: "notaurl", jiraEmail: "" },
          })
        ).status,
      ).toBe(400);
      expect(
        (await put({ ...base, jiraKeyBlocklist: ["ok", "no spaces"] })).status,
      ).toBe(400);
      expect(
        (
          await put({
            ...base,
            confirmation: {
              enabled: true,
              jiraSite: "https://example.atlassian.net",
              jiraEmail: "someone@example.com",
            },
            jiraKeyBlocklist: ["utf", "ISO", "utf"],
          })
        ).status,
      ).toBe(200);
      expect(
        (
          await put({
            ...base,
            githubStatusEnabled: false,
            githubCli: { enabled: false, account: "work-user" },
          })
        ).status,
      ).toBe(200);
      expect(
        (
          await put({
            ...base,
            githubCli: { enabled: true, account: "bad user" },
          })
        ).status,
      ).toBe(400);
      // An old client saves its known fields without dropping the new policy.
      expect((await put(base)).status).toBe(200);
      const reloaded = new ServerSettingsService({ dataDir: dir });
      await reloaded.initialize();
      expect(reloaded.getSetting("issueAssociations")).toMatchObject({
        githubStatusEnabled: false,
        githubCli: { enabled: false, account: "work-user" },
      });
      const stored = settings.getSetting("issueAssociations");
      expect(stored?.confirmation?.enabled).toBe(true);
      expect(stored?.jiraKeyBlocklist).toEqual(["ISO", "UTF"]);
    } finally {
      await indexer.close();
      db.close();
    }
  });
});
