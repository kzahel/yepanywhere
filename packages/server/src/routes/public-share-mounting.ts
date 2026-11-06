import type { HttpBindings } from "@hono/node-server";
import type { AppSession, UrlProjectId } from "@yep-anywhere/shared";
import type { Hono } from "hono";
import { join } from "node:path";
import { WS_INTERNAL_AUTHENTICATED } from "../middleware/internal-auth.js";
import {
  decodeProjectId,
  type ProjectDisplayNameResolver,
} from "../projects/paths.js";
import type { ProjectScanner } from "../projects/scanner.js";
import type { RemoteAccessService } from "../remote-access/index.js";
import {
  PublicShareCaptureError,
  type PublicShareService,
} from "../services/PublicShareService.js";
import type { RelayClientService } from "../services/RelayClientService.js";
import type { ServerSettingsService } from "../services/ServerSettingsService.js";
import { canonicalizeManagedAttachmentPath } from "../uploads/attachmentAccess.js";
import { createFilesRoutes } from "./files.js";
import type { createLocalResourcePathPolicy } from "./local-resource-policy.js";
import { createPublicFileShareRoutes } from "./public-file-shares.js";
import { createPublicShareManagementFreezeRoutes } from "./public-share-management-freeze.js";
import { createPublicShareManagementRoutes } from "./public-share-management.js";
import {
  createPublicSharePublicRoutes,
  createPublicShareRoutes,
} from "./public-shares.js";

/** The AppOptions services public-share mounting reads. */
export interface PublicShareMountOptions {
  publicShareService?: PublicShareService;
  remoteAccessService?: RemoteAccessService;
  relayClientService?: RelayClientService;
  serverSettingsService?: ServerSettingsService;
}

/** createApp locals the public-share loaders close over. */
export interface PublicShareMountDeps {
  scanner: ProjectScanner;
  projectDisplayName: ProjectDisplayNameResolver;
  effectiveDataDir: string;
  localResourcePathPolicy: ReturnType<typeof createLocalResourcePathPolicy>;
}

/**
 * Mounts the authenticated public-share management routes and the
 * secret-only public read routes. Session and file reads loop back through
 * `app.fetch` as an internally authenticated request, so `app` must already
 * carry the session detail, metadata and files routes when a request arrives.
 */
