# Yep Anywhere Agent Instructions

Core contributors are two different people; do not conflate them when
attributing history:

- Kyle Graehl: `kgraehl@gmail.com`, `kzahel@users.noreply.github.com`.
- Jonathan Graehl: `graehl@gmail.com` (commits as `graehl`),
  `99024+graehl@users.noreply.github.com`.

Before implementation planning or repository changes, read and follow
[DEVELOPMENT.md](DEVELOPMENT.md). Follow its task-reading triggers for applicable
development guides and topic documents before choosing an approach; recheck
them when the task expands.

Before planning or implementing new work, search the relevant `gaps/`
directories. Read and cite matching defects, follow-ups, or plans
before defining new work. Follow [gaps/README.md](gaps/README.md).

Before proposing or reprioritizing work, read the
[Roadmap](docs/roadmap/README.md). Keep its status and blockers current when
roadmap work changes.

For architecture, stability, performance, or security questions, start at
[ARCHITECTURE.md](ARCHITECTURE.md) and its linked topic docs before deriving
an approach.

For UI proposals or mockups, read [UI design](topics/ui-design.md) before
choosing fixtures, rendering, or export commands.

When `AGENT_ARTIFACT_VIEWER_ORIGIN` is set, this session can present images and
documents to the user, so deliver every screenshot, mockup, or generated report
through the repository's artifact capture facility. Writing a file and naming
its path delivers nothing the user can see.
[UI testing](topics/ui-testing.md) owns the commands and the invocations that
silently skip presentation.

The working tree may contain concurrent human or agent edits. Avoid reverting
or tidying unrelated changes unless the task directly requires them.

When adding, reviewing, removing, or accelerating tests, read
[test value and CI cost](docs/development/testing.md#test-value-and-ci-cost).
Agents are authorized to avoid or remove shallow mocked/local tests whose
likely regression value does not justify their ongoing cost, including tests
that helped prove an initial implementation. Prefer meaningful integration,
tricky-interaction and race coverage; accelerate retained tests to keep CI
latency and load stable over time.

## Agent Attribution

Record agent involvement with a `Contributing-model: <short-model-name>`
trailer, one per contributing model, and with nothing else. Do not credit an
agent as an author: no `Co-Authored-By` trailer naming a model, no
"Generated with" banner, no robot-emoji line, and no commit authored from a
no-reply bot address. The trailer states which model helped; an authorship line
states that it wrote the commit, which is the claim this project does not make.

`scripts/check-no-agent-attribution.mjs` enforces this, and `.husky/pre-push`
runs it on every push, so an install activates it in any clone. It refuses
before the first destination accepts the commit, which is the point: publishing
destinations disagree about what they accept, and once a violation reaches
shared history it can no longer be rewritten.

Only unpublished commits are checked. Anything a remote already carries is
accepted history that must not be rewritten, so refusing to push it onward
would make `--no-verify` the routine path and the guard would stop meaning
anything. A commit reaches its first destination only by passing the check, so
being excluded here means it was clean earlier or it arrived from upstream.

```bash
node scripts/check-no-agent-attribution.mjs --range origin/main..HEAD
node scripts/check-no-agent-attribution.mjs --range HEAD~50..HEAD --any
```

`--any` reports published commits as well, for auditing rather than gating.

For existing and new UI features, verify real sequential typing under the
feature's expected data volume and concurrent updates. Dropped user keystrokes
are never acceptable; each keystroke must appear within 100 ms. Whole-field
replacement tests do not establish this. Keep input acknowledgement independent
of navigation, filtering, scans, and result rendering; add a regression check
when changing those paths.
