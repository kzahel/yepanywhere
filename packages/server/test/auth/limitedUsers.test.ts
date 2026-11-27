import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LimitedUsersService } from "../../src/auth/LimitedUsersService.js";
import { decideLimitedRoute } from "../../src/auth/limitedUserPolicy.js";
import { SessionAccessResolver } from "../../src/auth/sessionAccess.js";
import { AUTHENTICATED_SRP_TRANSPORT } from "../../src/middleware/authenticated-transport.js";
import { createLimitedUsersMiddleware } from "../../src/middleware/limited-users.js";
import {
  actingUsername,
  applyLimitedLaunchPolicy,
  applyLimitedResumePolicy,
  limitQueuedLaunch,
} from "../../src/auth/limitedLaunchPolicy.js";
import type { ModelSettings } from "../../src/supervisor/Supervisor.js";
import { buildUserMessageMetadata } from "../../src/routes/session-request-helpers.js";
import {
  PRINCIPAL_VARIABLE,
  signActingUser,
} from "../../src/auth/principal.js";

/** topics/limited-users.md § Delivery v1 — Authorization. */

/** The query is dropped: the policy never reads it. */
function decide(method: string, url: string) {
  return decideLimitedRoute({
    method,
    path: new URL(url, "http://127.0.0.1").pathname,
  });
}

