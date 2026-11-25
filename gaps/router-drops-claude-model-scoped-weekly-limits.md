# Router quota ignores Claude model-scoped weekly limits (Fable)

Claude now meters some models against their own weekly allowance. Agent Auth
Router (AAR) never reads it, so a pooled account can be out of Fable while
YA's account picker and AAR's routing both see it as healthy. Fable sessions
pinned to it then stall with a 429 that YA cannot explain.

## Evidence (2026-11-25, one Team-plan Claude account in a three-account pool)

- A `claude-fable-5-2` session got a 429 on the request right after a
  successful one. Body: `rate_limit_error`, "This request would exceed your
  account's rate limit". The Claude CLI recorded
  `rateLimitType: "seven_day_overage_included"` and a `resetsAt` equal to the
  account's weekly reset. AAR's event log has `retryAfter: "268667"` (about
  74.6 h), which ends at the same instant.
- At the same moment, YA's router account picker showed that account at
  "5h 98% left, Week 36% left". `aar account quotas` returned only
  `five_hour` (2% used) and `seven_day` (64% used).
- The claude.ai usage page for the same account showed "All models 64% used"
  and "Fable 100% used", both resetting at the weekly reset.
- The CLI's `get_usage` control response (the source AAR reads) carries the
  limit, outside the keyed buckets:
  - `rate_limits.limits[]`: `{kind: "weekly_scoped", group: "weekly",
    percent: 100, severity: "critical", is_active: true,
    scope: {model: {display_name: "Fable"}}, resets_at: <weekly reset>}`
  - `rate_limits.model_scoped[]`: `{display_name: "Fable", utilization: 100,
    resets_at: <weekly reset>}`
  - `rate_limits.weekly_scoped_shares[]`: `{limit_index: 2,
    used_percent_of_weekly: 50, allowance_percent_of_weekly: 50}`. Fable may
    use half of the weekly limit and had used all of it.
  - The keyed `seven_day_opus` and `seven_day_sonnet` fields were `null`.
- Over the preceding five days this account had served about 1,840 Fable
  requests. The other two accounts served about 30 between them. The pool's
  weekly-pace policy ranked accounts on the all-models weekly bucket only, so
  it kept putting Fable sessions on the account that had used the most Fable.
- Using a Fable reset from claude.ai cut the account's `seven_day` from
  64% to 14% used. It gave back exactly the 50 points Fable had used.

## Where

- AAR `src/quotas.ts` `normalizeClaudeQuotas`: reads the keyed buckets
  (`five_hour`, `seven_day`, `seven_day_oauth_apps`, `seven_day_opus`,
  `seven_day_sonnet`) plus any other top-level object that has `utilization`.
  `model_scoped` and `limits` are arrays, so they are skipped.
- AAR `src/quotas.ts` inference-header parsing reads only the
  `anthropic-ratelimit-unified-5h` and `-7d` headers.
- AAR `src/pools.ts` bucket scope: maps only `seven_day_opus` and
  `seven_day_sonnet` to models. An extra bucket would be `"unknown"` scope.
- AAR `src/pools.ts` rejection handling: `Math.min(retryAfter, 3600)` cuts
  the 74.6 h `retry-after` to a 1 h cooldown. After that hour the account is
  eligible again and the next Fable request gets another 429. The rejection
  event does not record which limit was hit.
- YA direct (unrouted) usage already parses `model_scoped`
  (`packages/server/src/sdk/providers/provider-subscription-usage.ts`,
  `normalizeClaudeSubscriptionUsage`). Only the routed path loses it.
- YA `RouterPoolSelector.tsx` / `AgentAuthRouterPools.tsx` label only known
  bucket ids. A model-scoped router bucket needs a label such as
  "Week · Fable".

## Fix direction

1. In AAR, turn `model_scoped[]` entries (or `limits[]` entries with
   `kind: "weekly_scoped"` and a `scope.model`) into weekly windows with a
   stable bucket id, such as `seven_day_model:<normalized display name>`,
   that keep the model display name.
2. Give those buckets a model scope in `pools.ts`, resolved against the
   account's CLI catalog as YA's `resolveModelBucket` does. An exhausted
   Fable bucket should then make the account ineligible for Fable only.
3. When a 429's `retry-after` lands on a known window's `resetsAt`, keep the
   full cooldown for that scope instead of capping it at 1 h. Record the
   limit type from the response (the CLI saw `seven_day_overage_included`)
   in the rejection event.
4. In YA, label model-scoped router windows in the picker and pools view.

Not fixed in place: the defect is in AAR's quota model and routing policy,
which need tests over synthetic `get_usage` fixtures. YA's pool display
changes depend on the AAR bucket shape.

Found 2026-11-25 while investigating a routed Fable session that stopped with
"Claude rate limited" while its account showed 98% of the 5-hour window left.
