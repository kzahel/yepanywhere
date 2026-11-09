# A 256 MB random-access vocabulary file can land on a network filesystem with nothing said

`VocabularyStore` keeps its "already seen" set in `speech-seen.bloom`, a
paged blocked-bloom file that `BloomFile` opens `r+` and rewrites dirty chunks
of in place (`packages/server/src/services/voice/blocked-bloom.ts:207`). It
defaults to 256 MB (`VocabularyStore.ts:76`) and is 256 MB on the maintainer's
host. Access is random by construction: a bloom lookup touches one block at a
hashed offset, and a write is a read-modify-write of that block.

That file takes no locks, so the startup refusal added for
`discovery.sqlite` ([required SQLite](../topics/required-sqlite.md) § Data
directory placement) never considers it. Being lock-free does not make it
cheap on a share; a quarter-gigabyte file written a block at a time over NFS is
its own kind of unusable.

Normally it is fine, because `reserveScratchSpace` puts it on local disk and
already rejects network filesystems for that purpose. The problem is the last
resort. When no candidate qualifies — no usable cache home, no writable
temporary directory, a container without either mount — the reservation falls
back to `join(dataDir, purpose)` (`packages/server/src/lib/scratchSpace.ts`),
which is exactly the network directory the SQLite check refuses to open a
database on. The bloom file and the vocabulary database both land there.

The diagnosis already exists and goes nowhere. `reserveScratchSpace` returns
`degraded: true` and a `reason` that names the filesystem, and `VocabularyStore`
puts that string in one log line (`VocabularyStore.ts:443`). No client sees it.
The banner added for the data directory keys on `sqlite.networkFilesystem`,
which describes a different directory and stays absent here.

## One banner, one signal, a varying reason

The maintainer has settled the shape: not a second status field and not a second
banner. There is one placement signal that carries a reason text, and the banner
behaves identically whichever condition raised it — startup finding the data
directory on a share with SQLite enabled, or vocabulary learning enabled with
its scratch reservation degraded onto that same directory. Only the reason
differs. A user with a network home directory would otherwise be told two things
at once and given two instructions for one action.

That matters because the banner is the entry point for offering to move the data
directory ([the migration gap](sketches/network-filesystem-banner-offers-no-migration.md)),
and a move must happen with no live handles into the directory, or the flow has
to close and reopen them. The two conditions do not arrive equal on that point:

- **The SQLite path arrives clean.** The refusal means no database was ever
  opened, so there is no handle to close.
- **The vocabulary path arrives with the worst handles open.** If learning is
  enabled and the reservation degraded, the 256 MB bloom file is open `r+` and
  the vocabulary database is open alongside it, both in the directory the user
  is about to be offered a move of.

**Update, `df8027084`:** both files now live in the data directory, so the
reservation and its last-resort fallback are gone and the placement question is
settled by the data directory's own placement. `reserveScratchSpace` itself has
since been deleted, and that file is now
`packages/server/src/services/voice/legacy-vocabulary-directories.ts`, whose
`legacySpeechVocabularyDirectories` names the directories earlier versions
could have chosen, so their files can be adopted. What remains open is the signal:
nothing still tells a client that speech vocabulary storage is affected, and the
banner keys only on the SQLite refusal. The sections below record the reasoning
that survived the move.

## Split the placement decision: the bloom file may share, the database may not

The two vocabulary files are placed together today because they share one
reservation, but they do not deserve the same verdict.

The bloom file may continue on a network filesystem. It is lock-free, it is the
learning feature's own working set, and refusing it would disable learning to
avoid a cost the user can accept.

The database may not, and the reason is stronger than the general lock argument.
It runs in write-ahead logging mode (`vocabulary-database.ts:70`), which SQLite
does not support over a network filesystem because the shared-memory file has to
be memory mapped. The pragma's returned mode is not checked, and SQLite's
behavior when it cannot enter that mode is to stay in the previous one — which
is the rollback journal, one file lock per transaction, exactly the mode that
produced the original outage. So a vocabulary database on a share does not fail
loudly; it quietly becomes the thing this whole line of work exists to prevent.
Verify that fallback before relying on this description.

## The consequence for the migration button

Accepting the bloom file on a share means that whenever learning is enabled, a
live handle sits in the data directory. So in that state the banner can warn but
cannot offer a working move, and
[the migration gap](sketches/network-filesystem-banner-offers-no-migration.md) only has a
usable button when nothing holds the directory open. Making the offer work while
learning is on requires a real close-and-reopen sequence around the copy, which
is separate machinery and should not be assumed.

Found 2026-09-10, raised by the maintainer while reviewing the data-directory
filesystem check: the lock-free half of speech vocabulary deserves the same
warning as the locked half.
