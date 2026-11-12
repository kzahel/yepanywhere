---
slug: unreviewed-code
noticed: 2026-11-12
where: the paths and commit ranges listed below
---

**Gap:** code changed in these ranges never had the strict review. The user
approved skipping each so that automatic reviews could resume from a point
small enough to act on. Each list line below is one skipped range: a path,
the commits in which its code changes went unreviewed, and their size.
`review-due skip` adds a line and `review-due` starts counting that path
after its range.
**Fix sketch:** strict-review one line's path over its range, then remove the
line (`review-due unskip --path <path>`, or by hand). Remove this file with
its last line.

## Skipped ranges

- `.` `f2daae2c063b39d506969dffa75eebefbf8076f0..01ead1d017fdace17e297f3b4a46ab84d893904e` 644299 lines, 1388 commits; skipped 2026-11-12: User approved cutoff for public Markdown copy task