export function mountPublicShareRoutes(
  app: Hono<{ Bindings: HttpBindings }>,
  options: PublicShareMountOptions,
  {
    scanner,
    projectDisplayName,
    effectiveDataDir,
    localResourcePathPolicy,
  }: PublicShareMountDeps,
): void {
  // Public read-only session shares. Creation is authenticated under /api;
  // public reads are secret-only and stay outside /api auth/mutation routes.
  if (options.publicShareService) {
    type PublicShareSessionDetailEnvelope = {
      messages?: AppSession["messages"];
      pagination?: unknown;
      publicShareCapture?: { completedMessageCount?: unknown };
      session?: AppSession;
    };

    const parsePublicShareSessionDetail = (
      body: PublicShareSessionDetailEnvelope,
      requireCompleteHistory: boolean,
    ): AppSession | null => {
      if (!body.session || typeof body.session !== "object") return null;
      if (requireCompleteHistory) {
        const completedMessageCount =
          body.publicShareCapture?.completedMessageCount;
        if (
          !Array.isArray(body.messages) ||
          body.pagination !== undefined ||
          body.session.messages !== undefined ||
          !Number.isInteger(body.session.messageCount) ||
          body.session.messageCount < 0 ||
          body.session.messageCount > body.messages.length ||
          !Number.isInteger(completedMessageCount) ||
          (completedMessageCount as number) < 0 ||
          (completedMessageCount as number) > body.messages.length
        ) {
          throw new PublicShareCaptureError(
            "Session detail did not provide complete history; retry frozen capture",
            "incomplete-history",
          );
        }
        return {
          ...body.session,
          messageCount: completedMessageCount as number,
          messages: body.messages.slice(0, completedMessageCount as number),
        };
      }
      return {
        ...body.session,
        messages: Array.isArray(body.session.messages)
          ? body.session.messages
          : (body.messages ?? []),
      };
    };

    const fetchPublicShareSession = async (
      projectId: UrlProjectId,
      sessionId: string,
      options: {
        afterMessageId?: string;
        requireCompleteHistory?: boolean;
      } = {},
    ): Promise<AppSession | null> => {
      const searchParams = new URLSearchParams({ publicShare: "1" });
      if (options.afterMessageId) {
        searchParams.set("afterMessageId", options.afterMessageId);
      }
      if (options.requireCompleteHistory) {
        searchParams.set("fullHistory", "1");
        searchParams.set("fullHistoryReason", "public-share-capture");
      }
      const response = await app.fetch(
        new Request(
          `http://127.0.0.1/api/projects/${projectId}/sessions/${encodeURIComponent(sessionId)}?${searchParams}`,
          { headers: { "X-Yep-Anywhere": "true" } },
        ),
        { [WS_INTERNAL_AUTHENTICATED]: true },
      );
      if (!response.ok) {
        if (options.requireCompleteHistory && response.status !== 404) {
          throw new PublicShareCaptureError(
            "Complete session history is temporarily unavailable; retry frozen capture",
            "incomplete-history",
          );
        }
        return null;
      }
      let body: PublicShareSessionDetailEnvelope;
      try {
        body = (await response.json()) as PublicShareSessionDetailEnvelope;
      } catch (error) {
        if (options.requireCompleteHistory) {
          throw new PublicShareCaptureError(
            "Complete session history response was invalid; retry frozen capture",
            "incomplete-history",
          );
        }
        throw error;
      }
      return parsePublicShareSessionDetail(
        body,
        options.requireCompleteHistory ?? false,
      );
    };

    const loadPublicShareSession = (
      projectId: UrlProjectId,
      sessionId: string,
      options?: { afterMessageId?: string },
    ): Promise<AppSession | null> =>
      fetchPublicShareSession(projectId, sessionId, options);

    const loadCompletePublicShareSession = (
      projectId: UrlProjectId,
      sessionId: string,
    ): Promise<AppSession | null> =>
      fetchPublicShareSession(projectId, sessionId, {
        requireCompleteHistory: true,
      });

    const loadPublicShareSessionUpdatedAt = async (
      projectId: UrlProjectId,
      sessionId: string,
    ): Promise<string | null> => {
      const response = await app.fetch(
        new Request(
          `http://127.0.0.1/api/projects/${projectId}/sessions/${encodeURIComponent(sessionId)}/metadata`,
          { headers: { "X-Yep-Anywhere": "true" } },
        ),
        { [WS_INTERNAL_AUTHENTICATED]: true },
      );
      if (!response.ok) {
        return null;
      }
      const body = (await response.json()) as {
        session?: { updatedAt?: string | null };
      };
      return body.session?.updatedAt ?? null;
    };

    const loadPublicShareSessionSummary = async (
      projectId: UrlProjectId,
      sessionId: string,
    ): Promise<Pick<
      AppSession,
      | "customTitle"
      | "fullTitle"
      | "initialPrompt"
      | "provider"
      | "title"
      | "updatedAt"
    > | null> => {
      const response = await app.fetch(
        new Request(
          `http://127.0.0.1/api/projects/${projectId}/sessions/${encodeURIComponent(sessionId)}/metadata`,
          { headers: { "X-Yep-Anywhere": "true" } },
        ),
        { [WS_INTERNAL_AUTHENTICATED]: true },
      );
      if (!response.ok) {
        return null;
      }
      const body = (await response.json()) as {
        session?: Pick<
          AppSession,
          | "customTitle"
          | "fullTitle"
          | "initialPrompt"
          | "provider"
          | "title"
          | "updatedAt"
        >;
      };
      return body.session ?? null;
    };

    const fetchPublicShareProjectFile = async (
      projectId: UrlProjectId,
      filePath: string,
      fileOptions: {
        download?: boolean;
        highlight?: boolean;
        lineEnd?: number;
        lineNumber?: number;
        raw?: boolean;
        projectRoot?: string;
        viewMode?: "full" | "range";
      },
    ): Promise<Response> => {
      const searchParams = new URLSearchParams({ path: filePath });
      if (fileOptions.highlight) {
        searchParams.set("highlight", "true");
      }
      if (fileOptions.lineNumber !== undefined) {
        searchParams.set("line", String(fileOptions.lineNumber));
      }
      if (fileOptions.lineEnd !== undefined) {
        searchParams.set("lineEnd", String(fileOptions.lineEnd));
      }
      if (fileOptions.viewMode === "range") {
        searchParams.set("view", "range");
      }
      if (fileOptions.download) {
        searchParams.set("download", "true");
      }
      const route = fileOptions.raw ? "files/raw" : "files";
      const projectRoot = fileOptions.projectRoot ?? decodeProjectId(projectId);
      const attachmentPath = canonicalizeManagedAttachmentPath(
        filePath,
        effectiveDataDir,
      );
      const shareFiles = createFilesRoutes({
        scanner: {
          getProject: async () => ({ path: projectRoot }),
        } as unknown as ProjectScanner,
        ...(attachmentPath
          ? {
              allowedPaths: () => [
                join(effectiveDataDir, "projects"),
                join(effectiveDataDir, "uploads"),
              ],
              includeProjects: () => false,
            }
          : { strictProjectFileAccess: true }),
      });
      return await shareFiles.request(`/${projectId}/${route}?${searchParams}`);
    };

    const publicShareDeps = {
      publicShareService: options.publicShareService,
      listProjectRoots: async () =>
        (await scanner.listProjects()).map((project) => project.path),
      loadSession: loadPublicShareSession,
      loadCompleteSession: loadCompletePublicShareSession,
      projectDisplayName,
      loadSessionUpdatedAt: loadPublicShareSessionUpdatedAt,
      loadSessionSummary: loadPublicShareSessionSummary,
      fetchProjectFile: fetchPublicShareProjectFile,
      dataDir: effectiveDataDir,
      localFilePolicy: localResourcePathPolicy,
      getRelayConfig: () =>
        options.remoteAccessService?.getRelayConfig() ?? null,
      getPublicSharesEnabled: () =>
        options.serverSettingsService?.getSetting("publicSharesEnabled") ??
        false,
      getRemoteAccessEnabled: () =>
        options.remoteAccessService?.isEnabled() ?? false,
      getRelayStatus: () =>
        options.relayClientService?.getState().status ?? null,
      getYaClientBaseUrl: () =>
        options.serverSettingsService?.getSetting("yaClientBaseUrl"),
      getPublicShareViewerBaseUrl: () =>
        options.serverSettingsService?.getSetting("publicShareViewerBaseUrl"),
    };

    app.route("/api/public-shares", createPublicShareRoutes(publicShareDeps));
    app.route("/api", createPublicFileShareRoutes(publicShareDeps));
    app.route(
      "/api",
      createPublicShareManagementRoutes({
        publicShareService: options.publicShareService,
      }),
    );
    app.route("/api", createPublicShareManagementFreezeRoutes(publicShareDeps));
    app.route(
      "/public-api/shares",
      createPublicSharePublicRoutes(publicShareDeps),
    );
  }
}
