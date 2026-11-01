import type {
  PeerConnectionsResponse,
  PeerConnectionSetupRequest,
  PeerConnectionSetupResponse,
} from "@yep-anywhere/shared";
import { fetchJSON } from "./sourceApiFetch";
export interface PeerConnectionActivity {
  incoming: Activity[];
  outgoing: Activity[];
}
interface Activity {
  id: string;
  sessionId: string | null;
  projectId: string | null;
  sourceSessionId: string | null;
  state: string;
  createdAt: string;
}
const base = "/peers/connections";
function write<T>(path: string, method: string, body?: unknown) {
  return fetchJSON<T>(`${base}${path}`, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
export const peerConnectionsApi = {
  list: (cursor = "0") =>
    fetchJSON<PeerConnectionsResponse>(`${base}?cursor=${cursor}`),
  agentAccess: (enabled: boolean) => write("/agent-access", "PUT", { enabled }),
  connect: (input: PeerConnectionSetupRequest) =>
    write<PeerConnectionSetupResponse>("/connect", "POST", input),
  test: (id: string) => write(`/${id}/test`, "POST", {}),
  label: (id: string, label: string) => write(`/${id}`, "PATCH", { label }),
  remove: (
    id: string,
    direction: "incoming" | "outgoing",
    credentialId: string,
    generation: number,
  ) => write(`/${id}/${direction}/${credentialId}/${generation}`, "DELETE"),
  activity: (id: string) =>
    fetchJSON<PeerConnectionActivity>(`${base}/${id}/activity`),
};