describe("limited-user route policy", () => {
  it("refuses a path nobody listed, so a new route is closed by default", () => {
    expect(decide("GET", "/api/some-new-surface")).toEqual({ kind: "deny" });
    expect(decide("POST", "/api/some-new-surface")).toEqual({ kind: "deny" });
  });

  it("refuses provider sign-in, including the status read carrying a device code", () => {
    expect(decide("GET", "/api/providers")).toEqual({ kind: "allow" });
    expect(decide("GET", "/api/providers/codex/login")).toEqual({
      kind: "deny",
    });
    expect(decide("POST", "/api/providers/claude/login/code")).toEqual({
      kind: "deny",
    });
    expect(decide("POST", "/api/providers/codex/login/terminal")).toEqual({
      kind: "deny",
    });
  });

  it("refuses Issues & PRs, which spend the host's ticket credentials", () => {
    expect(decide("GET", "/api/issues")).toEqual({ kind: "deny" });
    expect(decide("GET", "/api/issues/42")).toEqual({ kind: "deny" });
  });

  it("refuses bang commands and absolute-path file reads", () => {
    expect(decide("POST", "/api/bang-commands/run")).toEqual({ kind: "deny" });
    expect(decide("GET", "/api/local-file?path=/etc/passwd")).toEqual({
      kind: "deny",
    });
  });

  it("refuses file editing and artifact rebuild on every method", () => {
    for (const [method, url] of [
      ["GET", "/api/file-edit?path=/elsewhere/x.ts"],
      ["PUT", "/api/file-edit"],
      ["POST", "/api/file-edit/rebuild"],
    ] as const) {
      expect(decide(method, url), `${method} ${url}`).toEqual({
        kind: "deny",
      });
    }
  });

  it("reads settings but never writes them", () => {
    expect(decide("GET", "/api/settings")).toEqual({ kind: "allow" });
    expect(decide("PATCH", "/api/settings")).toEqual({ kind: "deny" });
  });

  it("refuses every settings subpath, which is host administration", () => {
    for (const url of [
      "/api/settings/browser-backup",
      "/api/settings/remote-executors",
      "/api/settings/cache-miss-billing/events",
      "/api/settings/file-access",
      "/api/settings/host-awake/status",
    ]) {
      expect(decide("GET", url), url).toEqual({ kind: "deny" });
    }
  });

  it("reads the browser defaults published for them, never writes them", () => {
    const url = "/api/settings/limited-user-defaults";
    expect(decide("GET", url)).toEqual({ kind: "allow" });
    expect(decide("PUT", url)).toEqual({ kind: "deny" });
  });

  it("dictates through the configured backends but never administers them", () => {
    for (const [method, url] of [
      ["GET", "/api/speech/ws"],
      ["POST", "/api/speech/transcribe"],
      ["POST", "/api/speech/prewarm"],
      ["POST", "/api/speech/xai-client-secret"],
    ] as const) {
      expect(decide(method, url), `${method} ${url}`).toEqual({
        kind: "allow",
      });
    }
    for (const [method, url] of [
      // The raw key would outlive the session; the secret expires.
      ["POST", "/api/speech/xai-client-key"],
      ["GET", "/api/speech/backends"],
      ["POST", "/api/speech/backends/restart"],
      ["POST", "/api/speech/backends/ya-whisper/install"],
      ["POST", "/api/speech/backends/ya-whisper/gpu"],
      ["GET", "/api/speech/vocabulary"],
      ["PUT", "/api/speech/vocabulary"],
      ["POST", "/api/speech/ws"],
      ["GET", "/api/speech/transcribe"],
    ] as const) {
      expect(decide(method, url), `${method} ${url}`).toEqual({
        kind: "deny",
      });
    }
  });

  it("reads recents filtered, never clears them, and lets a visit through", () => {
    expect(decide("GET", "/api/recents?limit=5")).toEqual({
      kind: "allow-filtered",
      filter: "recents",
    });
    expect(decide("DELETE", "/api/recents")).toEqual({ kind: "deny" });
    // The route records nothing for a limited user.
    expect(decide("POST", "/api/recents/visit")).toEqual({ kind: "allow" });
    expect(decide("GET", "/api/recents/visit")).toEqual({ kind: "deny" });
  });

  it("refuses the activity REST reads, which list every connected tab", () => {
    expect(decide("GET", "/api/activity/connections")).toEqual({
      kind: "deny",
    });
    expect(decide("GET", "/api/activity/status")).toEqual({ kind: "deny" });
  });

  it("scopes a project path by method", () => {
    expect(decide("GET", "/api/projects/abc/files")).toEqual({
      kind: "project",
      projectId: "abc",
      required: "view",
    });
    expect(decide("POST", "/api/projects/abc/sessions/create")).toEqual({
      kind: "project",
      projectId: "abc",
      required: "new-session",
    });
  });

  it("lets a view grant open and start a project's app, but not stop it", () => {
    for (const action of ["open", "start"]) {
      expect(decide("POST", `/api/projects/p1/app/${action}`)).toEqual({
        kind: "project",
        projectId: "p1",
        required: "view",
      });
    }
    expect(decide("POST", "/api/projects/p1/app/stop")).toEqual({
      kind: "project",
      projectId: "p1",
      required: "new-session",
    });
  });

  it("treats opening a sandboxed session's app as acting in that session", () => {
    expect(
      decide("POST", "/api/projects/abc/sessions/s1/sandbox-apps"),
    ).toEqual({ kind: "session", sessionId: "s1", required: "join" });
  });

  it("scopes file reads and previews to a session, never the host-wide doors", () => {
    expect(decide("GET", "/api/sessions/s1/local-file?path=/tmp/a")).toEqual({
      kind: "session",
      sessionId: "s1",
      required: "view",
    });
    expect(decide("GET", "/api/sessions/s1/local-image?path=/tmp/a")).toEqual({
      kind: "session",
      sessionId: "s1",
      required: "view",
    });
    expect(decide("POST", "/api/sessions/s1/artifacts")).toEqual({
      kind: "session",
      sessionId: "s1",
      required: "join",
    });
    // The host-wide doors stay closed to them.
    expect(decide("GET", "/api/local-file?path=/tmp/a")).toEqual({
      kind: "deny",
    });
    expect(decide("POST", "/api/artifacts")).toEqual({ kind: "deny" });
  });

  it("lets a reader refresh a session's list preview, which launches nothing", () => {
    expect(
      decide("POST", "/api/projects/abc/sessions/s1/refresh-preview"),
    ).toEqual({ kind: "session", sessionId: "s1", required: "view" });
    expect(
      decide("DELETE", "/api/projects/abc/sessions/s1/refresh-preview"),
    ).toEqual({ kind: "deny" });
  });

  it("treats sending a turn as a join and anything heavier as new-session", () => {
    expect(decide("POST", "/api/sessions/s1/messages")).toEqual({
      kind: "session",
      sessionId: "s1",
      required: "join",
      startsTurn: true,
    });
    // Changing the permission mode joins the session without a turn.
    expect(decide("PUT", "/api/sessions/s1/mode")).toEqual({
      kind: "session",
      sessionId: "s1",
      required: "join",
    });
    expect(decide("POST", "/api/projects/abc/sessions/s1/fork")).toEqual({
      kind: "session",
      sessionId: "s1",
      required: "new-session",
    });
  });

  it("allows only listed session actions, whose launches apply the launch policy", () => {
    expect(decide("POST", "/api/projects/abc/sessions/s1/resume")).toEqual({
      kind: "session",
      sessionId: "s1",
      required: "new-session",
      startsTurn: true,
    });
    for (const action of [
      "reactivate",
      "fork",
      "clone",
      "stale-handoff",
      "attachments/staging/materialize",
    ]) {
      expect(
        decide("POST", `/api/projects/abc/sessions/s1/${action}`),
        action,
      ).toEqual({ kind: "session", sessionId: "s1", required: "new-session" });
    }
    for (const action of ["terminate", "archive", "done"]) {
      expect(decide("POST", `/api/sessions/s1/${action}`), action).toEqual({
        kind: "session",
        sessionId: "s1",
        required: "new-session",
      });
    }
    expect(decide("DELETE", "/api/sessions/s1/recovered-queue/q1")).toEqual({
      kind: "session",
      sessionId: "s1",
      required: "new-session",
    });
  });

  it("refuses session actions that launch a process without the launch policy", () => {
    for (const [method, url] of [
      ["POST", "/api/projects/abc/sessions/s1/restart"],
      ["POST", "/api/projects/abc/sessions/s1/recap"],
      ["POST", "/api/projects/abc/sessions/s1/retitle"],
      ["POST", "/api/projects/abc/sessions/s1/fork-summary"],
      ["POST", "/api/projects/abc/sessions/s1/rewind"],
      ["POST", "/api/projects/abc/sessions/s1/clearloop"],
      ["POST", "/api/projects/abc/sessions/s1/bang-commands"],
      ["PUT", "/api/projects/abc/sessions/s1/project"],
      ["POST", "/api/sessions/s1/recovered-queue/q1/resume"],
      ["POST", "/api/sessions/s1/recovered-queue/q1/steer"],
      ["POST", "/api/sessions/s1/some-new-launcher"],
    ] as const) {
      expect(decide(method, url), `${method} ${url}`).toEqual({
        kind: "deny",
      });
    }
  });

  it("allows the status polls every client makes, and only as reads", () => {
    expect(decide("GET", "/api/onboarding")).toEqual({ kind: "allow" });
    expect(decide("POST", "/api/onboarding/complete")).toEqual({
      kind: "deny",
    });
    expect(decide("GET", "/api/public-shares/status")).toEqual({
      kind: "allow",
    });
    expect(decide("POST", "/api/public-shares")).toEqual({ kind: "deny" });
  });

  it("allows the websocket upgrade, which is policed per message", () => {
    expect(decide("GET", "/api/ws")).toEqual({ kind: "allow" });
  });

  it("filters the lists a limited user may read", () => {
    expect(decide("GET", "/api/projects")).toEqual({
      kind: "allow-filtered",
      filter: "projects",
    });
    expect(decide("GET", "/api/sessions")).toEqual({
      kind: "allow-filtered",
      filter: "sessions",
    });
    expect(decide("POST", "/api/sessions")).toEqual({
      kind: "detached-create",
    });
    expect(decide("POST", "/api/sessions/create")).toEqual({
      kind: "detached-create",
    });
  });

  it("refuses restarting the server and updating host software", () => {
    // The client hides these notices from a limited user; the server is what
    // stops a script from firing them anyway.
    for (const [method, url] of [
      ["POST", "/api/server/restart"],
      ["POST", "/api/dev/safe-restart"],
      ["DELETE", "/api/dev/safe-restart"],
      ["POST", "/api/dev/frontend-changed"],
      ["GET", "/api/codex/updates"],
      ["POST", "/api/codex/updates/install"],
    ] as const) {
      expect(decide(method, url), `${method} ${url}`).toEqual({
        kind: "deny",
      });
    }
  });

  it("takes no project grant from a query parameter the route ignores", () => {
    // Each of these handlers ignores `projectId`; a granted id in the query
    // must not open them.
    for (const [method, url] of [
      ["POST", "/api/processes/p1/abort?projectId=granted"],
      ["POST", "/api/codex/updates/install?projectId=granted"],
      ["PUT", "/api/speech/vocabulary?projectId=granted"],
      ["GET", "/api/file-edit?projectId=granted&path=/elsewhere/x.ts"],
      ["PUT", "/api/file-edit?projectId=granted"],
      ["POST", "/api/file-edit/rebuild?projectId=granted"],
    ] as const) {
      expect(decide(method, url), `${method} ${url}`).toEqual({
        kind: "deny",
      });
    }
  });

  it("scopes a queue operation by the project in its path", () => {
    expect(
      decide("POST", "/api/project-queue/other/promote-now?projectId=granted"),
    ).toEqual({
      kind: "project",
      projectId: "other",
      required: "new-session",
      filter: "project-queue",
    });
    expect(decide("GET", "/api/project-queue")).toEqual({
      kind: "allow-filtered",
      filter: "project-queue",
    });
    // Pausing or resuming dispatch is host-wide.
    expect(
      decide("POST", "/api/project-queue/pause?projectId=granted"),
    ).toEqual({ kind: "deny" });
    expect(
      decide("POST", "/api/project-queue/resume?projectId=granted"),
    ).toEqual({ kind: "deny" });
  });

  it("refuses an id segment that is not valid percent-encoding", () => {
    expect(decide("GET", "/api/projects/%E0%A4%A/files")).toEqual({
      kind: "deny",
    });
    expect(decide("GET", "/api/sessions/%E0%A4%A")).toEqual({ kind: "deny" });
  });
});

