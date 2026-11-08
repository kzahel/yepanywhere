import { withImpactConfirmation } from "./connectionImpact";
import { fetchJSON } from "./sourceApiFetch";

export interface NetworkInterface {
  /** Interface name (e.g., "eth0", "wlan0") */
  name: string;
  /** IP address */
  address: string;
  /** IPv4 or IPv6 */
  family: "IPv4" | "IPv6";
  /** Whether this is a loopback/internal interface */
  internal: boolean;
  /** Human-readable display name */
  displayName: string;
}

export interface NetworkBindingState {
  localhost: { port: number; overriddenByCli: boolean };
  network: {
    enabled: boolean;
    host: string | null;
    port: number | null;
    overriddenByCli: boolean;
  };
  interfaces: NetworkInterface[];
}

export interface UpdateBindingRequest {
  localhostPort?: number;
  network?: {
    enabled: boolean;
    host?: string;
    port?: number;
  };
}

export interface UpdateBindingResponse {
  success: boolean;
  error?: string;
  redirectUrl?: string;
}

/**
 * Runtime port/interface configuration. Writes take `confirmed` once the user
 * has accepted that the change disconnects this client
 * (topics/connection-safe-settings.md).
 */
export const networkBindingApi = {
  getNetworkBinding: () => fetchJSON<NetworkBindingState>("/network-binding"),

  setNetworkBinding: (request: UpdateBindingRequest, confirmed = false) =>
    fetchJSON<UpdateBindingResponse>(
      withImpactConfirmation("/network-binding", confirmed),
      { method: "PUT", body: JSON.stringify(request) },
    ),

  disableNetworkBinding: (confirmed = false) =>
    fetchJSON<UpdateBindingResponse>(
      withImpactConfirmation("/network-binding", confirmed),
      { method: "DELETE" },
    ),
};
