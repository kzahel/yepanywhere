# Provider-host yacron launch requests

Status: **proposal only; provider-host queue/admission ownership is not
implemented.**

The provider-host-integrated [yacron proposal](../yacron.md) identifies a durable
launch/join-and-prompt request that could replace Project Queue's current
in-memory launch handoff. Standalone yacron is not a candidate: it cannot see
all YA queues, apply the complete project idle predicate, or reserve against
every provider launch path.

The current Hono `WorkerQueue` handoff associates deferred launches through
one-shot in-memory `onStarted`, `onFailed`, and `onRetryableFailure` callbacks.
That is a real recovery seam even though it is not proven to explain every
observed failure to launch a Project Queue session.

The integrated design first makes the provider service the durable owner of
accepted queued/deferred/patient input and project launch admission. A Project
Queue item enters the provider's per-project FIFO admission lane when it is the
selected head; a due yacron fresh-session occurrence enters the same lane when
due. Existing-session queued input remains a project-idle blocker and drains
before either kind of fresh exclusive launch. The provider service applies the
complete [Project Queue idle predicate](../project-queue.md#project-idle-predicate),
including the `/done` exception, and performs the final recheck plus reservation
atomically.

The accepted request retains a request id, queue source, project, prompt
snapshot, admission order, launch settings, sandbox facts, and retry/receipt
state. It publishes the final canonical YA session id/metadata on
`session-ready` and prompt acceptance on `submitted`. Hono reconnects by request
id after reload; Project Queue settles its durable item only from those retained
states and keeps its existing backlog, pause, retry, and UI semantics.

This candidate depends on the provider host becoming a durable profile-scoped
service rather than today's checkout-bound wrapper-lifetime process. It also
depends on queue ownership moving below Hono. Neither precondition may be
replaced by a best-effort callback or a standalone yacron preflight.
