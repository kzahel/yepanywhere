# Per-session Agent Auth Router routing for Antigravity

Topic: agent-auth-router

Status: implemented and live-verified, 2026-11-23. Approved by maintainer.
Since 2026-11-25 the bridge described below is a provider-neutral proxy
without the RPC allowlist, and AAR describes the route.
`antigravity-router-bridge.ts`, named in the steps, is now
`router-loopback-proxy.ts` and `antigravity-routed-profile.ts`; see
[plan 198, step 3](198-aar-binding-transport.md#3--describe-the-antigravity-route-and-make-yas-listener-generic).

## Goal

Let Antigravity sessions in Yep Anywhere select `routing=aar` (a pool or explicit account) and receive a per-session AAR binding, matching Claude and Codex. Transport applies only to that session's `agy acp` process—no server-wide `CLOUD_CODE_URL` or `GEMINI_HOME`, and no server restart. Direct Antigravity sessions keep using `~/.gemini` untouched, and Plan 195 native history keeps working for both direct and routed sessions.

## Design choices

- **Per-session loopback bridge in YA:** `agy` cannot send a custom auth header or env var and also sends its OAuth file token directly to Google UserInfo. YA runs a small in-process loopback bridge (`127.0.0.1:0`) per routed `agy acp` process inside `AntigravityProvider` (which runs inside the Provider Host worker when enabled, so Hono reloads preserve active turns and hosted AAR needs no local `aar` binary). The bridge validates `Host` and the local profile marker (`aar_local_...`), allowlists only the Cloud Code `/v1internal:*` RPCs, substitutes the session's `RouterLaunch.token`, forwards to `${route.baseUrl}${target}`, and closes when `agy` exits.
- **One shared YA-managed routed profile dir:** Routed `agy acp` launches pass `--cloud_code_endpoint http://127.0.0.1:<port>`, `--gemini-dir <yaDataDir>/agent-auth-router/antigravity-home`, `GEMINI_HOME`, and `SSH_CONNECTION` (forcing file storage instead of OS keyring) while stripping ambient `CLOUD_CODE_URL`, `AGY_LLM_GATEWAY_URL`, `AGY_ACP_CCPA_PROJECT`, `GEMINI_API_KEY`, and `GOOGLE_API_KEY`. Sharing one routed `--gemini-dir` keeps native history (Plan 195) bounded to at most two stores (direct `~/.gemini` + routed `<yaDataDir>/agent-auth-router/antigravity-home`) while isolating `~/.gemini`'s direct login and allowing concurrent routed sessions on different AAR accounts (each talks to its own bridge port).
- **AAR control, catalog and quotas:** Allow `antigravity` in integration grants, pools, `/v1/selection`, and owner provider discovery; advertise `antigravity-control-v1` in `/v1/info`. Implement `readCatalog` via `POST /v1internal:fetchAvailableModels` (normalizing `groupedModels` + `agentModelSorts` into base model IDs and effort levels matching `agy acp`) and `readAccountQuotas` via `POST /v1internal:retrieveUserQuotaSummary` (normalizing model-family `5h`/`weekly` buckets for `gemini`, `gemini-argon`, `gemini-carbon`, and `3p`, with `agy models` renewal on expired credentials).
- **Compatibility:** Add optional server capability `agent-auth-router-antigravity` (ID 163). Stable-server corpus checked (`v0.10.0`, `v0.10.1`, `v0.10.2`, `v0.11.0`, `v0.12.0`, `v0.12.1`, `v0.13.0`): all lack Antigravity router support and reject `POST /api/agent-auth-router/selection` with `{ provider: "antigravity" }`. Without capability 163, clients hide Antigravity router controls and make no Antigravity router discovery request.
- **Mid-session account switching:** Out of scope for v1 (cross-account continuation on Google's backend is unproven, and direct vs routed use separate native stores). `POST /api/agent-auth-router/sessions/:sessionId/switch` continues to refuse Antigravity.

## Steps

### 1 — AAR control, pools, catalog and quota support

In `~/kzahel/agent-auth-router`:

- Allow `"antigravity"` in `validGrants`, `savePool`, `POST /v1/selection`, and `OwnerService` `providers`; advertise `"antigravity-control-v1"` in `/v1/info`.
- Implement Antigravity `readCatalog` via `POST /v1internal:fetchAvailableModels` (with `antigravity/hub/...` User-Agent, bounded 2 MiB JSON read, filtering `disabled: true`, mapping `groupedModels` and `agentModelSorts` to concrete base IDs and `supportedReasoningEfforts`).
- Implement Antigravity `readAccountQuotas` via `POST /v1internal:retrieveUserQuotaSummary` (using coordinator/renewal so expired access tokens renew via `agy models`), handling untouched rolling resets as unstarted windows.
- Teach `pools.ts` (`windowScope` / `applicableWindows`) about Antigravity's model-family buckets (`gemini`, `gemini-argon`, `gemini-carbon`, `3p`, including Ultra-plan fallback to `gemini` when no separate Argon/Carbon bucket is present).
- Update AAR dashboard UI where provider pickers/quota labels assume only `claude | codex`.
- Add synthetic unit/integration tests covering grants, pools, catalog, quotas, eligibility/ranking, and revocation.

### 2 — YA per-session Antigravity router bridge and dual-store native history

In `yepanywhere`:

- Add `packages/server/src/sdk/providers/antigravity-router-bridge.ts`: owner-only `bridgeProfile()` (`0700`/`0600`, `aar_local_` marker, refuses real Google OAuth credentials or symlinks) and `startAntigravityRouterBridge()` (ephemeral `127.0.0.1:0`, `Host` + marker auth, 7 allowlisted `/v1internal:*` POST routes, `RouterLaunch.token` substitution, bounded timeouts, clean teardown).
- Wire `options.routerLaunch` in `AntigravityProvider` (`antigravity.ts`, `antigravity-runtime.ts`, `antigravity-launch.ts`): start/close bridge per session, pass `--cloud_code_endpoint` and `--gemini-dir <routedHome>`, set `SSH_CONNECTION`, strip ambient endpoint/API-key vars, return `routerLaunch.models` from `supportedModels()`, and use the routed `storageScope` for `getNewSessionNamespace` and `validateResumeSource`.
- Wire the routed Antigravity store into YA's native history discovery/reading (`antigravity-catalog-adapter.ts`, `native-catalog-registry.ts`, `app.ts`, `server-main.ts`, `provider-resolution.ts`) so direct (`~/.gemini`) and routed (`<dataDir>/agent-auth-router/antigravity-home`) sessions coexist with Plan 195 cold reads, paging, watches, and Provider Host ownership.

### 3 — YA router service, capability, v0 API and client UI

- Widen router provider types from `"claude" | "codex"` to `"claude" | "codex" | "antigravity"` across `packages/shared`, `AgentAuthRouter.ts`, `SessionMetadataService.ts`, and `packages/client`.
- Register optional server capability `agent-auth-router-antigravity` (ID 163) and gate Antigravity router discovery/controls on it. Check AAR's `antigravity-control-v1` capability in `AgentAuthRouter` when routing Antigravity.
- Enable `GET /v0/servers/{serverId}/selection?provider=antigravity&routing=aar` and routed `POST /v0/servers/{serverId}/sessions` for Antigravity (`production-sources.ts`, `command-contracts.ts`, `native-session-commands.ts`, `contracts.ts`).
- Update client discovery/selectors (`useRouterDiscovery.ts`, `useNewSessionOptions.ts`, `RouterPoolSelector.tsx`) to support Antigravity pools, models, and Antigravity quota window labels/scopes, including allowing routed Antigravity when `agy` is installed without a direct Google login.

### 4 — Security, lifecycle and live verification

- Add synthetic tests in YA covering: token isolation (never in OAuth file, argv, env, logs, metadata), bridge allowlist/Host/marker checks, profile permission/symlink/real-credential refusals, bridge teardown on exit/abort/startup-failure, revocation and fail-closed resume, dual-store Plan 195 history coexistence, v0 selection/session creation, and older-server capability gating.
- Reload AAR (`aar restart`), create/grant an Antigravity pool for live verification, restart YA's provider host, and test a real routed Antigravity session end-to-end on the live server (including streaming and native history).
- Update `topics/agent-auth-router.md` and `topics/antigravity.md`, run full lint/format/typecheck/test checks, request a review via the YA v0 API (`fable 5.2` medium, bypass perms, work pool), address findings, and commit in both repos.