describe("LimitedUsersService", () => {
  let dir: string;
  let service: LimitedUsersService;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "limited-users-test-"));
    service = new LimitedUsersService({ dataDir: dir });
    await service.initialize();
  });

  afterEach(async () => {
    await service.flushPendingWrites();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("stores both credential forms and returns neither", async () => {
    const summary = await service.create({
      username: "alice",
      password: "correct-horse",
      newSessionProjects: ["p1"],
    });
    expect(summary).not.toHaveProperty("passwordHash");
    expect(summary).not.toHaveProperty("srp");
    expect(summary.newSessionProjects).toEqual(["p1"]);

    const record = service.get("alice");
    expect(record?.passwordHash).toBeTypeOf("string");
    expect(record?.srp.verifier).toBeTypeOf("string");
    expect(record?.srp.salt).toBeTypeOf("string");
  });

  it("defaults and migrates template grants once, preserving explicit restrictions", async () => {
    const allowed = await service.create({
      username: "alice",
      password: "correct-horse",
      projectRoot: "~/alice",
    });
    const denied = await service.create({
      username: "reader",
      password: "correct-horse",
    });
    expect(allowed.templateCreation).toEqual({ mode: "any" });
    expect(denied.templateCreation).toEqual({ mode: "none" });
    await service.flushPendingWrites();
    const file = path.join(dir, "limited-users.json");
    const legacy = JSON.parse(await fs.readFile(file, "utf8"));
    legacy.version = 1;
    delete legacy.users.alice.templateCreation;
    delete legacy.users.reader.templateCreation;
    await fs.writeFile(file, JSON.stringify(legacy));
    const migrated = new LimitedUsersService({ dataDir: dir });
    await migrated.initialize();
    expect(migrated.getActiveGrants("alice")?.templateCreation).toEqual({
      mode: "any",
    });
    expect(migrated.getActiveGrants("reader")?.templateCreation).toEqual({
      mode: "none",
    });
    await migrated.update("alice", { templateCreation: { mode: "none" } });
    await migrated.flushPendingWrites();
    const restarted = new LimitedUsersService({ dataDir: dir });
    await restarted.initialize();
    expect(restarted.getActiveGrants("alice")?.templateCreation).toEqual({
      mode: "none",
    });
    await expect(
      restarted.update("alice", {
        templateCreation: {
          mode: "selected",
          templates: [{ sourceId: "", templateId: "app" }],
        },
      }),
    ).rejects.toThrow();
    expect(restarted.getActiveGrants("alice")?.templateCreation).toEqual({
      mode: "none",
    });
  });

  it("verifies the right password and refuses the wrong one", async () => {
    await service.create({ username: "alice", password: "correct-horse" });
    expect(await service.verifyPassword("alice", "correct-horse")).toBe(true);
    expect(await service.verifyPassword("alice", "wrong-horse")).toBe(false);
    expect(await service.verifyPassword("nobody", "correct-horse")).toBe(false);
  });

  it("answers an unknown SRP identity with an indistinguishable decoy", async () => {
    await service.create({ username: "alice", password: "correct-horse" });
    const known = service.getSrpChallengeInputs("alice");
    const unknown = service.getSrpChallengeInputs("mallory");
    expect(known.known).toBe(true);
    expect(unknown.known).toBe(false);
    expect(unknown.salt).toBeTypeOf("string");
    expect(unknown.verifier).toBeTypeOf("string");
    // The decoy is stable, so repeated probing cannot distinguish it by
    // watching the challenge change.
    expect(service.getSrpChallengeInputs("mallory")).toEqual(unknown);
  });

  it("gives each unknown identity its own salt, so a real one does not stand out", async () => {
    await service.create({ username: "alice", password: "correct-horse" });
    const alice = service.getSrpChallengeInputs("alice").salt;
    const first = service.getSrpChallengeInputs("mallory").salt;
    const second = service.getSrpChallengeInputs("trudy").salt;

    // Probing two random names and then a real one used to show the two
    // random names sharing a salt that the real name did not.
    expect(first).not.toBe(second);
    expect(new Set([alice, first, second]).size).toBe(3);
    // Same hex form and size as a salt generated for a real password: 128
    // bytes, leading zero nibbles dropped.
    for (const salt of [alice, first, second]) {
      expect(salt).toMatch(/^[0-9a-f]{240,256}$/);
    }
  });

  it("keeps an unknown identity's salt across a restart, as a real user's is", async () => {
    const before = service.getSrpChallengeInputs("mallory");
    await service.flushPendingWrites();
    const restarted = new LimitedUsersService({ dataDir: dir });
    await restarted.initialize();
    expect(restarted.getSrpChallengeInputs("mallory")).toEqual(before);
  });

  it("answers a disabled user with a decoy, not the user's own salt", async () => {
    await service.create({ username: "alice", password: "correct-horse" });
    const enabled = service.getSrpChallengeInputs("alice");
    await service.update("alice", { disabled: true });
    const disabled = service.getSrpChallengeInputs("alice");
    expect(disabled.known).toBe(false);
    expect(disabled.salt).not.toBe(enabled.salt);
  });

  it("refuses a disabled user's login and grants", async () => {
    await service.create({ username: "alice", password: "correct-horse" });
    await service.update("alice", { disabled: true });
    expect(await service.verifyPassword("alice", "correct-horse")).toBe(false);
    expect(service.getActiveGrants("alice")).toBeNull();
  });
});

