export type ServerCapabilityKind = "permanent" | "transitional";

export type ServerCapabilityAdvertisement =
  | { kind: "version-implied" }
  | { kind: "optional-bit"; index: number }
  | { kind: "scoped" };

export interface ServerCapabilityPermanentLifecycle {
  kind: "permanent";
  reason: string;
}

/** Alternate code has a hard 90-day deadline in scripts/compatibility-sunsets.json. */
export interface ServerCapabilityTransitionalLifecycle {
  kind: "transitional";
}

export interface ServerCapabilityDefinition {
  /** Stable global ID. Required for global capabilities introduced in 0.7.1+. */
  id?: number;
  name: string;
  kind: ServerCapabilityKind;
  /** Historical reservation only; no live client capability consumers remain. */
  retired?: boolean;
  area:
    | "deviceBridge"
    | "gitStatus"
    | "localAccess"
    | "projectQueue"
    | "providers"
    | "rendering"
    | "remoteAccess"
    | "security"
    | "sessions"
    | "settings"
    | "speech";
  description: string;
  introducedIn: string;
  advertisement: ServerCapabilityAdvertisement;
  clientFallback: string;
  serverContract?: {
    routes?: readonly string[];
    /**
     * Repository-relative server route modules wholly owned by this
     * capability. `pnpm capabilities:audit` requires every route declared in
     * these modules to appear in `routes`, and rejects stale route entries.
     */
    routeModules?: readonly string[];
    requestFields?: readonly string[];
    responseFields?: readonly string[];
    events?: readonly string[];
  };
  lifecycle:
    | ServerCapabilityPermanentLifecycle
    | ServerCapabilityTransitionalLifecycle;
}
