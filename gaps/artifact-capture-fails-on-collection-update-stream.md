# `artifact:capture` cannot photograph a page that holds a collection stream

`pnpm -s artifact:capture <url>` failed for every app page tried against a
current source server. The client keeps a streaming
`GET /api/activity/collections` response open
(`packages/client/src/lib/collectionUpdates.ts`), and the capture command
treats that stream as a load that never settles and then as a failure:

- Without `--interact` it navigates with `waitUntil: "networkidle"`, which
  an open response never reaches: `page.goto: Timeout 30000ms exceeded`.
- With `--interact` it navigates on `domcontentloaded`, takes the picture,
  and then reports `desktop: Request failed: /api/activity/collections`
  because closing the page aborts the stream and
  `packages/client/scripts/artifact-capture.ts` records every
  `requestfailed` event as a problem.

Seen 2026-11-13 on `/settings/about`, `/settings/machine-control` and
`/new-session` of a fresh `pnpm dev` server with an isolated data directory.
A plain Playwright page on the same URLs showed one such request answering
200 and staying open, with no failed request while the page lived.

Workaround used: a caller-owned Playwright script that navigates on
`domcontentloaded`, waits for the element under test, and presents its PNGs
through `writeCapturePreview`/`emitCapturePreview`, as
[UI testing](../topics/ui-testing.md#a-file-the-user-cannot-see-is-not-a-handoff)
allows for images from any producer.

Not fixed in place: the capture command is outside the Machine Control
change that met it, and whether other servers or modes avoid the stream was
not established. Likely fix: ignore a request aborted by the command's own
page close, and wait on something other than `networkidle`.

Found 2026-11-13 while capturing the Machine Control settings pane.