describe("limited-user launch policy", () => {
  const contextFor = (principal: unknown) =>
    ({ get: () => principal }) as unknown as Parameters<
      typeof applyLimitedLaunchPolicy
    >[0];

  const alice = {
    kind: "limited",
    username: "alice",
    switched: false,
    locked: true,
    via: "direct",
    grants: {
      newSessionProjects: ["p1"],
      joinProjects: [],
      viewProjects: [],
      joinStaleOffsetMinutes: 0,
      lock: { provider: "codex", model: "gpt-5" },
    },
  };

  it("leaves the superuser's request untouched", () => {
    const body = { sandboxLevel: "none" as string | undefined };
    expect(
      applyLimitedLaunchPolicy(contextFor({ kind: "superuser" }), body),
    ).toEqual({ kind: "superuser" });
    expect(body.sandboxLevel).toBe("none");
  });

  it("forces the sandbox on and fills in the locked values", () => {
    const body: {
      sandboxLevel?: string;
      provider?: string;
      model?: string;
    } = { sandboxLevel: "none" };
    expect(applyLimitedLaunchPolicy(contextFor(alice), body)).toEqual({
      kind: "applied",
      username: "alice",
    });
    expect(body.sandboxLevel).toBe("project-write");
    expect(body.provider).toBe("codex");
    expect(body.model).toBe("gpt-5");
  });

  it("turns the network firewall on when the request names none", () => {
    const body: { sandboxNetworkFirewall?: boolean } = {};
    expect(applyLimitedLaunchPolicy(contextFor(alice), body).kind).toBe(
      "applied",
    );
    expect(body.sandboxNetworkFirewall).toBe(true);
  });

  it("refuses a request that turns the network firewall off", () => {
    const body = {
      sandboxLevel: "project-write",
      sandboxNetworkFirewall: false,
    };
    expect(applyLimitedLaunchPolicy(contextFor(alice), body)).toEqual({
      kind: "error",
      error:
        "This user's sessions always run with the sandbox network firewall on",
    });
    expect(body.sandboxNetworkFirewall).toBe(false);
  });

  it("holds a queued new-session target to the same firewall rule", () => {
    const refused = limitQueuedLaunch(alice.grants, {
      target: {
        type: "new-session",
        sandboxLevel: "project-write",
        sandboxNetworkFirewall: false,
      },
      message: { text: "go" },
    });
    expect(refused?.error).toContain("network firewall");
    const target = { type: "new-session" as const };
    expect(
      limitQueuedLaunch(alice.grants, { target, message: { text: "go" } }),
    ).toBeNull();
    expect(target).toMatchObject({
      sandboxLevel: "project-write",
      sandboxNetworkFirewall: true,
    });
  });

  it("refuses a request that names a value outside the lock", () => {
    const outcome = applyLimitedLaunchPolicy(contextFor(alice), {
      provider: "claude",
    });
    expect(outcome.kind).toBe("error");
  });

  it("refuses a remote executor or computer control, which leave the sandbox", () => {
    expect(
      applyLimitedLaunchPolicy(contextFor(alice), { executor: "devbox" }),
    ).toEqual({
      kind: "error",
      error:
        "This user's sessions run only on this host, not on a remote executor",
    });
    expect(
      applyLimitedLaunchPolicy(contextFor(alice), { computerControl: true })
        .kind,
    ).toBe("error");
  });

  describe("resuming an existing session", () => {
    const sandboxed = (): ModelSettings => ({
      providerName: "codex",
      model: "gpt-4",
      requestedModel: "gpt-4",
      sandboxLevel: "project-write",
    });

    it("leaves the superuser's settings untouched", () => {
      const settings: ModelSettings = { sandboxLevel: "none" };
      expect(
        applyLimitedResumePolicy(
          contextFor({ kind: "superuser" }),
          settings,
          {},
        ),
      ).toEqual({ kind: "superuser" });
      expect(settings.sandboxLevel).toBe("none");
    });

    it("refuses a session that runs outside the sandbox", () => {
      for (const sandboxLevel of [undefined, "none"] as const) {
        const outcome = applyLimitedResumePolicy(
          contextFor(alice),
          { ...sandboxed(), sandboxLevel },
          {},
        );
        expect(outcome.kind, String(sandboxLevel)).toBe("error");
      }
    });

    it("refuses a sandboxed session whose network firewall is off", () => {
      const outcome = applyLimitedResumePolicy(
        contextFor(alice),
        { ...sandboxed(), sandboxNetworkFirewall: false },
        {},
      );
      expect(outcome).toMatchObject({
        kind: "error",
        error: expect.stringContaining("without the sandbox network firewall"),
      });
      // Absent is on, as at every launch.
      expect(
        applyLimitedResumePolicy(contextFor(alice), sandboxed(), {}).kind,
      ).toBe("applied");
    });

    it("refuses a session on a remote executor", () => {
      expect(
        applyLimitedResumePolicy(
          contextFor(alice),
          { ...sandboxed(), executor: "devbox" },
          {},
        ).kind,
      ).toBe("error");
    });

    it("refuses a session whose provider is outside the lock", () => {
      expect(
        applyLimitedResumePolicy(
          contextFor(alice),
          { ...sandboxed(), providerName: "claude" },
          {},
        ).kind,
      ).toBe("error");
    });

    it("refuses a requested model outside the lock", () => {
      expect(
        applyLimitedResumePolicy(contextFor(alice), sandboxed(), {
          model: "gpt-4",
        }).kind,
      ).toBe("error");
    });

    it("replaces the session's persisted model and effort with the locked ones", () => {
      const withEffort = {
        ...alice,
        grants: {
          ...alice.grants,
          lock: { ...alice.grants.lock, effort: "medium" },
        },
      };
      const settings = sandboxed();
      expect(
        applyLimitedResumePolicy(contextFor(withEffort), settings, {}),
      ).toEqual({
        kind: "applied",
        username: "alice",
      });
      expect(settings.model).toBe("gpt-5");
      expect(settings.requestedModel).toBe("gpt-5");
      expect(settings.effort).toBe("medium");
    });
  });

  describe("a locked effort against the request's thinking option", () => {
    const withEffort = {
      ...alice,
      grants: { ...alice.grants, lock: { effort: "medium" } },
    };

    it("accepts the same effort written as a thinking option", () => {
      const body: { thinking?: string } = { thinking: "on:medium" };
      expect(applyLimitedLaunchPolicy(contextFor(withEffort), body).kind).toBe(
        "applied",
      );
      expect(body.thinking).toBe("on:medium");
    });

    it("fills in the locked effort when the request names none", () => {
      for (const thinking of [undefined, "off", "auto"]) {
        const body: { thinking?: string } = { thinking };
        expect(
          applyLimitedLaunchPolicy(contextFor(withEffort), body).kind,
        ).toBe("applied");
        expect(body.thinking).toBe("on:medium");
      }
    });

    it("refuses a different effort", () => {
      const outcome = applyLimitedLaunchPolicy(contextFor(withEffort), {
        thinking: "on:max",
      });
      expect(outcome).toEqual({
        kind: "error",
        error: 'This user is limited to effort "medium"',
      });
    });
  });
});

