# Provider CLI selection still needs packaged GUI launch qualification

The shared [installation selector and execution gate](../topics/provider-cli-installations.md)
fix the version-only Codex discovery defect. Native command-driven qualification
passes on macOS arm64, Windows ARM64 and Linux arm64 with a desktop-like PATH,
fnm's default alias outside PATH, no executable override, a versioned incomplete
fallback, and actual command output from the selected complete runtime. Native
and browser regressions cover explicit failures, cache invalidation, teardown,
selection persistence and typing during probe results.

Those runs do not qualify a GUI-launched packaged YA build or the full installer
and CPU architecture matrix. The Windows appliance's guest command channel was
available, but its interactive desktop/resident was unavailable; no desktop repair
was attempted as part of the Codex fix. The existing native app fixture still
supplies an executable override, so it cannot establish automatic packaged
desktop discovery on its own.

Release qualification should launch the candidate desktop package through its
ordinary GUI entry point, inspect the inherited environment through production
diagnostics, and require real tool output after automatic selection. Include the
complete app-bundled alpha plus the stale fallback case, rather than inferring
that launch environment from a terminal or replacing the CLI selection with an
override. Preserve the existing ownership/claim and isolated-profile boundaries.

Deferred because this is packaged release/GUI qualification after the shared
runtime repair, not evidence that the reproduced version-only defect remains.

Found 2026-11-15 while implementing and qualifying provider CLI installation
selection with the Machine Control Windows and Linux testbeds.
