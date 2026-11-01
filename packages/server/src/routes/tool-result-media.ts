import { createReadStream } from "node:fs";
import { isUrlProjectId } from "@yep-anywhere/shared";
import { Hono } from "hono";
import { stream } from "hono/streaming";
import type { ToolResultMediaStore } from "../media/ToolResultMediaStore.js";
import type { ProjectScanner } from "../projects/scanner.js";

interface ToolResultMediaRoutesDeps {
  scanner: ProjectScanner;
  store: ToolResultMediaStore;
}

export function createToolResultMediaRoutes(
  deps: ToolResultMediaRoutesDeps,
): Hono {
  const routes = new Hono();

  routes.get(
    "/projects/:projectId/sessions/:sessionId/media/:mediaId",
    async (c) => {
      const projectId = c.req.param("projectId");
      if (!isUrlProjectId(projectId)) {
        return c.json({ error: "Invalid project ID format" }, 400);
      }

      const project =
        (await deps.scanner.getProject(projectId)) ??
        (await deps.scanner.getOrCreateProject?.(projectId));
      if (!project) {
        return c.json({ error: "Media not found" }, 404);
      }

      const media = await deps.store.getMediaFile(
        project.path,
        projectId,
        c.req.param("sessionId"),
        c.req.param("mediaId"),
      );
      if (!media) {
        return c.json({ error: "Media not found" }, 404);
      }

      c.header("Content-Type", media.mimeType);
      c.header("Content-Length", media.byteLength.toString());
      c.header(
        "Cache-Control",
        media.persistent
          ? "private, max-age=31536000, immutable"
          : "private, no-store",
      );
      c.header("X-Content-Type-Options", "nosniff");

      return stream(c, async (body) => {
        if (media.bytes) {
          await body.write(media.bytes);
          return;
        }
        if (media.path) {
          for await (const chunk of createReadStream(media.path)) {
            await body.write(chunk);
          }
        }
      });
    },
  );

  return routes;
}
