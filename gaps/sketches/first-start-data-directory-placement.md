# First start accepts a network home directory as the data directory

A new install resolves its data directory to `~/.yep-anywhere`
(`getDataDir`, `packages/server/src/config.ts`) and creates it wherever the
home directory lives. On an NFS home the first start therefore produces the
install that [required SQLite](../../topics/required-sqlite.md) § Data
directory placement already rejects: the database stays closed and
`StorageFilesystemBanner` tells the user to set `YEP_DATA_DIR` by hand.
Detection is done; choosing a better place is not. This sketch is the
first-start half. The already-installed half is
[migration from the banner](network-filesystem-banner-offers-no-migration.md),
and both should open the same chooser.

Direction proposed by the maintainer, 2026-11-13: at first start, from a
source checkout or a packaged install, look for a suitable local,
non-memory filesystem, put the data directory there, and leave a symlink
at `~/.yep-anywhere` where the platform supports one. Ranking candidates by
measured SQLite lock latency is a lower-priority addition.

## What exists

- `packages/server/src/lib/filesystemKind.ts` classifies a directory as
  network, memory-backed or FUSE and reports free bytes. Its table is
  Linux-only; macOS and Windows shares read as local disk.
- `openDiscoveryDatabase` (`packages/server/src/storage/discovery-sqlite.ts`)
  refuses a network data directory, and the banner reports it.
- The trigger is already a contract: YA may choose only when there is no
  `YEP_DATA_DIR`, no named `YEP_PROFILE`, and `~/.yep-anywhere` does not
  exist (required SQLite § When YA may choose the directory for the user).
- No candidate enumeration, no chooser, no place to record a choice.

## The symlink is the record

The migration sketch leaves open where a chosen location is recorded, since
the server cannot set `YEP_DATA_DIR` for its own next start, and suggests a
pointer file. A symlink at the default path needs no new lookup:
`getDataDir` is unchanged, `statfs` follows the link so the existing check
classifies the target, every launcher and every document that names
`~/.yep-anywhere` keeps working, and `ls -l` shows the user where the data
is. The maintainer's own host runs this way, with the home on NFS and the
link pointing at local XFS.

On a home shared by several hosts the link is one per home while local
disks are one per host. A target such as `/local/$USER/.yep-anywhere`
resolves to a different disk on each host, which gives each host its own
YA state. That is the correct outcome, and it means a start can find the
link dangling on a host that has never run YA. A dangling link whose
parent is a suitable local filesystem should be created without a second
question; any other dangling link is an error to report, not a reason to
choose again.

Where symlinks need privilege (Windows without developer mode) the
fallback is the pointer file or a printed `YEP_DATA_DIR` line. Windows and
macOS are not classified today, so this fallback matters only once they
are.

## Choosing a candidate

No standard names a per-user persistent local directory on a host with a
network home; `/local/$USER`, `/scratch/$USER`, `/data/$USER` and
`/var/tmp` are site conventions. So YA can propose and cannot know:

- Exclude memory-backed filesystems, `/tmp`, and anything a cleaner ages
  out. `/var/tmp` is local and persistent across reboots, and
  `systemd-tmpfiles` deletes untouched files there after 30 days by
  default, which would silently take session metadata.
- Require a writable directory owned by the user, created mode `0700`,
  with free space above a floor.
- A local scratch disk is often unbacked and may be purged by site policy.
  The user gives up the home directory's backup to get a working server,
  so this is a consented choice with the trade stated, never a silent one.
- Offer a path field. A user who knows the site's convention is better
  informed than any list.

## Where it runs

There is no installer script: packaged installs are the npm CLI and the
Tauri desktop wrapper, and a source checkout runs `pnpm start` or
`pnpm dev`. The check therefore belongs to first start.

- An interactive terminal can ask. A start with no terminal (service
  unit, tmux launcher, desktop wrapper) cannot, so it needs a
  non-interactive form: a setup subcommand or flag that takes the target
  and creates the link, which the refusal message prints ready to run.
- The directory must not be created before the answer. Today each
  service creates the data directory as it initializes, and once it exists
  the trigger above no longer holds and the case becomes migration. The
  decision therefore has to precede every service's initialization.
- The desktop wrapper passes an explicit `YEP_DATA_DIR`
  (`packages/desktop/src-tauri/src/server.rs`), so the server-side trigger
  never fires for it. It would need its own selection or stay as it is;
  a desktop install on a network home is the rarer case.

## Measuring instead of classifying

A probe that times a few hundred `BEGIN IMMEDIATE` / `COMMIT` pairs on a
scratch database in the candidate directory costs milliseconds on local
disk. As a ranking among local candidates it is low priority: they differ
by little that matters here. Its larger value is as evidence where the
table is blind, namely macOS and Windows shares, a FUSE mount that is
really remote, and network filesystems the table does not name. Required
SQLite currently allows refusal on positive evidence only; a measured slow
lock is positive evidence, so the probe could extend the refusal without
breaking that rule. The threshold needs data from real shares before it
gates anything.

## Not decided

- Whether an unattended first start on a network home refuses outright or
  starts as today with the banner.
- Whether accepting the offer is remembered per home or asked per host.
- The measured-latency threshold, and whether it may refuse or only warn.

Sketched 2026-11-13 from a maintainer proposal; nothing here is
implemented.
