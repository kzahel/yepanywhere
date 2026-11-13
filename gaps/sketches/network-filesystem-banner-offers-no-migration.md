# The network-filesystem warning tells the user to move the data directory but cannot do it for them

`StorageFilesystemBanner`
(`packages/client/src/components/StorageFilesystemBanner.tsx:62`) appears when
the server refused to open `discovery.sqlite` because the data directory is on
a network filesystem ([required SQLite](../../topics/required-sqlite.md) § Data
directory placement). It names the filesystem and prints the `YEP_DATA_DIR`
assignment to set, which leaves the actual move as manual shell work the user
does outside YA, on a server they then have to restart. The banner should carry
a control that offers to do it, next to the Dismiss button.

This is the upgrade path, and it is the only path these users get. A first-start
flow that picks a suitable filesystem reaches new installs only — by the
condition recorded in [required SQLite](../../topics/required-sqlite.md) § When YA
may choose the directory for the user, it cannot fire for anyone whose
`~/.yep-anywhere` already exists, which is exactly this population. Their entry
point is this banner, on the load right after they upgrade to a server that
refuses the share.

So the placement chooser wants to be a component the banner can open, not a
step inside onboarding. Neither exists yet: `getDataDir`
(`packages/server/src/config.ts:58`) still resolves `YEP_DATA_DIR`,
`YEP_PROFILE`, then `~/.yep-anywhere` with no selection step, and the server
side a chooser needs — enumerate candidate local filesystems, report free space
— has no route. `packages/server/src/lib/filesystemKind.ts` already reports
free bytes and a filesystem category per directory, so that part is a caller
away.

What makes the move itself its own piece of work rather than a banner tweak:

- **The unit is the whole data directory, not the database.** Moving only
  `discovery.sqlite` would split YA state across two filesystems and break the
  `{dataDir}` contract that [app-data ownership](../../topics/project-directory-storage.md)
  owns. Logs, indexes, uploads, the session catalog, and every JSON store go
  together.
- **The server is holding those files open**, including an append-only log with
  no rotation, so a live move is not a `rename`. The whole point is to land on a
  different filesystem, which makes it a copy, and a copy invalidates every open
  descriptor rather than following it. That is what forces the close-and-reopen
  below.
- **A mid-operation move is a supportable option, at a stated price.** Not
  every migration has to wait for the next start. It can happen while the server
  runs, on the condition that everything holding a descriptor in the data
  directory closes before the copy and reopens after it, with no writes in
  between. Enumerating those holders is the work, and the set is larger than
  this server's own stores: it includes the unrotated log, the session catalog,
  the JSON stores, the vocabulary table and its filter, and any descriptor a
  provider process opened there. A provider is a separate process YA does not
  get to reopen files inside, so either the enumeration proves providers hold
  nothing in the data directory, or those providers are part of the sequence.
  Do not build the copy before that set is known and closable.
- **Otherwise the offer only appears when nothing holds the directory.** That is
  the cheap version and it is worth shipping first: with learning enabled the
  bloom file is open there by design, so the banner warns without a button until
  the sequence above exists. See
  [the vocabulary placement gap](../vocabulary-scratch-placement-is-never-surfaced.md).
- **One banner serves both placement reasons.** The signal carries a reason
  text and the banner is otherwise identical whether SQLite refused at startup
  or vocabulary learning degraded onto the same directory, so the user gets one
  instruction and one migration offer rather than two of each.
- **Which means it needs a restart, and restarts are the user's.** Where the new
  location is recorded so the next start finds it is the open design question.
  `YEP_DATA_DIR` lives in the launcher's environment and the server cannot set
  it for itself, so this may need a pointer file that `getDataDir` consults.
  [First-start placement](first-start-data-directory-placement.md) proposes
  a symlink at `~/.yep-anywhere` instead, which needs no new lookup.
- **The old directory must not be deleted by YA.** A copy that leaves the
  original in place is recoverable; anything else is a destructive action on the
  user's only copy of their session metadata.
- **Finishing the move should end in storage actually opening, and that
  happens at startup.** The point of the migration is the database, so the user
  needs to see that it worked rather than a report that files were copied. The
  open belongs where it already is: constructing the app graph opens the
  database and wires its consumers. Do not add a lazy open on first consumer
  use, and do not mutate a running graph to hand a late-arriving database to
  features that already started without one. Today `DiscoverySqliteService` is
  built once and deliberately never retries, which
  [required SQLite](../../topics/required-sqlite.md) states as a contract
  ("version requests do not probe storage or retry initialization"), and
  `app.ts:2061` and `app.ts:2148` each call `getDatabase()` once and skip
  wiring their feature when it returns nothing. All of that stays. The
  migration therefore concludes by needing a start against the new location,
  and the design question is only how the user gets one — the existing reload
  path rebuilds the app graph, while a process restart is the user's to
  perform.

Until then the banner's manual instruction is correct and sufficient — a user
who follows it gets a working server.

Found 2026-09-10 while landing the startup filesystem check, when a planned
first-start data-directory selection flow raised the upgrade case it does not
cover.
