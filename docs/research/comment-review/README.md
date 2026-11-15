# Source comment sweep

[Comment policy](../../../topics/comments.md) · [File checklist](files.md)

Review whole files and check them off after inspecting their comments in
context. Git records the deletions; no per-comment decisions or keep reasons
are maintained. A checked file means a sweep was completed, not that its
comments can never need another review.

Start with files containing concentrated narration: older WebSocket tests,
then older route and provider modules. Search patterns such as “Get”, “Build”
and “Track” identify candidates; read the code before deciding. Keep useful
constraints, intent, units and invariants under the comment policy.

Skip generated code, vendored sources and fixture payloads. Review the owning
generator or source if its comments need work. Track real tests, including
integration tests, as ordinary first-party files.

Commit coherent file or directory sweeps separately from behavior changes.
For TypeScript comment-only changes, compare comment-stripped emitted
JavaScript against the commit baseline after normalizing emitted formatting
(for example, with esbuild's whitespace-only minification). Removing a comment
can let a formatter collapse an empty block without changing code. Run the
applicable repository checks. Review all comments in a file before checking it
off; partial edits do not count.

The checklist was seeded on 2026-11-15 from first-party, comment-bearing
source/configuration paths in the earlier snapshot, filtered for generated,
vendored and fixture content. It is a progress aid, not a completeness claim:
add new or missing files when encountered, remove retired paths, and reopen a
file when another sweep is warranted. Do not maintain comment counts or a
removal quota. The retired block snapshot remains available in Git history.
