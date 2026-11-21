# Provider launches can exhaust host memory

On 2026-11-20, an overnight Tilefun asset review sent 443 Opus launch
requests in 83 minutes, including six retries. Logs show 429 distinct
reviewers registered, with a peak of 11 reviewers recorded in a
turn. The provider host began refusing connections around midnight. YA
could not verify shutdown for 428 reviewers and refused to resume the main
session while its previous process was still unverified. Eight reviews
were left without a verdict.

At 06:20, macOS reported that the system had run out of application
memory and showed **Terminal (paused) at 87.89 GB** on a Mac with 48 GiB of
physical memory. Terminal was relaunched. A later isolated run using the
same Claude CLI version measured about 260 MB for one idle Claude process
and its YA worker. The reviewer buildup could account for memory on that
scale. The simultaneous OS process count and the allocation breakdown at
the time of the alert remain unknown.

[Provider memory admission](../topics/provider-memory-admission.md) now
reserves a per-harness estimate before spawning, includes live provider
trees in its configurable budget, and checks system headroom. A
pre-spawn refusal is machine-readable in v0.

Running workers and tools can grow after admission. The remaining safeguard
is to respond to pressure between launches and reclaim enough verified-idle,
unviewed workers to restore headroom. Protect active turns and pending
input. Keep charging memory until shutdown is verified. A continuously
updated capacity snapshot would also allow authorized agents to resume
dispatch when memory becomes available.

Found 2026-11-20 while investigating the Tilefun overnight review outage.

## Stop receipt and release of admission capacity

On 2026-11-21, the native app fixture observed a PID-verified stop followed
by a `capacity_unavailable` refusal. The host inventory hides closing workers
while their groups still count toward admission. Waiting for the host to remove
the stopped worker's groups before making the new request restored admission
in the fixture. The startup accounting still includes unrelated retained groups
such as the fixture's project-service worker. The API has no receipt for when
the host has released that provider's memory charge.
