# Two-worker hosted macOS native-app cases exhaust their budgets

[Run 42081724289](https://github.com/kzahel/yepanywhere/actions/runs/42081724289),
macOS job 127436238859 at `06c549a79`, fails seven of ten app cases at their
unchanged 30/40-second guards. No browser case runs because the preceding app
step fails. Linux job 127436239368 passes all ten app and three browser cases;
the separate provider run passes all 69 cases. Do not call this a full passing
app/browser matrix or a demonstrated browser/typing regression.

The macOS runner is a three-CPU Apple M1 VM with about 7 GiB memory. Retained
fixture phase reports put initial API readiness at 12.909–20.585 seconds,
consuming much of each case budget before native turns and replacement. Several
cases reach replacement/model requests when their guard expires; no semantic
assertion failure is reported. The start/end host summary reports maximum load
per effective CPU 18.33 and minimum effective available memory about 1.23 GiB.
CPU busy and swap measurements are unavailable. These sparse samples do not
establish the cause of contention or attribute a product performance regression.
Cold whole-app startup is distinct from a warm session-detail request.

A one-worker dispatch of the same published source is a diagnostic control,
with all limits/assertions unchanged. Record its source, capacity and phases;
a pass alone would not erase the two-worker failure or establish a sustained
speedup. Attribute cold startup/replacement, compare prior qualified capacity,
and choose measured budgets or a qualified capacity/worker setting before
claiming macOS acceptance. Do not weaken the 100 ms typing limit or rerun only
to manufacture a green result. Owning evidence/limits belong in
[native provider testing](../topics/native-provider-testing.md).

Found 2026-11-05 while qualifying repeated native tool-result delivery.
