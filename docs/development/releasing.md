# Releasing and deployment

[Contributor guide](../../DEVELOPMENT.md) · [Development docs](README.md)

Commands and code paths below are relative to the repository root unless stated
otherwise.

## Releasing to npm

The package is published to npm as `yepanywhere` using GitHub Actions with OIDC trusted publishing (no npm tokens stored in secrets).

**Before releasing:**

1. Update `CHANGELOG.md` with a new version section:
   ```markdown
   ## [0.1.11] - 2025-01-24

   ### Added
   - New feature description

   ### Fixed
   - Bug fix description
   ```

2. Commit the changelog update

3. Tag and push:
   ```bash
   git tag v0.1.11
   git push origin v0.1.11
   ```

The CI workflow verifies the changelog contains an entry for the version being released. If missing, the release will fail with instructions to update the changelog.

The workflow requires lint, formatting, typecheck and tests, then calls
[npm package acceptance](../../.github/workflows/npm-package.yml). That job
builds the tagged version, packs it once, installs it outside the checkout and
requires production startup plus real Claude/Codex API, tool, WebSocket and
restart/history scenarios against scripted local model APIs. No paid inference
or provider account is used. The same job runs on relevant pull requests and
can be dispatched manually.

Publication downloads the accepted archive, verifies its version and SHA-256
against `acceptance.json`, and publishes that exact `candidate.tgz` through
trusted publishing with automatic provenance. It does not rebuild or repack
after acceptance. The workflow
retains the candidate, acceptance record and server diagnostics as the
`npm-package-acceptance` artifact, and creates a GitHub Release with changelog
notes. A failed acceptance job prevents publication.

To exercise the same gate locally:

```bash
pnpm build:bundle
pnpm test:package
# Check an existing candidate without rebuilding or repacking it:
pnpm test:package --tarball=/absolute/path/candidate.tgz --expected-version=0.11.0
```

Outputs live in `dist/npm-release/`. Required executables fail explicitly when
missing; the check never substitutes a fake CLI or a paid endpoint. See
[native provider testing](../../topics/native-provider-testing.md#installed-npm-package-acceptance)
for the precise boundary, isolation and qualification limits.

## Releasing the Website

The website (landing pages + remote relay client at `/remote`) is deployed to GitHub Pages separately from npm. **Pushing to main does NOT deploy the site** — it only runs CI (lint, typecheck, tests). The site only deploys when a `site-v*` tag is pushed (or via manual workflow_dispatch).

See [site/RELEASING.md](../../site/RELEASING.md) for the full process.

Quick reference:
```bash
# Update site/CHANGELOG.md first, then:
scripts/release-website.sh 1.5.3
```

## Releasing the Chrome extension

Update and commit `packages/browser-extension/CHANGELOG.md`, then run
`scripts/release-extension.sh <version>` from a clean `main` checkout. The
helper bumps the independent extension version and pushes its release tag.
CI accepts the exact ZIP, submits it through keyless Google authentication,
and records a GitHub release. Google review remains asynchronous. See
[Chrome Web Store publication](../distribution/chrome-extension/README.md)
for setup, read-only verification and listing/privacy requirements.

## Deploying to Staging

The staging deploy runbook is host-specific and intentionally kept out of this public
repo. It lives in the private dotfiles repo: `~/code/dotfiles/machines/pi/README.md`. If
asked to deploy to staging, read the steps there.

## Preparing native mobile stores

See [mobile store preparation](../distribution/mobile/README.md) for shared
listing copy, existing icons, initial artwork, and the boundary between internal
testing and public store submission. Private account and credential inventory
lives in the dotfiles runbooks.

## Coordinated source releases

For a coordinated release, prepare all product version metadata and changelogs
in one commit on `main`. The standalone desktop and extension helpers normally
create their own version commits; applying those metadata changes together
keeps the release tags on one source revision. Push the candidate to `main`
and pass platform CI plus the extension's manual `package` acceptance run.
Recheck the clean source, unused versions, changelogs and extension store
identity, then atomically push the npm, desktop and extension tags to that
verified commit. The tagged workflows retain their normal tests, exact-ZIP
acceptance, signing and publication checks.

The Android internal workflow can run in parallel; its own build and native
acceptance gates still precede publication. Dispatch it on the same `main`
revision and verify the workflow's `headSha` matches the coordinated release
commit. The dispatch pins its source; later branch movement does not change
the selected artifact.
Chrome review and Android public-beta promotion remain separate delivery steps.
