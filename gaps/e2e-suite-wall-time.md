# Client E2E suite wall time is growing faster than its reduction plan

The full client Playwright suite has nearly doubled since the
[ratchet plan](../docs/tactical/135-e2e-suite-cost-ratchet.md) baseline: 348
listed cases on 2026-09-30, about 590 on 2026-11-08. CI still runs every
case on every pull request and `main` push (`.github/workflows/ci.yml`,
`e2e-tests`). In [run 42507550642](https://github.com/kzahel/yepanywhere/actions/runs/42507550642)
the gate was set by its slower shard:

| Shard | Passed / skipped / flaky | Playwright time | Job |
| --- | --- | ---: | ---: |
| 1/2 | 289 / 9 / 1 | 16.6m | 17m22s |
| 2/2 | 293 / 3 / 0 | 8.5m | 9m20s |

Job setup (checkout, install, browser and sandbox packages) is about 40s, so
nearly all job time is test execution. The shards hold equal case counts but
unequal time: with `fullyParallel: false`, Playwright shards whole files, and
several 20–40s cases cluster in shard 1. The 2026-09-30 ledger recorded the
slower shard at 7m43s; growth, not runner noise, accounts for most of the
current 17m.

Locally, `packages/client/playwright.config.ts` still defaults to
`workers: 1`, although worker-owned mutable services became the default
scope on 2026-09-30 and CI already runs two workers per shard. A plain
`pnpm test:e2e` therefore serializes about 50 CI worker-minutes of cases. With
failures each spending a 15s test deadline and agents rerunning, local full
runs reportedly reach two hours.

## Not fixed in place because

The default worker count, shard count and balance need comparable local and CI
measurements, and the reductions (shared setup, lower-level replacements,
area segmentation) need per-case evidence. The investigation below records
that work.

## Cheap direction

1. Default local workers above one, sized from measured full-suite runs.
2. Balance CI by time rather than file count: more shards, splitting the
   heaviest files, or per-case parallelism where a spec's state allows it.
3. Remove dead waits and duplicated startup, then move state-only browser
   cases to unit/component tests per [E2E testing](../topics/e2e-testing.md).
4. Give the suite a wall-time budget so growth is a review decision.

Found 2026-11-08 while answering why a full local E2E run could take two hours.
