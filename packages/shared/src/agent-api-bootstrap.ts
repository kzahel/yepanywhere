/** Distinct from the legacy narrow ya-agent self/view connection. */
export const AGENT_API_BOOTSTRAP_ENV = {
  url: "AGENT_YA_V0_URL",
  socket: "AGENT_YA_V0_SOCKET",
  authorization: "AGENT_YA_V0_AUTHORIZATION",
} as const;

/** Values are variable references only; never render an actual credential. */
export function agentApiBootstrapInstructions(
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