describe("limited-user middleware", () => {
  let dir: string;
  let service: LimitedUsersService;

  const buildApp = async (options?: { now?: () => number }) => {
    const app = new Hono();
    const sessions = new Map<
      string,
      {
        projectId: string;
        provider: string;
        lastActivityMs: number;
        sandboxLevel?: string;
        createdByUser?: string;
      }
    >([
      [
        "own",
        {
          projectId: "view-project",
          provider: "codex",
          lastActivityMs: 0,
          sandboxLevel: "project-write",
          createdByUser: "alice",
        },
      ],
      [
        "fresh",
        {
          projectId: "join-project",
          provider: "codex",
          lastActivityMs: 0,
          sandboxLevel: "project-write",
        },
      ],
      [
        "unsandboxed",
        { projectId: "join-project", provider: "codex", lastActivityMs: 0 },
      ],
    ]);
    const now = options?.now ?? (() => 0);
    const resolver = new SessionAccessResolver({
      getLiveSession: () => undefined,
      readCatalogRows: async () =>
        [...sessions].map(([sessionId, row]) => ({
          sessionId,
          projectId: row.projectId,
          provider: row.provider,
          updatedAt: new Date(row.lastActivityMs).toISOString(),
        })),
      getSessionMetadata: (sessionId) => ({
        sandboxLevel: sessions.get(sessionId)?.sandboxLevel,
        createdByUser: sessions.get(sessionId)?.createdByUser,
      }),
      now,
    });
    app.use(
      "/api/*",
      createLimitedUsersMiddleware({
        getActiveGrants: (username) => service.getActiveGrants(username),
        sessionAccess: resolver,
        getSuperuserIdentity: () => "owner",
        getCookieSessionUsername: async () => "alice",
        getCookieSecret: () => "secret",
      }),
    );
    app.get("/api/projects", (c) =>
      c.json({
        projects: [{ id: "view-project" }, { id: "secret-project" }],
      }),
    );
    app.get("/api/recents", (c) =>
      c.json({
        recents: [
          { sessionId: "visible", projectId: "view-project" },
          { sessionId: "hidden", projectId: "secret-project" },
        ],
        visits: [
          { sessionId: "pending-visible", projectId: "view-project" },
          { sessionId: "pending-hidden", projectId: "secret-project" },
        ],
      }),
    );
    app.get("/api/sessions", (c) =>
      c.json({
        sessions: [
          { id: "a", projectId: "view-project" },
          { id: "b", projectId: "secret-project" },
        ],
        projects: [
          { id: "view-project", name: "Visible" },
          { id: "secret-project", name: "Secret" },
        ],
      }),
    );
    const queueResponse = {
      items: [
        {
          id: "visible-q",
          projectId: "view-project",
          message: { text: "Visible work" },
        },
        {
          id: "hidden-q",
          projectId: "secret-project",
          message: {
            text: "Secret owner instruction",
            attachments: [{ path: "/secret/upload.txt" }],
          },
        },
      ],
      recoveredSessionQueues: [
        {
          id: "visible-r",
          projectId: "view-project",
          content: "Visible recovered work",
        },
        {
          id: "hidden-r",
          projectId: "secret-project",
          content: "Secret recovered work",
        },
      ],
      projectStatuses: {
        "view-project": { projectId: "view-project", state: "ready" },
        "secret-project": { projectId: "secret-project", state: "blocked" },
      },
      dispatchState: { status: "paused", reason: "manual" },
      futureHostField: { secret: true },
    };
    app.get("/api/project-queue", (c) => c.json(queueResponse));
    app.post("/api/project-queue/:projectId/promote-now", (c) =>
      c.json({
        ...queueResponse,
        promoteResult: {
          promoted: true,
          reason: "promoted",
          status: { projectId: c.req.param("projectId"), state: "empty" },
        },
      }),
    );
    app.get("/api/projects/:projectId/files", (c) => c.json({ ok: true }));
    app.get("/api/sessions/:sessionId", (c) => c.json({ ok: true }));
    app.post("/api/sessions/:sessionId/messages", (c) => c.json({ ok: true }));
    app.put("/api/sessions/:sessionId/mode", (c) => c.json({ ok: true }));
    app.post("/api/sessions/:sessionId/input", (c) => c.json({ ok: true }));
    app.post("/api/sessions/:sessionId/mark-seen", (c) => c.json({ ok: true }));
    app.post("/api/projects/:projectId/sessions/:sessionId/resume", (c) =>
      c.json({ ok: true }),
    );
    app.post(
      "/api/projects/:projectId/sessions/:sessionId/stale-handoff",
      (c) => c.json({ ok: true }),
    );
    app.get("/api/issues", (c) => c.json({ issues: [] }));
    app.post("/api/speech/transcribe", (c) => c.json({ text: "hi" }));
    app.post("/api/speech/xai-client-secret", (c) =>
      c.json({ clientSecret: "ephemeral" }),
    );
    app.post("/api/speech/xai-client-key", (c) => c.json({ apiKey: "raw" }));
    app.get("/api/speech/backends", (c) => c.json({ catalog: [] }));
    return app;
  };

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "limited-users-mw-"));
    service = new LimitedUsersService({ dataDir: dir });
    await service.initialize();
    await service.create({
      username: "alice",
      password: "correct-horse",
      newSessionProjects: ["view-project"],
      joinProjects: ["join-project"],
      joinStaleOffsetMinutes: 0,
    });
  });

  afterEach(async () => {
    await service.flushPendingWrites();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("lets a limited login dictate but not administer speech", async () => {
    const app = await buildApp();
    const post = (url: string) => app.request(url, { method: "POST" });
    expect((await post("/api/speech/transcribe")).status).toBe(200);
    expect((await post("/api/speech/xai-client-secret")).status).toBe(200);
    expect((await post("/api/speech/xai-client-key")).status).toBe(403);
    expect((await app.request("/api/speech/backends")).status).toBe(403);
  });

  it("answers 404, not 403, for a project outside the grants", async () => {
    const app = await buildApp();
    const denied = await app.request("/api/projects/secret-project/files");
    expect(denied.status).toBe(404);
    const allowed = await app.request("/api/projects/view-project/files");
    expect(allowed.status).toBe(200);
  });

  it("removes inaccessible rows from lists it does serve", async () => {
    const app = await buildApp();
    const recents = await (
      await app.request("/api/recents?summaryMode=retained")
    ).json();
    expect(recents).toEqual({
      recents: [{ sessionId: "visible", projectId: "view-project" }],
      visits: [{ sessionId: "pending-visible", projectId: "view-project" }],
    });
    const projects = (await (
      await app.request("/api/projects?summaryMode=retained")
    ).json()) as {
      projects: Array<{ id: string }>;
    };
    expect(projects.projects.map((p) => p.id)).toEqual(["view-project"]);

    const sessions = (await (await app.request("/api/sessions")).json()) as {
      sessions: Array<{ id: string }>;
    };
    expect(sessions.sessions.map((s) => s.id)).toEqual(["a"]);
    expect(
      (sessions as unknown as { projects: Array<{ id: string }> }).projects.map(
        (project) => project.id,
      ),
    ).toEqual(["view-project"]);
  });

  it.each(["direct", "relay"] as const)(
    "projects the global queue for a %s limited login",
    async (via) => {
      const app = await buildApp();
      const env =
        via === "relay"
          ? {
              [AUTHENTICATED_SRP_TRANSPORT]: {
                kind: "srp" as const,
                username: "alice",
              },
            }
          : {};
      const response = await app.request("/api/project-queue", {}, env);
      const body = (await response.json()) as Record<string, unknown> & {
        items: Array<{ id: string }>;
        recoveredSessionQueues: Array<{ id: string }>;
        projectStatuses: Record<string, unknown>;
      };
      expect(body.items.map((item) => item.id)).toEqual(["visible-q"]);
      expect(body.recoveredSessionQueues.map((item) => item.id)).toEqual([
        "visible-r",
      ]);
      expect(Object.keys(body.projectStatuses)).toEqual(["view-project"]);
      expect(body.dispatchState).toEqual({
        status: "paused",
        reason: "manual",
      });
      expect(body).not.toHaveProperty("futureHostField");
    },
  );

  it("projects the global snapshot returned by promote-now", async () => {
    const app = await buildApp();
    const response = await app.request(
      "/api/project-queue/view-project/promote-now",
      { method: "POST" },
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      items: Array<{ id: string }>;
      promoteResult?: { status?: { projectId?: string } };
    };
    expect(body.items.map((item) => item.id)).toEqual(["visible-q"]);
    expect(body.promoteResult?.status?.projectId).toBe("view-project");
  });

  it("refuses Issues & PRs at the operation, not only in the nav", async () => {
    const app = await buildApp();
    expect((await app.request("/api/issues")).status).toBe(403);
  });

  it("judges the path Hono routes, not its percent-encoded spelling", async () => {
    const app = await buildApp();
    // Hono decodes these onto the /api/issues and project-files handlers.
    expect(
      (await app.request("/api/%69ssues?projectId=view-project")).status,
    ).toBe(403);
    expect(
      (
        await app.request(
          "/api/%70rojects/secret-project/files?projectId=view-project",
        )
      ).status,
    ).toBe(404);
    expect(
      (await app.request("/api/%70rojects/view-project/files")).status,
    ).toBe(200);
  });

  it("allows a turn in a fresh joinable session and refuses a cold one", async () => {
    const fresh = await buildApp({ now: () => 5 * 60 * 1000 });
    expect(
      (await fresh.request("/api/sessions/fresh/messages", { method: "POST" }))
        .status,
    ).toBe(200);

    // Codex's believed cache-warm window is ten minutes; past it the session
    // is read-only for this user.
    const cold = await buildApp({ now: () => 30 * 60 * 1000 });
    const response = await cold.request("/api/sessions/fresh/messages", {
      method: "POST",
    });
    expect(response.status).toBe(403);
    const body = (await response.json()) as {
      reason?: string;
      staleRedirect?: string;
    };
    expect(body.reason).toBe("stale-session");
    // A join grant cannot start the session a redirect would need.
    expect(body.staleRedirect).toBeUndefined();
  });

  it("applies the cutoff to a session the user started, and to its resume", async () => {
    const cold = await buildApp({ now: () => 30 * 60 * 1000 });
    for (const path of [
      "/api/sessions/own/messages",
      "/api/projects/view-project/sessions/own/resume",
    ]) {
      const response = await cold.request(path, { method: "POST" });
      expect(response.status, path).toBe(403);
      expect(await response.json(), path).toMatchObject({
        reason: "stale-session",
        staleRedirect: "stale-handoff",
      });
    }

    const fresh = await buildApp({ now: () => 5 * 60 * 1000 });
    expect(
      (
        await fresh.request("/api/projects/view-project/sessions/own/resume", {
          method: "POST",
        })
      ).status,
    ).toBe(200);
  });

  it("leaves actions that start no turn open on a cold session", async () => {
    const cold = await buildApp({ now: () => 30 * 60 * 1000 });
    for (const [method, path] of [
      ["POST", "/api/sessions/own/mark-seen"],
      ["PUT", "/api/sessions/own/mode"],
      ["POST", "/api/projects/view-project/sessions/own/stale-handoff"],
    ] as const) {
      expect((await cold.request(path, { method })).status, path).toBe(200);
    }
  });

  it("refuses every join action on a fresh session outside the sandbox", async () => {
    const app = await buildApp({ now: () => 5 * 60 * 1000 });
    for (const [method, action] of [
      ["POST", "messages"],
      ["PUT", "mode"],
      ["POST", "input"],
    ] as const) {
      const response = await app.request(
        `/api/sessions/unsandboxed/${action}`,
        { method },
      );
      expect(response.status, action).toBe(403);
      expect(
        ((await response.json()) as { reason?: string }).reason,
        action,
      ).toBe("unsandboxed-session");
    }
    // Reading it stays open to a joiner.
    expect((await app.request("/api/sessions/unsandboxed")).status).toBe(200);
  });

  it("answers 401 once the logged-in user is disabled", async () => {
    await service.update("alice", { disabled: true });
    const app = await buildApp();
    const response = await app.request("/api/projects");
    expect(response.status).toBe(401);
  });

  it("refuses a limited relay login that has no active grants", async () => {
    // With the feature off no limited user has active grants.
    const app = new Hono();
    app.use(
      "/api/*",
      createLimitedUsersMiddleware({
        getActiveGrants: () => null,
        sessionAccess: new SessionAccessResolver({
          getLiveSession: () => undefined,
          readCatalogRows: async () => [],
          getSessionMetadata: () => undefined,
        }),
        getSuperuserIdentity: () => "owner",
        getCookieSessionUsername: async () => null,
        getCookieSecret: () => "secret",
      }),
    );
    app.get("/api/issues", (c) => c.json({ ok: true }));
    const relayLogin = (username: string) => ({
      [AUTHENTICATED_SRP_TRANSPORT]: { kind: "srp", username },
    });

    expect(
      (await app.request("/api/issues", {}, relayLogin("alice"))).status,
    ).toBe(401);
    expect(
      (await app.request("/api/issues", {}, relayLogin("owner"))).status,
    ).toBe(200);
  });

  it("acts as the superuser when the acting cookie names nobody", async () => {
    const app = new Hono();
    app.use(
      "/api/*",
      createLimitedUsersMiddleware({
        getActiveGrants: (username) => service.getActiveGrants(username),
        sessionAccess: new SessionAccessResolver({
          getLiveSession: () => undefined,
          readCatalogRows: async () => [],
          getSessionMetadata: () => undefined,
        }),
        getSuperuserIdentity: () => "owner",
        getCookieSessionUsername: async () => null,
        getCookieSecret: () => "secret",
      }),
    );
    app.get("/api/issues", (c) =>
      c.json({
        principal: (c as unknown as { get: (key: string) => unknown }).get(
          PRINCIPAL_VARIABLE,
        ),
      }),
    );
    const response = await app.request("/api/issues");
    expect(response.status).toBe(200);
    expect(
      ((await response.json()) as { principal: { kind: string } }).principal,
    ).toEqual({ kind: "superuser" });
  });

  it("honors a signed acting-user cookie for a superuser login", async () => {
    const app = new Hono();
    app.use(
      "/api/*",
      createLimitedUsersMiddleware({
        getActiveGrants: (username) => service.getActiveGrants(username),
        sessionAccess: new SessionAccessResolver({
          getLiveSession: () => undefined,
          readCatalogRows: async () => [],
          getSessionMetadata: () => undefined,
        }),
        getSuperuserIdentity: () => "owner",
        getCookieSessionUsername: async () => null,
        getCookieSecret: () => "secret",
      }),
    );
    app.get("/api/issues", (c) => c.json({ ok: true }));

    const switched = await app.request("/api/issues", {
      headers: {
        Cookie: `yep-anywhere-acting-user=${signActingUser("alice", "secret")}`,
      },
    });
    expect(switched.status).toBe(403);

    // A forged cookie is not a switch; the request stays the superuser's.
    const forged = await app.request("/api/issues", {
      headers: { Cookie: "yep-anywhere-acting-user=alice.deadbeef" },
    });
    expect(forged.status).toBe(200);
  });
});

