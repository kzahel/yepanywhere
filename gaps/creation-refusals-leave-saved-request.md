# Ordinary creation refusals still leave a saved request to dismiss

The November 2026 stale-recovery lock is repaired: a saved New Session or
Session-page creation request always offers **Start fresh**, and template
creation offers the same after a failed restore
([session identity](../topics/session-identity.md),
[project templates](../topics/project-templates.md)). Two narrower defects
remain from that investigation.

**Untagged refusals.** `packages/client/src/lib/sessionCreation.ts` retires the
saved request by itself only for HTTP 400 with `reason: creation-not-accepted`.
The creation routes answer several ordinary early refusals without that reason:
"Invalid project ID format" and "Invalid JSON body" (400) in
`packages/server/src/routes/session-creation-routes.ts`, and "Invalid creation
request id" (400) and unavailable durable storage (503) in
`packages/server/src/routes/session-creation-requests.ts`. Later refusals on
those routes have not been audited. After one of these the form shows the
unconfirmed-request notice, and corrected input is refused until the user
chooses Start fresh. Nothing is lost and nothing is blocked, but it is an extra
step for a request the server definitely did not save.

Tag each response that is produced before any admission work with
`creation-not-accepted`, after the same committed-result check the tagged
responses already make. Do not tag by status alone: 409 conflicts, 410
deletions and anything that can race an earlier attempt of the same request id
are not proof of non-acceptance. A hosted client can be newer than its server,
so the client must keep working with untagged responses.

**No record of the first failure.** The saved request keeps its identity,
payload and time, but not how the original send failed. The incident's first
transport error was unrecoverable afterwards, which left its dispatch phase
unknown. Keeping the failure's status and message beside the saved request
would let the notice and a later diagnosis say what happened. Keep it bounded
and free of secrets, and do not add durable state beyond the existing record.

Found 2026-11-16 while repairing the stale creation recovery lock.
