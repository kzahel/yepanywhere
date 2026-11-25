import { z } from "zod";

const hasControlCharacters = (value: string) =>
  Array.from(value).some((character) => character.charCodeAt(0) < 32);

const relativePath = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    (value) =>
      !/[\\:]/.test(value) &&
      !hasControlCharacters(value) &&
      value
        .split("/")
        .every(
          (part) =>
            part !== "" &&
            part !== "." &&
            part !== ".." &&
            part.toLowerCase() !== ".git",
        ),
  );
const directory = z.union([z.literal("."), relativePath]);
const appPath = z
  .string()
  .max(4096)
  .refine((value) => {
    if (
      !value.startsWith("/") ||
      value.startsWith("//") ||
      /[\\ ?#]/.test(value) ||
      hasControlCharacters(value)
    )
      return false;
    try {
      return decodeURIComponent(value)
        .split("/")
        .every((part) => part !== ".." && part !== ".");
    } catch {
      return false;
    }
  });

/** Source-owned service declaration; observed state and hostnames live in YA data. */
export const projectServiceSchema = z.union([
  z.strictObject({
    version: z.literal(1),
    where: z.strictObject({
      kind: z.literal("static"),
      root: directory,
      entry: relativePath,
    }),
    serving: z.strictObject({ target: z.literal("static-root") }),
  }),
  z.strictObject({
    version: z.literal(1),
    where: z.strictObject({
      kind: z.literal("process"),
      cwd: directory,
      entry: appPath,
    }),
    start: z.strictObject({
      argv: z
        .array(
          z
            .string()
            .min(1)
            .max(8192)
            .refine((value) => !value.includes("\0")),
        )
        .min(1)
        .max(64),
      portEnv: z
        .string()
        .regex(/^(?:PORT|[A-Z][A-Z0-9_]*_PORT)$/)
        .refine((value) => !/^(?:YA_|YEP_|AGENT_)/.test(value)),
    }),
    status: z.strictObject({
      probe: z.literal("http"),
      path: appPath,
      readyStatus: z.number().int().min(200).max(299),
      startupTimeoutMs: z.number().int().min(100).max(120_000),
    }),
    stop: z.strictObject({
      signal: z.literal("SIGTERM"),
      graceMs: z.number().int().min(100).max(30_000),
    }),
    serving: z.strictObject({
      target: z.literal("sandbox-loopback"),
      protocol: z.literal("http"),
      basePathEnv: z
        .string()
        .regex(/^(?:BASE_PATH|[A-Z][A-Z0-9_]*_BASE_PATH)$/)
        .refine((value) => !/^(?:YA_|YEP_|AGENT_)/.test(value))
        .optional(),
    }),
  }),
]);

export type ProjectServiceDeclaration = z.infer<typeof projectServiceSchema>;

export const projectFileLinksSchema = z.strictObject({
  enabled: z.boolean().default(true),
  pathTemplate: z
    .string()
    .min(1)
    .max(4096)
    .refine((template) => {
      if (
        !template.startsWith("/") ||
        template.startsWith("//") ||
        /[\\\s#]/.test(template) ||
        hasControlCharacters(template)
      )
        return false;
      const placeholders = template.match(/\{path(?:Query)?\}/g);
      if (placeholders?.length !== 1) return false;
      const sample = template.replace(/\{path(?:Query)?\}/, "file");
      if (/[{}]/.test(sample)) return false;
      try {
        const url = new URL(sample, "https://app.invalid");
        return (
          url.origin === "https://app.invalid" &&
          !url.searchParams.has("ya_access") &&
          decodeURIComponent(sample.split("?")[0]!)
            .split("/")
            .every((part) => part !== "." && part !== "..")
        );
      } catch {
        return false;
      }
    })
    .default("/{path}"),
});

export interface ProjectFileLinks {
  pathTemplate: string;
  /** Public address and access token are supplied by YA, never the template. */
  baseUrl: string;
}

/** Construct a project file link without querying or starting the app. */
export function projectFileLink(
  links: ProjectFileLinks,
  path: string,
  fragment = "",
): string | null {
  const parts = path.split("/");
  if (
    !path ||
    path.includes("\\") ||
    hasControlCharacters(path) ||
    parts.some((part) => !part || part === "." || part === "..")
  )
    return null;
  const route = links.pathTemplate.replace(
    /\{path(Query)?\}/,
    (_match, query) =>
      query
        ? encodeURIComponent(path)
        : parts.map(encodeURIComponent).join("/"),
  );
  const base = new URL(links.baseUrl);
  const url = new URL(route, base);
  if (
    base.protocol !== "https:" ||
    base.hostname === "localhost" ||
    base.hostname.endsWith(".localhost") ||
    url.origin !== base.origin
  )
    return null;
  const token = base.searchParams.get("ya_access");
  if (token) url.searchParams.set("ya_access", token);
  url.hash = fragment;
  return url.href;
}

/** `app.json` `redirect`: the canonical address viewing tries first. */
export const projectAppRedirectSchema = z
  .url({ protocol: /^https?$/ })
  .max(2048)
  .refine((value) => !hasControlCharacters(value));

/** `app.json` `hostPort`: host loopback port forwarded to the process app. */
export const projectAppHostPortSchema = z.number().int().min(1024).max(65535);

/**
 * Serving outside YA's own app addresses, advertised by
 * project-app-direct-serving. A direct path has no YA access check: the
 * app's own login is its only gate.
 */
export interface ProjectAppDirect {
  redirect?: string;
  hostPort?: number;
  /** Whether YA holds `hostPort` now; `error` says why it does not. */
  listening?: boolean;
  error?: string;
  /** Present when `tailscale` is installed and this principal may manage it. */
  funnel?: ProjectAppFunnel;
}

export interface ProjectAppFunnel {
  /** `https://<node>/` of this host's Tailscale node. */
  host: string;
  /** HTTPS ports the tailnet lets this node funnel; empty when none. */
  ports: number[];
  /** Funnel URLs that currently proxy to `hostPort`. */
  urls: string[];
  /** HTTPS ports this node already serves with something else. */
  busy: number[];
  /** Set when YA's user may not change Funnel: the one-time fix to run. */
  setupCommand?: string;
}

export interface ProjectAppInfo {
  /** Advertised by project-app-direct-serving. */
  direct?: ProjectAppDirect;
  fileLinks?: ProjectFileLinks;
  /** Explicit template dev service; gated by project-live-preview. */
  livePreview?: ProjectServiceDeclaration;
  mode?: "app" | "live-preview";
  projectId: string;
  declaration: ProjectServiceDeclaration | null;
  state:
    | "none"
    | "ready"
    | "missing"
    | "stopped"
    | "starting"
    | "running"
    | "stopping"
    | "failed"
    | "unavailable";
  error?: string;
  generation?: string;
  /** ISO timestamp of the static entry or process runtime; omitted when unknown. */
  updatedAt?: string;
  activeDeclaration?: ProjectServiceDeclaration;
  restartRequired?: boolean;
  latestArtifact: {
    id: string;
    label: string;
    sessionId?: string;
    associatedAt: string;
  } | null;
  canExecute: boolean;
  /**
   * Whether this principal may start the declared service. A view grant is
   * enough to start it; stopping still needs `canExecute`. Absent from older
   * servers, where `canExecute` governs both.
   */
  canStart?: boolean;
  canPublish: boolean;
  canShare: boolean;
  /** UI share/copy permission; viewing remains authorized independently. */
  canCopyLink?: boolean;
  removedFrom: Array<{ username: string; at: string }>;
}

export interface ProjectAppInventory {
  projects: Array<{
    projectId: string;
    name: string;
    path: string;
    owner?: string;
    info: ProjectAppInfo;
  }>;
  /** Retained claims also include unavailable projects and previous namespaces. */
  reservations: Array<{
    projectId: string;
    namespace: string;
    name: string;
    owner: string;
  }>;
}

export interface ProjectAppView {
  id: string;
  kind: "static" | "artifact" | "service";
  url: string;
  expiresAt?: number;
  label: string;
  /** A viewer URL grants transferable access; it is not the authenticated project route. */
  transferable: true;
}

export interface ProjectAppAddresses {
  enabled: boolean;
  namespace: string | null;
  requiredPrefix: string;
  canReserve: boolean;
  canPublish: boolean;
  /** Absent on older servers, where only administrators canPublish. */
  canRelease?: boolean;
  reservations: Array<{
    namespace: string;
    name: string;
    owner: string;
    serving: boolean;
    public: boolean;
    privateOnly: boolean;
    reservedAt: string;
    /** Transferable current-namespace link; advertised by project-app-address-links. */
    url?: string;
  }>;
  /**
   * Whether an authorized visit to the served address starts the stopped or
   * unreachable process app; `paused` is the last failure once repeated
   * failures stopped it. Advertised by project-app-auto-start.
   */
  autoStart?: { enabled: boolean; paused?: string };
}
