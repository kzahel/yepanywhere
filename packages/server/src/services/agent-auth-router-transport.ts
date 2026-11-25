import type { RouterInfo } from "./agent-auth-router-connection.js";
import { RouterUnavailable } from "./agent-auth-router-control.js";

/** AAR describes each Claude and Codex binding's inference transport. */
const BINDING_TRANSPORT = "binding-transport-v1";

const AUTH_METHODS = ["bearer", "aar-gateway-header"] as const;
export type RouterAuthMethod = (typeof AUTH_METHODS)[number];

/** A binding's checked transport, as URLs on the validated inference origin. */
export interface RouterTransport {
  baseUrl: string;
  /** Always includes `bearer`; other entries are ones this server can map. */
  authMethods: RouterAuthMethod[];
  modelCatalogUrl?: string;
}

/**
 * What a router that predates `binding-transport-v1` would have described.
 * This is the only place that knows AAR's URL layout. Its removal is tracked
 * in gaps/aar-legacy-transport-shim.md.
 */
function legacyRouterTransport(
  info: RouterInfo,
  provider: "claude" | "codex",
): unknown {
  return {
    kind: "http-gateway-v1",
    basePath: `/${provider}`,
    authMethods: [
      "bearer",
      ...(provider === "claude" &&
      info.capabilities.includes("gateway-token-header-v1")
        ? ["aar-gateway-header"]
        : []),
    ],
    ...(provider === "codex" && info.capabilities.includes("service-tiers-v1")
      ? { modelCatalogPath: "/codex/models" }
      : {}),
  };
}

/**
 * A described path names a route on the inference origin. A hosted router
 * sends only paths under a provider's name to inference; `/control` is its
 * control API and every other path is its dashboard. Requiring the binding's
 * own provider as the first segment keeps a native client's request, and the
 * token on it, on that binding's inference route.
 */
function routePath(value: unknown, provider: string): string | undefined {
  if (
    typeof value !== "string" ||
    value.length > 200 ||
    !/^(\/[A-Za-z0-9._~-]+)+$/.test(value)
  )
    return undefined;
  const segments = value.split("/").slice(1);
  if (
    segments[0] !== provider ||
    segments.some((segment) => segment === "." || segment === "..")
  )
    return undefined;
  return value;
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const invalid = () =>
  new RouterUnavailable(
    409,
    "The router returned an invalid binding or inference transport for this session. Check the AAR installation and retry.",
    "protocol-mismatch",
  );
/** The router is the newer side: it describes something this server cannot map. */
const unusable = () =>
  new RouterUnavailable(
    409,
    "This router offers an inference transport this Yep Anywhere version cannot use. Update Yep Anywhere, then retry.",
    "unsupported",
  );

/** The binding a response must describe before its transport is trusted. */
export interface ExpectedBinding {
  id: string;
  routerId: string;
  accountId: string;
  provider: "claude" | "codex";
  /** A retried prepare may find the binding already committed. */
  state: "prepared-or-committed" | "committed";
}

/**
 * Check a binding response and resolve its transport against the validated
 * inference origin. The response carries data only: executables, arguments,
 * environment and headers stay authored by the native adapter.
 */
export function routerTransport(
  info: RouterInfo,
  expected: ExpectedBinding,
  response: unknown,
): RouterTransport {
  const { provider } = expected;
  let transport: unknown;
  if (info.capabilities.includes(BINDING_TRANSPORT)) {
    const binding = record(response);
    if (
      !binding ||
      binding.id !== expected.id ||
      binding.routerId !== expected.routerId ||
      binding.accountId !== expected.accountId ||
      binding.provider !== provider ||
      (binding.state !== "committed" &&
        (binding.state !== "prepared" || expected.state === "committed"))
    )
      throw invalid();
    transport = binding.transport;
  } else transport = legacyRouterTransport(info, provider);
  const described = record(transport);
  if (
    !described ||
    typeof described.kind !== "string" ||
    !Array.isArray(described.authMethods)
  )
    throw invalid();
  if (described.kind !== "http-gateway-v1") throw unusable();
  const offered = described.authMethods;
  const methods = AUTH_METHODS.filter((method) => offered.includes(method));
  if (!methods.includes("bearer")) throw unusable();
  const base = routePath(described.basePath, provider);
  if (!base) throw invalid();
  const catalog =
    described.modelCatalogPath === undefined
      ? undefined
      : routePath(described.modelCatalogPath, provider);
  if (
    described.modelCatalogPath !== undefined &&
    !catalog?.startsWith(`${base}/`)
  )
    throw invalid();
  return {
    baseUrl: info.inferenceOrigin + base,
    authMethods: methods,
    ...(catalog ? { modelCatalogUrl: info.inferenceOrigin + catalog } : {}),
  };
}