describe("session access resolver", () => {
  /** topics/limited-users.md § Delivery v1 — Freshness. */
  const hours = (count: number) => count * 60 * 60 * 1000;
  const now = hours(10);

  it("observes newly published sessions and revoked identities inside the TTL", async () => {
    let version = "epoch:1";
    let rows: Array<{ sessionId: string; projectId: string }> = [];
    let reads = 0;
    const resolver = new SessionAccessResolver({
      getLiveSession: () => undefined,
      getSessionMetadata: () => undefined,
      getCatalogVersion: () => version,
      readCatalogRows: async () => {
        reads += 1;
        return rows;
      },
      now: () => now,
    });
    expect(await resolver.resolve("new-session")).toBeNull();
    expect(await resolver.resolve("another-missing-id")).toBeNull();
    expect(reads).toBe(2);
    rows = [{ sessionId: "new-session", projectId: "owned-project" }];
    version = "epoch:2";
    expect((await resolver.resolve("new-session"))?.projectId).toBe(
      "owned-project",
    );
    expect(reads).toBe(3);
    rows.push({ sessionId: "new-session", projectId: "other-project" });
    version = "epoch:3";
    expect(await resolver.resolve("new-session")).toBeNull();
    rows = [];
    version = "replacement-epoch:0";
    expect(await resolver.resolve("new-session")).toBeNull();
    expect(reads).toBe(5);
  });

  it("throttles failed catalog reads per version and retries on publication", async () => {
    let version = "epoch:1";
    let reads = 0;
    const resolver = new SessionAccessResolver({
      getLiveSession: () => undefined,
      getSessionMetadata: () => undefined,
      getCatalogVersion: () => version,
      readCatalogRows: async () => {
        reads += 1;
        if (reads === 1) throw new Error("catalog read failed");
        return [{ sessionId: "published", projectId: "owned-project" }];
      },
      now: () => now,
    });
    await expect(resolver.resolve("published")).rejects.toThrow(
      "catalog read failed",
    );
    expect(await resolver.resolve("published")).toBeNull();
    expect(reads).toBe(1);
    version = "epoch:2";
    expect((await resolver.resolve("published"))?.projectId).toBe(
      "owned-project",
    );
    expect(reads).toBe(2);
  });

  it("does not consume a publication that races an in-flight read", async () => {
    let version = "epoch:1";
    let reads = 0;
    let release!: (
      rows: Array<{ sessionId: string; projectId: string }>,
    ) => void;
    const pendingRows = new Promise<
      Array<{ sessionId: string; projectId: string }>
    >((resolve) => {
      release = resolve;
    });
    const resolver = new SessionAccessResolver({
      getLiveSession: () => undefined,
      getSessionMetadata: () => undefined,
      getCatalogVersion: () => version,
      readCatalogRows: async () => {
        reads += 1;
        return reads === 1
          ? pendingRows
          : [{ sessionId: "published", projectId: "owned-project" }];
      },
      now: () => now,
    });
    const first = resolver.resolve("published");
    const coalesced = resolver.resolve("published");
    version = "epoch:2";
    release([]);
    expect((await first)?.projectId).toBe("owned-project");
    expect((await coalesced)?.projectId).toBe("owned-project");
    expect(reads).toBe(2);
    expect((await resolver.resolve("published"))?.projectId).toBe(
      "owned-project",
    );
    expect(reads).toBe(2);
  });

  it("does not reuse obsolete positive facts after a failed refresh", async () => {
    let version = "epoch:1";
    let reads = 0;
    const resolver = new SessionAccessResolver({
      getLiveSession: () => undefined,
      getSessionMetadata: () => undefined,
      getCatalogVersion: () => version,
      readCatalogRows: async () => {
        reads += 1;
        if (reads > 1) throw new Error("replacement unreadable");
        return [{ sessionId: "allowed", projectId: "granted" }];
      },
      now: () => now,
    });
    expect((await resolver.resolve("allowed"))?.projectId).toBe("granted");
    version = "epoch:2";
    await expect(resolver.resolve("allowed")).rejects.toThrow(
      "replacement unreadable",
    );
    expect(await resolver.resolve("allowed")).toBeNull();
    expect(await resolver.resolve("allowed")).toBeNull();
    expect(reads).toBe(2);
  });

  it("keeps fully observed live sessions independent of catalog publication and failures", async () => {
    const resolver = new SessionAccessResolver({
      getLiveSession: () => ({
        projectId: "live-project",
        lastActivityMs: now,
      }),
      getSessionMetadata: () => undefined,
      getCatalogVersion: () => "new-publication",
      readCatalogRows: async () => {
        throw new Error("must not read catalog");
      },
      now: () => now,
    });
    expect((await resolver.resolve("live"))?.projectId).toBe("live-project");
    expect(resolver.resolveKnown("live")?.projectId).toBe("live-project");
  });

  it("does not return an old positive mapping when both bounded reads are superseded", async () => {
    let generation = 1;
    let reads = 0;
    const resolver = new SessionAccessResolver({
      getLiveSession: () => undefined,
      getSessionMetadata: () => undefined,
      getCatalogVersion: () => `epoch:${generation}`,
      readCatalogRows: async () => {
        reads += 1;
        generation += 1;
        return [{ sessionId: "old", projectId: "granted" }];
      },
      now: () => now,
    });
    expect(await resolver.resolve("old")).toBeNull();
    expect(reads).toBe(2);
  });

  it("dates a live process that has seen no provider message by its catalog row", async () => {
    const resolver = new SessionAccessResolver({
      getLiveSession: () => ({
        projectId: "join-project",
        provider: "claude",
        lastActivityMs: null,
      }),
      readCatalogRows: async () => [
        {
          sessionId: "resumed",
          projectId: "join-project",
          provider: "claude",
          updatedAt: new Date(now - hours(3)).toISOString(),
        },
      ],
      getSessionMetadata: () => undefined,
      now: () => now,
    });
    const facts = await resolver.resolve("resumed");
    expect(facts?.lastActivityMs).toBe(now - hours(3));
    expect(facts && resolver.isFresh(facts, { offsetMinutes: 0 })).toBe(false);
  });

  it("dates a live process by its last provider message", async () => {
    const resolver = new SessionAccessResolver({
      getLiveSession: () => ({
        projectId: "join-project",
        provider: "claude",
        lastActivityMs: now - hours(2),
      }),
      readCatalogRows: async () => [],
      getSessionMetadata: () => undefined,
      now: () => now,
    });
    const facts = await resolver.resolve("running");
    expect(facts && resolver.isFresh(facts, { offsetMinutes: 0 })).toBe(false);
  });

  it("takes a live process's sandbox over the level its metadata recorded", async () => {
    const resolverFor = (sandboxed: boolean) =>
      new SessionAccessResolver({
        getLiveSession: () => ({
          projectId: "join-project",
          provider: "claude",
          lastActivityMs: now,
          sandboxed,
        }),
        readCatalogRows: async () => [],
        getSessionMetadata: () => ({ sandboxLevel: "project-write" }),
        now: () => now,
      });
    expect((await resolverFor(false).resolve("running"))?.sandboxed).toBe(
      false,
    );
    expect((await resolverFor(true).resolve("running"))?.sandboxed).toBe(true);
  });

  it("resolves no project for a session the catalog files under two", async () => {
    const resolver = new SessionAccessResolver({
      getLiveSession: () => undefined,
      readCatalogRows: async () => [
        { sessionId: "twice", projectId: "view-project" },
        { sessionId: "twice", projectId: "secret-project" },
      ],
      getSessionMetadata: () => undefined,
    });
    expect(await resolver.resolve("twice")).toBeNull();
  });
});

