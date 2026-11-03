# Older-server Session ID Remap Compatibility

Current servers keep one permanent public session ID and bind provider-native
identity separately. They do not emit `session-id-remapped` or focused-stream
`session-id-changed`, retain temporary process aliases, or move metadata,
receipts, peer associations, recent visits, issue evidence or Source Review
associations after startup. [Session identity](session-identity.md) owns that
creation and native-translation contract; [Plan 171](../docs/tactical/171-durable-session-identity-and-creation.md)
records the legacy implementation retirement.

Current clients still support older servers that replace a provisional ID.
Their remap reducers and focused-route URL replacement remain compatibility
behavior scoped to the connected source. Existing native-history adoption and
resume are independent: an older session's public ID stays unchanged, including
when it historically equals its native ID. Persisted receipt aliases written by
older releases remain readable; new servers have no alias-writing path.

## Client Observable Contract For Older Servers

An older server can emit `session-id-remapped` with `oldSessionId`,
`newSessionId`, `projectId`, `processId`, `provider` and `timestamp`.
The client then:

- Merges and rekeys the entity and all normalized query/inbox/runtime/Queue
  references, with at most one row under the canonical ID.
- Resolves later old-ID events, snapshots and selectors through at most 256
  flattened source-local aliases, without a timer-driven cleanup path.
- Chooses content, metadata, project, lifecycle and unread groups by their
  observation freshness. Canonical wins ties; stale canonical lifecycle cannot
  overwrite newer provisional activity. Earliest creation evidence remains.
- Preserves inbox tier priority when memberships collapse: attention, active,
  recent activity, unread eight-hour, then unread twenty-four-hour.
- Applies an older focused stream's `session-id-changed` to the open URL.

Client activity/reducer/store and recent/inbox regressions retain these cases.
New-server tests instead prove stable public IDs through delayed native init,
no native-ID process aliases, and admitted identity across failure/restart.
Old server-emission, metadata-moving and observer-wiring tests were retired with
their engines. Legacy database fixtures exercise preserved receipt/peer reads.

## Historical Motivation

The following incidents predate permanent YA identity. They explain why clients
must retain reconciliation for supported older servers; they do not describe
current server startup.

### Evidence

Server log evidence for the observed `mclone` session:

- `2026-07-06T10:20:19.202Z`: `session_registered` emitted for temporary ID
  `5f84842d-6f10-4b5d-92c9-929b99b922bd` and forwarded as `session-created`.
- `2026-07-06T10:20:19.229Z`: the Claude SDK reported canonical ID
  `42042f7a-30d8-4eba-8b52-59fb8683846f`.
- `2026-07-06T10:20:19.230Z`: Supervisor logged
  `session_id_mapping_updated` from the temporary ID to the canonical ID.
- The adjacent activity forwarding after the remap included
  `session-status-changed`, `project-queue-changed`, `file-change`, and later
  `session-updated`; it did not include a public remap event.
- The canonical session JSONL and SDK raw stream identified the model as
  `claude-fable-5`, matching the Fable tooltip row.

The normal New Session reproduction from July 24, 2026 followed the same race:

- `18:08:38.318Z`: the five-second wait expired and YA published temporary ID
  `92e12bac-9971-4aba-a8c6-cc1963d35621`.
- `18:08:38.348Z`: Claude reported canonical ID
  `8de8ddcf-fbd3-43c7-8cbd-8a1f78283ccf`, only 30 ms later.
- Both IDs mapped to process `6903e5c7-e76f-412c-986a-a6581d01443e`; there was
  one JSONL transcript and one provider process, which explains why both rows
  showed the same live response.
- The duplicate disappeared before the first turn completed. The summary
  store's 60-second preservation window for an event-created row, followed by
  a replacement snapshot, explained the eventual cleanup; turn completion was
  not the identity-reconciliation mechanism.

This also rules out the "missing session id" theory. The provisional row had a
real YA-generated UUID. The issue is that the client never learned that the
temporary UUID and canonical UUID were the same logical session.
