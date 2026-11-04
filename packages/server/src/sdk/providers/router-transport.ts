import type { RouterLaunch } from "../../services/AgentAuthRouter.js";

const GATEWAY_TOKEN_HEADER = "x-aar-gateway-token";

/**
 * Transport-only overrides. Never mutate native homes or ambient process.env.
 *
 * With `claudeAiConnectors` the token travels in AAR's dedicated header and
 * `ANTHROPIC_AUTH_TOKEN` stays empty: an auth token would take precedence over
 * this computer's claude.ai login and switch its connectors off. Claude Code
 * still sends that login's bearer token; AAR drops it and never forwards it.
 * `customHeaders` keeps headers the launch environment already sets.
 */
export function claudeRouterEnvironment(
  route: RouterLaunch,
  customHeaders?: string,
): Record<string, string> {
  return {
    ANTHROPIC_BASE_URL: route.baseUrl,
    ...(route.claudeAiConnectors
      ? {
          ANTHROPIC_AUTH_TOKEN: "",
          ANTHROPIC_CUSTOM_HEADERS: [
            ...(customHeaders ?? "")
              .split("\n")
              .filter(
                (line) =>
                  line.trim() &&
                  !line
                    .trimStart()
                    .toLowerCase()
                    .startsWith(`${GATEWAY_TOKEN_HEADER}:`),
              ),
            `${GATEWAY_TOKEN_HEADER}: ${route.token}`,
          ].join("\n"),
        }
      : { ANTHROPIC_AUTH_TOKEN: route.token }),
    ANTHROPIC_API_KEY: "",
    CLAUDE_CODE_OAUTH_TOKEN: "",
    CLAUDE_CODE_USE_BEDROCK: "0",
    CLAUDE_CODE_USE_VERTEX: "0",
    CLAUDE_CODE_USE_FOUNDRY: "0",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: "1",
    // Claude Code disables tool search for non-Anthropic base URLs; AAR
    // forwards the body and anthropic-* headers, so deferred tools work.
    ENABLE_TOOL_SEARCH: "true",
  };
}
export function codexRouterArguments(route: RouterLaunch): string[] {
  return [
    'model_provider="aar"',
    'model_providers.aar.name="Agent Auth Router"',
    `model_providers.aar.base_url=${JSON.stringify(route.baseUrl)}`,
    'model_providers.aar.wire_api="responses"',
    ...(route.serviceTierSelection
      ? [
          `model_providers.aar.model_catalog_url=${JSON.stringify(`${route.baseUrl}/models`)}`,
          "features.api_key_model_discovery=true",
        ]
      : []),
    'model_providers.aar.env_key="AAR_SESSION_TOKEN"',
    "model_providers.aar.requires_openai_auth=false",
    "model_providers.aar.supports_websockets=false",
  ].flatMap((value) => ["-c", value]);
}
export function codexRouterEnvironment(
  env: NodeJS.ProcessEnv,
  route: RouterLaunch,
): NodeJS.ProcessEnv {
  const result = { ...env };
  for (const name of [
    "OPENAI_API_KEY",
    "OPENAI_BASE_URL",
    "CODEX_API_KEY",
    "CODEX_ACCESS_TOKEN",
  ])
    delete result[name];
  result.AAR_SESSION_TOKEN = route.token;
  return result;
}
