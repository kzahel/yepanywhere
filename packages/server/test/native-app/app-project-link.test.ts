import { nativeAppTestFixture } from "./fixture.js";
import { mkdir, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { toUrlProjectId } from "@yep-anywhere/shared";
import { afterEach, describe, expect, it } from "vitest";
import { appBarrier } from "../native-provider/app-fixture.js";

let fixture: Awaited<ReturnType<typeof nativeAppTestFixture>> | undefined;
afterEach(async (context) => {
  if (fixture && context.task.result?.state === "fail")
    console.info(await fixture.diagnostics());
  await fixture?.close();
  fixture = undefined;
});

/**
 * A project selected through a symbolic link is the folder the link named
 * (topics/project-paths.md). The real providers matter here: Claude records
 * the folder its process ran in whatever it was given, while Codex records
 * and re-reads the path it was given, so only actual tool output shows where
 * a resumed conversation works.
 */
describe.runIf(process.env.YEP_NATIVE_APP_TESTS === "1")(
  "a project selected through a link",
  () => {
    it.for(["claude", "codex"] as const)(
      "%s keeps the session in the folder the link named",
      {
        // Slowest observed: 37.2s for Claude and 28.3s for Codex on a
        // 4-core, 4 GB Linux arm64 VM with warm caches (2026-11-14); a local
        // M4 Pro takes 5.8s and 4.5s. 90s is 2.4x that maximum and matches
        // the sibling app cases.
        timeout: 90_000,
      },
      async (provider, context) => {
        const f = await nativeAppTestFixture(provider, context);
        fixture = f;
        await f.ready();
        const folder = join(f.root, "folder");
        const other = join(f.root, "other");
        const link = f.project;
        await Promise.all([mkdir(folder), mkdir(other)]);
        await rm(link, { recursive: true, force: true });
        await symlink(folder, link, "dir");
        const stop = async (sessionId: string) => {
          await f.api(`/sessions/${sessionId}/terminate`, {});
        };
        const detail = async (sessionId: string) =>
          JSON.stringify(
            await f.api(`/projects/${projectId}/sessions/${sessionId}`),
          );

        const created = await f.create("LINK_INPUT");
        const projectId = toUrlProjectId(folder);
        expect(created.projectId).toBe(projectId);
        (await f.model.next()).finish("LINK_REPLY");
        await appBarrier(
          async () => (await detail(created.sessionId)).includes("LINK_REPLY"),
          "saved reply",
        );
        await stop(created.sessionId);

        // One project holds the session, and the link is not a second one.
        const listed = await appBarrier(async () => {
          const body = await f.api(
            "/sessions?summaryMode=retained&includeArchived=true&limit=20",
          );
          const session = body.sessions?.find(
            (row: { id: string }) => row.id === created.sessionId,
          );
          return body.catalog?.refreshing === false && session
            ? { session, catalog: body.catalog }
            : false;
        }, "listed session");
        expect(listed.session.projectId).toBe(projectId);
        expect(listed.catalog.refreshError).toBeUndefined();
        const paths = (await f.api("/projects")).projects.map(
          (project: { path: string }) => project.path,
        );
        expect(paths).toContain(folder);
        expect(paths).not.toContain(link);

        // The link now names another folder. The saved conversation resumes
        // where it worked before, as its real shell reports.
        await rm(link);
        await symlink(other, link, "dir");
        await f.api(
          `/projects/${projectId}/sessions/${created.sessionId}/resume`,
          {
            message: "LINK_RESUME",
            provider,
            mode: "bypassPermissions",
            recapMode: "off",
            promptSuggestionMode: "off",
          },
        );
        const resumed = await f.model.next();
        if (provider === "claude")
          resumed.tool("Bash", {
            command: "pwd",
            timeout: 1000,
            description: "Report the working folder",
          });
        else
          resumed.tool(
            "exec",
            'const r=await tools.exec_command({cmd:"pwd",max_output_tokens:100});text(r.output);',
          );
        const reported = await f.model.next();
        const shell = JSON.stringify(reported.body);
        expect(shell).toContain(folder);
        expect(shell).not.toContain(other);
        reported.finish("LINK_RESUMED");
        await appBarrier(
          async () =>
            (await detail(created.sessionId)).includes("LINK_RESUMED"),
          "resumed reply",
        );
        await stop(created.sessionId);

        // With its folder gone the conversation is still readable, and
        // continuing it is refused in words rather than started elsewhere.
        await rm(folder, { recursive: true });
        expect(await detail(created.sessionId)).toContain("LINK_REPLY");
        await expect(
          f.api(`/projects/${projectId}/sessions/${created.sessionId}/resume`, {
            message: "LINK_RESUME_WITHOUT_FOLDER",
            provider,
            mode: "bypassPermissions",
          }),
        ).rejects.toThrow(/409 .*project-folder-missing/);
        await f.close();
        expect(f.model.failures).toEqual([]);
      },
    );
  },
);
