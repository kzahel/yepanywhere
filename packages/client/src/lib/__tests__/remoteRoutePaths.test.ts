import { describe, expect, it } from "vitest";
import {
  getLegacyRelayRedirectTarget,
  getRelayBasePath,
  getRelayCanonicalRedirectTarget,
  getRelayUsernameFromRoute,
  getSafeRemoteReturnTarget,
  matchesRelayLoginTarget,
} from "../remoteRoutePaths";

describe("relay route parsing", () => {
  it("reads a relay username from the canonical namespace", () => {
    expect(getRelayUsernameFromRoute("/-/relay/macbook/projects")).toBe(
      "macbook",
    );
  });

  it("allows reserved app names only in the canonical namespace", () => {
    expect(getRelayUsernameFromRoute("/-/relay/projects/sessions")).toBe(
      "projects",
    );
    expect(getRelayUsernameFromRoute("/projects/sessions")).toBe(null);
  });

  it("still reads unambiguous legacy relay routes", () => {
    expect(getRelayUsernameFromRoute("/macbook/projects")).toBe("macbook");
  });

  it("rejects malformed canonical relay usernames", () => {
    expect(getRelayUsernameFromRoute("/-/relay/ab/projects")).toBe(null);
    expect(getRelayUsernameFromRoute("/-/relay/%GG/projects")).toBe(null);
  });
});

describe("relay route formatting", () => {
  it("formats relay hosts under the reserved canonical namespace", () => {
    expect(getRelayBasePath("macbook")).toBe("/-/relay/macbook");
  });

  it("redirects direct app routes into the active relay namespace", () => {
    expect(
      getRelayCanonicalRedirectTarget(
        {
          pathname: "/projects",
          search: "?queueItem=item-1",
          hash: "#top",
        },
        "macbook",
      ),
    ).toBe("/-/relay/macbook/projects?queueItem=item-1#top");
  });

  it("redirects the direct index route to relay projects", () => {
    expect(getRelayCanonicalRedirectTarget({ pathname: "/" }, "macbook")).toBe(
      "/-/relay/macbook/projects",
    );
  });

  it("does not redirect routes already under the canonical relay namespace", () => {
    expect(
      getRelayCanonicalRedirectTarget(
        { pathname: "/-/relay/macbook/projects" },
        "macbook",
      ),
    ).toBe(null);
  });

  it("canonicalizes an active host's legacy route", () => {
    expect(
      getRelayCanonicalRedirectTarget(
        { pathname: "/macbook/bang-commands" },
        "macbook",
      ),
    ).toBe("/-/relay/macbook/bang-commands");
  });

  it("does not redirect when no relay host is active", () => {
    expect(
      getRelayCanonicalRedirectTarget({ pathname: "/projects" }, null),
    ).toBe(null);
  });

  it("does not redirect paths owned by another relay host", () => {
    expect(
      getRelayCanonicalRedirectTarget(
        { pathname: "/other-host/projects" },
        "macbook",
      ),
    ).toBe(null);
  });
});

describe("getLegacyRelayRedirectTarget", () => {
  it("preserves the app path, search, and hash", () => {
    expect(
      getLegacyRelayRedirectTarget({
        pathname: "/macbook/projects/project-1",
        search: "?queueItem=item-1",
        hash: "#top",
      }),
    ).toBe("/-/relay/macbook/projects/project-1?queueItem=item-1#top");
  });

  it("sends a legacy host root to projects", () => {
    expect(getLegacyRelayRedirectTarget({ pathname: "/macbook" })).toBe(
      "/-/relay/macbook/projects",
    );
  });

  it.each([
    "activity",
    "agents",
    "bang-commands",
    "devices",
    "git-status",
    "inbox",
    "issues",
    "login",
    "new-session",
    "projects",
    "remote",
    "sessions",
    "settings",
    "share",
  ])(
    "never reinterprets reserved segment %s as a relay username",
    (segment) => {
      expect(
        getLegacyRelayRedirectTarget({ pathname: `/${segment}/projects` }),
      ).toBe(null);
    },
  );

  it("rejects invalid relay usernames", () => {
    expect(getLegacyRelayRedirectTarget({ pathname: "/ab/projects" })).toBe(
      null,
    );
  });
});

describe("getSafeRemoteReturnTarget", () => {
  it("redirects direct return targets into the active relay namespace", () => {
    expect(
      getSafeRemoteReturnTarget("/projects?queueItem=item-1#top", "macbook"),
    ).toBe("/-/relay/macbook/projects?queueItem=item-1#top");
  });

  it("redirects the direct index return target to relay projects", () => {
    expect(getSafeRemoteReturnTarget("/", "macbook")).toBe(
      "/-/relay/macbook/projects",
    );
  });

  it("preserves already canonical relay return targets", () => {
    expect(
      getSafeRemoteReturnTarget("/-/relay/macbook/projects", "macbook"),
    ).toBe("/-/relay/macbook/projects");
  });

  it("canonicalizes an active host's legacy return target", () => {
    expect(getSafeRemoteReturnTarget("/macbook/projects", "macbook")).toBe(
      "/-/relay/macbook/projects",
    );
  });

  it("rejects a return target scoped to a different relay host", () => {
    expect(
      getSafeRemoteReturnTarget(
        "/macbook/projects/project-1/sessions/session-1?from=login#turn",
        "laptop",
      ),
    ).toBe(null);
  });

  it("preserves direct return targets when no relay host is active", () => {
    expect(getSafeRemoteReturnTarget("/projects", null)).toBe("/projects");
  });

  it("rejects protocol-relative return targets", () => {
    expect(getSafeRemoteReturnTarget("//example.com/projects", "macbook")).toBe(
      null,
    );
  });

  it("rejects backslash authority return targets", () => {
    expect(getSafeRemoteReturnTarget("/\\evil.example/projects", null)).toBe(
      null,
    );
  });

  it("rejects login return targets", () => {
    expect(
      getSafeRemoteReturnTarget("/login?returnTo=/projects", "macbook"),
    ).toBe(null);
  });
});

describe("explicit relay login targets", () => {
  const location = {
    pathname: "/login/relay",
    search: "?u=studio&r=wss%3A%2F%2Fprivate.test%2Fws",
  };
  it("keeps a different machine or relay on the selected sign-in form", () => {
    expect(
      matchesRelayLoginTarget(location, "laptop", "wss://private.test/ws"),
    ).toBe(false);
    expect(
      matchesRelayLoginTarget(location, "studio", "wss://public.test/ws"),
    ).toBe(false);
    expect(matchesRelayLoginTarget(location, null, null)).toBe(false);
  });
  it("allows the exact signed-in target and ordinary unspecified login", () => {
    expect(
      matchesRelayLoginTarget(location, "studio", "wss://private.test/ws"),
    ).toBe(true);
    expect(
      matchesRelayLoginTarget(
        { pathname: "/login/relay" },
        "studio",
        "wss://private.test/ws",
      ),
    ).toBe(true);
  });
});
