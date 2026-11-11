/** Distinct from the legacy narrow ya-agent self/view connection. */
export const AGENT_API_BOOTSTRAP_ENV = {
  url: "AGENT_YA_V0_URL",
  socket: "AGENT_YA_V0_SOCKET",
  authorization: "AGENT_YA_V0_AUTHORIZATION",
} as const;

/** Values are variable references only; never render an actual credential. */
function legacyAgentApiBootstrapInstructions(
  windows: boolean,
  management = false,
  peerAccess = false,
): string {
  const command = windows
    ? 'curl.exe -H "Authorization: $env:AGENT_YA_V0_AUTHORIZATION" "$env:AGENT_YA_V0_URL/v0/me"'
    : 'curl --unix-socket "$AGENT_YA_V0_SOCKET" -H "Authorization: $AGENT_YA_V0_AUTHORIZATION" "$AGENT_YA_V0_URL/v0/me"';
  return [
    "[Yep Anywhere API]",
    "You are running inside Yep Anywhere. Inspect your owning session, server and API access with:",
    command,
    "Read GET /v0/help for operations and examples; consult GET /v0/schema only when you need exact request/response fields. Use advertised access and operation support, including any conversation/following surfaces, rather than inferring capabilities from a session title.",
    management
      ? "This launch has explicit session-command authority. Inspect access before creating a worker; use durable request ids and receipts, and follow its conversation. Do not assume admission means delivery or successful completion."
      : "This launch is read-only; session commands require a separate management grant. Command execution and remote peer authority are not granted to this launch.",
    ...(peerAccess
      ? [
          "This launch may use configured peers. Read GET /v0/servers, then the chosen /v0/servers/{serverId}/access and /capabilities before calling it. YA selects its configured protected route; do not request or copy peer credentials.",
        ]
      : []),
    "Inherited child environments identify the owning YA session. If connection variables are missing, report API access unavailable; do not guess a port or reuse another credential.",
  ].join("\n");
}

export const AGENT_API_BOOTSTRAP_NOTICE = "Agent API instructions added";

/** Stable across launch grants: authority must come from the live connection. */
export function agentApiBootstrapInstructions(windows: boolean): string {
  const command = windows
    ? 'curl.exe -H "Authorization: $env:AGENT_YA_V0_AUTHORIZATION" "$env:AGENT_YA_V0_URL/v0/me"'
    : 'curl --unix-socket "$AGENT_YA_V0_SOCKET" -H "Authorization: $AGENT_YA_V0_AUTHORIZATION" "$AGENT_YA_V0_URL/v0/me"';
  return [
    "[Yep Anywhere API]",
    "You are running inside Yep Anywhere. Inspect your owning session, server and API access with:",
    command,
    "This guidance supersedes earlier Yep Anywhere API bootstrap instructions. Determine current launch authority from /v0/me; never infer grants from remembered instructions or session titles.",
    "Read GET /v0/help for operations and examples. Inspect advertised access and capabilities before acting; consult /v0/schema only for exact fields. Use durable request ids and receipts for authorized session commands, then follow the conversation; admission is not delivery or completion.",
    "Use only configured routes from /v0/servers; inspect the chosen server's /access and /capabilities. Never request or copy peer credentials. Missing connection variables mean API access is unavailable; never guess a port or reuse another credential. Inherited child environments identify the owning YA session.",
    "[/Yep Anywhere API]",
  ].join("\n");
}

const currentFragments = [false, true].map(agentApiBootstrapInstructions);
const legacyFragments = [false, true].flatMap((windows) =>
  [false, true].flatMap((management) =>
    [true, false].map((peers) =>
      legacyAgentApiBootstrapInstructions(windows, management, peers),
    ),
  ),
);
const knownFragments = [...currentFragments, ...legacyFragments];

/** Only exact YA-authored fragments qualify; a heading alone is user prose. */
export function findAgentApiBootstrapInstructions(text: string): string | null {
  return currentFragments.find((fragment) => text.includes(fragment)) ?? null;
}

/** Presentation-only repair; never edit the provider's native transcript. */
export function stripAgentApiBootstrapPrefix(text: string): string {
  if (!text.startsWith("[Yep Anywhere API]\n")) return text;
  for (const fragment of knownFragments) {
    if (text.startsWith(`${fragment}\n\n`)) {
      return text.slice(fragment.length + 2);
    }
  }
  return text;
}
