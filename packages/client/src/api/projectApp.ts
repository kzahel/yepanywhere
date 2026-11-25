import type {
  ProjectAppAddresses,
  ProjectAppInfo,
  ProjectAppView,
  ProjectAppInventory,
} from "@yep-anywhere/shared/project-service";
import { fetchJSON } from "./sourceApiFetch";

export interface ProjectAppTarget {
  target: "app" | "artifact";
  artifactId?: string;
}
/** The editable `app.json` direct-serving fields; absent means unset. */
export interface ProjectAppDirectFields {
  redirect?: string;
  hostPort?: number;
}
const path = (id: string) => `/projects/${encodeURIComponent(id)}/app`;
export const projectAppApi = {
  inventory: () => fetchJSON<ProjectAppInventory>("/project-apps"),
  deleteApp: (id: string) =>
    fetchJSON<{ deleted: boolean }>(path(id), { method: "DELETE" }),
  releaseAddress: (projectId: string, namespace: string) =>
    fetchJSON<unknown>("/project-apps/address/release", {
      method: "POST",
      body: JSON.stringify({ projectId, namespace }),
    }),
  info: (id: string) => fetchJSON<ProjectAppInfo>(path(id)),
  open: (id: string, target: ProjectAppTarget, audience: "local" | "public") =>
    fetchJSON<ProjectAppView>(`${path(id)}/open`, {
      method: "POST",
      body: JSON.stringify({ ...target, audience }),
    }),
  action: (id: string, action: "start" | "stop" | "restore", body = {}) =>
    fetchJSON<unknown>(`${path(id)}/${action}`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  /** Requires `project-app-start-command`; 409 when the file changed meanwhile. */
  setStartCommand: (id: string, expected: string[], argv: string[]) =>
    fetchJSON<ProjectAppInfo>(`${path(id)}/start-command`, {
      method: "PUT",
      body: JSON.stringify({ expected, argv }),
    }),
  /** Requires `project-app-direct-serving`; 409 when the file changed meanwhile. */
  setDirect: (
    id: string,
    expected: ProjectAppDirectFields,
    next: ProjectAppDirectFields,
  ) =>
    fetchJSON<ProjectAppInfo>(`${path(id)}/direct`, {
      method: "PUT",
      body: JSON.stringify({ expected, next }),
    }),
  /** Requires `project-app-direct-serving`; administrators only. */
  setFunnel: (id: string, httpsPort: number, on: boolean) =>
    fetchJSON<ProjectAppInfo>(`${path(id)}/funnel`, {
      method: "POST",
      body: JSON.stringify({ httpsPort, on }),
    }),
  addresses: (id: string) =>
    fetchJSON<ProjectAppAddresses>(`${path(id)}/address`),
  addressAction: (
    id: string,
    action: "reserve" | "serve" | "release" | "auto-start",
    body: object,
  ) =>
    fetchJSON<unknown>(`${path(id)}/address/${action}`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
};
