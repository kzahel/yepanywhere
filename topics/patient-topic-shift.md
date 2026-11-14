# Patient topic shifts

> Queue the next topic for an existing session to deliver after the current
> work finishes, keeping its context, with optional compaction first.

Related: [queue intent](message-control-steer-queue-btw-later-interrupt.md)
owns the delivery-intent matrix; [provider work](provider-wait-and-background-work.md)
owns what each provider reports about work outliving a turn;
[session context actions](session-context-actions.md#user-initiated-compaction)
owns compaction itself. Still-open design: the
[sketch](../gaps/sketches/patient-topic-shift.md).

## Entry points

Two entry points create the same patient queue item and differ only in
where the item came from:

- **Next topic when done**, a session toolbar action (presence key
  `topicShift`), hidden by default and independently placeable like other
  toolbar controls. It is offered when the composer can queue, which is while
  the session is busy. Users may show it instead of Project Queue or beside
  it: a topic shift can rely on the current conversation, while Project Queue
  suits work the typed request describes on its own. Neither starts a new
  session.
- An ordinary queue send while **Wait until fully done** (the patient queue
  default) is on.

Each item records its source as `messageMetadata.patientSource`
(`topic-shift` or `patient-default`). Default steering stays immediate and is
unaffected by either.

## Waiting

The provider's existing patient behavior decides when the item is ready.
Claude waits for verified idle after reported background work, then the
quiet interval. Other providers deliver at the ordinary turn end. Codex
background terminals are recorded but do not hold delivery; deciding which
surviving jobs should count as unfinished work is the open problem in the
sketch.

## Compact first

Each source has its own threshold in **Settings → Message Delivery**:
**Compact before patient queued messages** (`clientDefaults.patientQueueCompactAtPercent`)
and **Compact before Next-topic messages** (`clientDefaults.topicShiftCompactAtPercent`).
Each is a whole percent of the session's context window from 1 to 100, and
**100% is Off**, not "compact at full context", so an over-limit usage
estimate cannot trigger compaction. An unset value is also Off. Both default
to Off. Existing patient-default users therefore keep plain patient delivery
with no YA compaction, and existing false or absent patient defaults stay off.

The client stamps the active threshold onto the item at queue time as
`messageMetadata.compactAboveContextPercent` (1–99). An item accepted with a
policy keeps it; changing the setting later does not change queued items.
The server ignores the field on non-patient sends.

When an item with a threshold reaches its delivery point:

- YA reads context usage at that moment, not at queue time, against the
  session's effective context window. Missing usage, usage that cannot be
  read, and the stale size reported after a compaction until the next turn
  all count as below the threshold. The item then delivers normally.
- At or above the threshold, YA runs the provider's compact command (Claude
  `/compact`; Codex `thread/compact/start`), holds the item while it runs,
  and delivers it exactly once after compaction completes. A provider with no
  compact command delivers the item without compacting.
- If compaction fails or times out, the item stays queued with the visible
  status **Compaction failed; waiting**, and the failure reason appears as its
  tooltip. YA does not retry. The user chooses **Send without compacting**
  (`POST /api/sessions/:sessionId/deferred/:tempId/deliver-without-compaction`),
  **Steer now**, or Cancel.
- If new input or a turn starts before compaction starts, the item waits for
  the next delivery point and is evaluated again then.
- A held item also holds the patient items queued behind it, so later patient
  thoughts never overtake it. Regular queued messages still pass patient ones,
  as before.

While compaction runs, the item shows **Compacting first**. Compact-first and
YA's idle threshold compaction (the per-model **Compact early** setting) never
run at once for one session. If idle compaction has just run, the stale-usage
rule above lets the item deliver without compacting again.

Hinting the model to compact (for example a visible "consider compacting"
note) is not implemented. Merely accepting prompt text is no evidence that a
provider will compact. A provider may skip YA-managed compaction only after
its own hint is shown to work better, and it must never both hint and
compact for one item. No provider has that exemption.

## Restart and process lifetime

The item's source and threshold travel in the persisted patient queue
metadata. A held item keeps an idle process alive like other patient items.
An orderly reload/restart restores previously running patient items through
[orderly queue recovery](reload-safe-provider-runtimes.md#orderly-queue-recovery).
Crash/interrupted recovery remains paused. Restored or manually resumed items
evaluate compaction again at their next delivery point.

## Compatibility

Capability `patient-topic-shift` (permanent ID 132, version-implied from
0.9.4) covers the new message metadata fields, both thresholds, the
`topicShift` toolbar presence key, the queue summary's `compactionGate` field,
and the deliver-without-compaction route. Stable v0.9.0–v0.9.2 drop unknown
message metadata, so a hosted client without the capability hides the action,
the toolbar setting and both thresholds, and sends ordinary patient items.
No existing capability changes meaning. The maintainer's standing
client/server compatibility approval covers this gate.
