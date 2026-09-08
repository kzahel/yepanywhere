# Isolated Windows packaged startup fails during provider identity checks

The full npm-distribution startup smoke reaches the top-level
`warnIfCodexVersionMismatch()` in `packages/server/src/index.ts`, then fails
in `ProviderInstallationCoordinator.getOwnStartId()` with "Cannot coordinate
provider installation without Windows process start identity". This happens
in disabled SQLite mode, before `createApp` and SQLite initialization.

Observed on GitHub's `windows-latest` runner with Node 24.19.0:
[failure log](https://github.com/kzahel/yepanywhere/actions/runs/34209925744).
The disposable HOME/USERPROFILE fixture preserves Windows utility configuration
and supplies Windows PowerShell 5.1's module path, avoiding incompatible
PowerShell 7 modules inherited from the Actions shell. The process-start probe
still fails. Whether the remaining failure is caused by fixture isolation or
normal packaged Windows startup is unresolved; it has not been reproduced on
an unmodified base checkout.

Reproduce after building and attaching the locked server dependencies:

```sh
node scripts/test-sqlite-startup.mjs ready
```

Investigate the PowerShell probe's five-second deadline, environment, and
captured error in `services/installationOwnerProbe.ts` using both inherited
and isolated profiles. Do not bypass process identity or owner-only ACL
requirements. This is separate from SQLite loading and storage ownership.

The Optional SQLite workflow gates only full-server startup on Windows.
Packaged SQLite module loading, the real storage contract, Node/Bun file
interoperability, and Node 20 fallback continue to run on all three platforms.
Restore Windows startup steps when this gap is fixed.

Found 2026-09-08 while validating optional SQLite support across platforms.
