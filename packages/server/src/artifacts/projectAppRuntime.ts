import type { LimitedUserGrants } from "@yep-anywhere/shared";
import { levelFor, satisfies } from "../auth/limitedUserPolicy.js";
import { HostedProjectServices } from "../projects/HostedProjectServices.js";
import { ProjectAppAutoStart } from "../projects/ProjectAppAutoStart.js";
import { ProjectAppHostPorts } from "../projects/ProjectAppHostPorts.js";
import type { ProjectAppStore } from "../projects/ProjectAppStore.js";
import { projectAppPublicAllowed } from "../projects/projectAppPolicy.js";
import {
  honoredHostPort,
  ProjectServiceManager,
  type ProjectServices,
  projectServiceStaticApp,
  readAppDeclaration,
  readProjectService,
  readStaticAddressMode,
} from "../projects/ProjectServiceManager.js";
import type { ProjectScanner } from "../projects/scanner.js";
import type { ArtifactServer } from "./ArtifactServer.js";
import { ProjectAppDelivery } from "./ProjectAppDelivery.js";

/**
 * The running half of project apps (topics/project-service.md): the process
 * manager, auto-start on visit, direct host ports and delivery through the
 * artifact server, built together because each one consults the others.
 * The routes that edit and open apps stay in the app hub as wiring.
 */
export interface ProjectAppRuntime {
  services: ProjectServices;
  autoStart: ProjectAppAutoStart;
  hostPorts: ProjectAppHostPorts;
  delivery: ProjectAppDelivery;
  close(): Promise<void>;
}

export function createProjectAppRuntime(deps: {
  dataDir: string;
  hosted: boolean;
  scanner: ProjectScanner;
  store: ProjectAppStore;
  artifacts: ArtifactServer;
  activeGrants: (username: string) => LimitedUserGrants | null;
}): ProjectAppRuntime {
  const { scanner, activeGrants } = deps;
  const services = deps.hosted
    ? new HostedProjectServices(deps.dataDir)
    : new ProjectServiceManager(deps.dataDir);
  const autoStart = new ProjectAppAutoStart(deps.dataDir, {
    services,
    projectPath: async (projectId) =>
      (await scanner.getProject(projectId))?.path ?? null,
    // The enabling principal must still hold what enabling it required.
    mayAutoStart: async (by, projectId) => {
      if (by === "superuser") return true;
      const grants = activeGrants(by);
      return (
        grants?.allowPublicApps === true &&
        satisfies(levelFor(grants, projectId), "new-session")
      );
    },
  });
  const hostPorts = new ProjectAppHostPorts({ services, autoStart });
  void holdDeclaredHostPorts(scanner, hostPorts).catch((error: unknown) =>
    console.error("[ProjectAppHostPorts] Startup scan failed:", error),
  );
  const delivery = new ProjectAppDelivery(
    deps.artifacts,
    services,
    deps.store,
    async (projectId) => {
      const project = await scanner.getProject(projectId);
      if (!project) return null;
      const declaration = await readProjectService(project.path);
      if (declaration?.where.kind !== "static") return null;
      return {
        ...(await projectServiceStaticApp(project.path, declaration)),
        address: await readStaticAddressMode(project.path),
      };
    },
    async (reservation) => {
      const project = await scanner.getProject(reservation.projectId);
      return (
        !!project &&
        projectAppPublicAllowed(
          project.ownerUsername,
          reservation,
          activeGrants,
        )
      );
    },
    autoStart,
  );
  return {
    services,
    autoStart,
    hostPorts,
    delivery,
    async close() {
      await services.close();
      await autoStart.close();
      await hostPorts.close();
    },
  };
}

/**
 * A host proxy such as Tailscale Funnel needs the port held before anyone
 * opens the app in YA; later declaration reads keep it current.
 */
async function holdDeclaredHostPorts(
  scanner: ProjectScanner,
  hostPorts: ProjectAppHostPorts,
): Promise<void> {
  for (const project of await scanner.listProjects()) {
    if (project.ownerUsername) continue;
    try {
      const port = honoredHostPort(
        project,
        await readProjectService(project.path),
        { hostPort: (await readAppDeclaration(project.path))?.hostPort },
      );
      if (port !== undefined) await hostPorts.reconcile(project.id, port);
    } catch {
      // An unreadable declaration is reported when its app is viewed.
    }
  }
}
