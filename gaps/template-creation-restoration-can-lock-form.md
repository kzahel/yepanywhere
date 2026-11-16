# Template creation restore can retain a request with no available reset

Code audit found a related recovery trap in
`packages/client/src/components/TemplateProjectForm.tsx` while investigating
[the ordinary New Session lock](new-session-unconfirmed-request-blocks-further-creation.md).
This was not reproduced on a user's template operation.

The restore effect parses `ya-template-creation:*` from sessionStorage, assigns
`request.current`, then calls `projectTemplatesApi.create(retained)`. Its catch
only sets the error. Even an explicit refusal leaves `request.current` and its
stored copy intact. In contrast, the interactive create catch clears them for
400/403/409.

`locked` includes any retained request. `onBusyChange` also reports busy while
that request has no operation. Fields and attachments stay locked after a
restore failure. The Create button can retry the frozen original request, but
cannot correct its input. Reset is rendered only when a non-null operation has
phase `failed` or `interrupted`, so a failed restore with no operation offers no
reset. Reload repeats the restore. Malformed stored JSON also lacks a guarded
decode in the effect.

Make restore and interactive admission share explicit outcome handling. Preserve
uncertain work and its exact identity without permanently locking the form;
offer recovery independent of whether an operation snapshot was ever acquired.
Do not infer safe replay or deletion from a generic network error, and preserve
the template's filesystem side-effect and idempotency boundaries. Validate the
saved shape before applying it. Fixing this needs its own focused verification;
the ordinary creation helper repair alone cannot cover this separate caller.

Found 2026-11-16 while auditing persistent creation-state recovery traps.