describe("user turn attribution", () => {
  /** topics/limited-users.md § Delivery v1 — Usage. */
  const contextFor = (principal: unknown) =>
    ({ get: () => principal }) as unknown as Parameters<
      typeof actingUsername
    >[0];

  it("names the acting limited user, including a switched superuser", () => {
    expect(
      actingUsername(
        contextFor({ kind: "limited", username: "archer", switched: false }),
      ),
    ).toBe("archer");
    expect(
      actingUsername(
        contextFor({ kind: "limited", username: "archer", switched: true }),
      ),
    ).toBe("archer");
  });

  it("leaves the superuser unnamed, which is what absent means", () => {
    expect(actingUsername(contextFor({ kind: "superuser" }))).toBe(undefined);
    expect(actingUsername(contextFor(undefined))).toBe(undefined);
  });

  it("stamps the sender from the principal, never from the request body", () => {
    const metadata = buildUserMessageMetadata(
      // A client claiming to be somebody else.
      { messageMetadata: { sentByUser: "lana" } } as never,
      1000,
      "direct",
      "archer",
    );
    expect(metadata.sentByUser).toBe("archer");
  });

  it("omits the sender for the superuser rather than writing a name", () => {
    const metadata = buildUserMessageMetadata({}, 1000, "direct");
    expect(metadata.sentByUser).toBe(undefined);
  });
});
