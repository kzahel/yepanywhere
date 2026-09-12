# Experimental preview Refresh can leave a relay source unavailable

During the real encrypted multi-host preview E2E, clicking Beta's Refresh after
receiving a finalized native message left Beta unavailable while Alpha and Gamma
remained connected. The selected Beta snapshot remained visible but stopped
updating, and the catalog retained its previous timestamps. This occurred with
the production remote bundle and isolated local relay/server profiles.

Reproduction seam: `packages/client/e2e/conversation-preview.spec.ts`, after
switching to issue grouping, click Beta's Refresh before selecting None. The
attempt to await `data-source-status=ready` passed, but the later failure snapshot
showed Beta unavailable. A transient ready state is therefore insufficient
evidence that the refresh completed durably. The transport failure cause has not
yet been established.

Investigate `PreviewController.include` and its stop/reconnect lifecycle in
`packages/client/src/lib/experimental/previewController.ts` together with the
saved-host relay mux connection owner. Add a dedicated refresh regression that
checks the refreshed catalog and subsequent live updates while peers remain
healthy. Keep this separate from grouping, which is local metadata work and
must not reconnect. The grouping change's browser test passes without Refresh;
cross-machine timestamp sorting is covered by controller and grouping tests.

Found 2026-09-12 while adding None (recent activity) to the experimental preview.
