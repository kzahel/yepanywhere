# Provider memory admission

New managed provider launches and cold resumes check memory before spawning.
The provider host owns admission for its workers, including auxiliary launches.
The server's supervisor owns admission for processes it starts directly.
Reattaching to a live hosted worker does not require a new reservation.

Each process owner defaults to a budget of half the effective host memory.
The effective total is bounded by the process memory constraint when the OS
reports one. Set `YEP_PROVIDER_MEMORY_LIMIT_MIB` in the server or provider-host
environment to a positive whole number of MiB to override the budget.
`0` disables the check for that owner. An unset or invalid value selects the
automatic budget. A separately launched provider host reads its own environment.
`MAX_WORKERS` remains an independent operator limit.

Admission accounts for live worker trees and outstanding startup reservations.
A Claude-family launch reserves 512 MiB. Other providers reserve 384 MiB.
One shared, short-lived process snapshot estimates resident memory for live
trees, including descendants and hosted process groups. Windows uses native
process working-set sizes. Shared pages can inflate these totals. Missing
observations charge at least the startup estimate. Start reservations are
released when ownership is registered or startup ends, and closing hosted
workers remain in the budget until their process groups are verified stopped.

The next launch must also leave system headroom. The floor is one eighth of
effective host memory, capped at 2 GiB. This accounts for activity outside YA.
Linux reads `MemAvailable` and also observes constrained-process availability.
For cgroup v2, inactive file cache counts as reclaimable within each memory
limit. macOS reads free, inactive, and purgeable pages from `vm_stat`, including
when the server runs under Bun or older Node versions. Windows uses the
runtime's available physical memory. Each platform probe coalesces concurrent
launch requests and has a bounded command timeout.

When the launch would exceed the budget or available headroom, YA refuses it
before starting a provider. Ordinary routes that return the refusal directly
use HTTP 503 and the code `capacity_unavailable`. Durable creation routes can
acknowledge the saved request before startup. In that case the saved attempt
fails with known non-delivery. The [v0 create receipt](http-api-v0.md) reports
`failed` with `failure.code: "capacity_unavailable"`; replaying its idempotency
key still returns that receipt.

This guard bounds admission. Existing processes can grow after admission and
tools outside the managed trees can consume system memory. Idle workers remain
subject to [the existing teardown rules](reload-safe-provider-runtimes.md#configurable-idle-reap-courtesy).
The [memory-pressure gap](../gaps/provider-launches-can-exhaust-host-memory.md)
tracks reclaiming eligible idle providers in response to pressure.
