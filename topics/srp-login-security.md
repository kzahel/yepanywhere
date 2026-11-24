# SRP and Login Security

This topic records the Remote Access SRP/login boundary, review evidence and
known hardening opportunities. It complements [Security](security.md),
[Limited users](limited-users.md),
[Principals and grants](principals-and-grants.md) and
[Trusted client packaging](trusted-client-packaging.md).

Status: the 2026-11-24 review found no critical SRP authentication break and
no exposure to the predictable-randomness attack described below. The
improvement register is durable security debt, not a claim that each item is
exploitable or a roadmap commitment. Roadmap priority remains with the
[project roadmap](../docs/roadmap/README.md).

## Current Boundary

The Remote Access password is a full operator credential. Limited users have
separate named principals and verifiers, but use the same wire protocol. Full
login has these stages:

1. The client sends an identity and receives that identity's salt and fresh
   SRP server public value.
2. Client and server prove possession of the password-derived secret through
   `M1` and `M2`. The client must verify `M2` before accepting the server.
3. The server creates an expiring resume session and sends a fresh transport
   nonce plus key-authenticated server information.
4. Both sides derive a per-connection key. Application frames then use NaCl
   secretbox authentication/encryption and sequence checks.
5. Resume requires possession of the saved base key, fresh client and server
   nonces, and an authenticated protocol version. It does not merely present a
   session id.

The TypeScript implementation uses the pinned `tssrp6a` compatibility profile
with its 2048-bit group and SHA-512. The shared mobile Rust core reproduces
that profile with pinned RustCrypto `srp`; it is a compatible client
implementation, not a new authentication protocol. A wire-profile change must
account for hosted-client/server version skew, native clients, saved verifiers
and resume sessions.

Security values do not use application `Math.random()`:

- `tssrp6a` obtains salts and private ephemeral values from Web Crypto
  `getRandomValues()` (or Node's cryptographic fallback);
- server transport and resume nonces use Node `randomBytes()`;
- resume session ids use Node `randomUUID()`;
- NaCl frame nonces use TweetNaCl's cryptographic random source; and
- the mobile core uses the operating system's `getrandom` source.

Non-security uses of `Math.random()` remain acceptable for retry jitter,
animation, temporary filenames and local display/request identifiers. A value
must move to a cryptographic source before it becomes a credential, signing
key, capability, proof challenge or security-sensitive correlation id.

## Predictable-Randomness Incident Comparison

The November 2026 [GreyNoise report][greynoise] describes exploitation of
Rejetto HFS, not a break of SRP itself. Repeated login requests disclosed
session identifiers produced by V8 `Math.random()`. The same predictable PRNG
also produced the session-cookie signing key, so an attacker could recover
PRNG state and forge an administrator cookie. The [HFS repair][hfs-fix]
separates these values and uses `randomUUID()` and `randomBytes()`.

Yep Anywhere does not expose outputs from a PRNG shared with authentication,
resume or frame-encryption secrets. Its SRP salt/private values, session ids,
transport/resume challenges and NaCl nonces come from cryptographic sources.
The HFS attack mechanism therefore does not apply.

This conclusion is deliberately narrow. It does not make the whole SRP
adapter constant-time, protect availability, strengthen a weak password or
remove the need to validate hostile handshake input.

## Existing Defenses

- Clients verify the full-handshake `M2` proof. Authenticated server information
  establishes a resume-protocol floor, and a client rejects a later downgrade
  below the highest floor it has accepted; a legacy grace path remains for
  clients that have not established that floor.
- Protocol-3 resume binds the session id, fresh client nonce, fresh server
  nonce and authenticated protocol version under the saved base key.
- Each connection gets a new transport key; encrypted frames have sequence
  checks, and plaintext application frames are refused after authentication.
- Unknown limited-user identities use stable per-identity decoy salts and
  verifiers, the same challenge computation, a generic proof failure and a
  response-time floor.
- Full login has per-connection and per-identity token buckets, failed-proof
  cooldowns and a handshake deadline.
- The server validates `A mod N != 0`, clients validate `B mod N != 0`, and
  mobile integer inputs are already bounded and syntax checked.
- Resume challenges are one-use and time bounded. Password/verifier changes
  invalidate affected resume credentials.

These controls cover password disclosure, passive relay observation,
unauthenticated application traffic, simple replay, username enumeration and
routine online guessing better than an unprotected password exchange. They do
not make the relay availability-trusted or protect a compromised endpoint or
client application.

## Improvement Register

### Bound and parse every pre-authentication message

**Value: high; compatibility cost: low.**

The shared TypeScript SRP guards currently recognize only the message `type`.
The ordinary WebSocket ceiling is 100 MiB because authenticated application
features need large frames. Before authentication, an attacker can therefore
send oversized identities, hex integers or proof envelopes that reach JSON
decoding, `BigInt()` and modular arithmetic.

Add strict schemas before any SRP or resume state change:

- apply the real username grammar and a small metadata limit;
- require hexadecimal `A`, `B`, `M1` and `M2`, bounded to the group/hash sizes;
- require UUID session ids and exact decoded nonce lengths;
- cap encrypted proof envelopes to a few KiB and reject unknown fields; and
- close generically on malformed input without logging attacker-sized values.

Enforce a small application-level pre-authentication frame ceiling while
retaining the larger post-authentication transport ceiling. Exercise this at
the actual WebSocket boundary with malformed JSON, wrong field types,
oversized integers and `A mod N == 0`. The peer SRP protocol's 8 KiB handshake
limit and strict schemas are the existing model.

### Add one global SRP computation budget

**Value: high; compatibility cost: low.**

Per-connection and per-identity limits do not bound an attacker who opens new
connections and continually chooses new identities. Unknown-user privacy also
intentionally performs a real challenge computation for decoys. A connection
flood can therefore monopolize the Node event loop with 2048-bit operations.

Add server-wide admission and a small bounded crypto-work queue across full
hello, proof and resume. Preserve the same externally visible failure and
response floor for known and unknown identities. Bound queued work and reject
excess admission rather than building an unbounded promise backlog. Reuse the
peer channel's global admission/crypto-budget shape where practical.

Input bounds come first: a semaphore limits concurrency but cannot make one
attacker-sized `BigInt` cheap.

### Authenticate the selected identity to the client

**Value: medium; compatibility cost: medium.**

The pinned compatibility profile computes the password hash without the
identity and computes `M1` from `A`, `B` and the shared secret. The current
key-authenticated server-info proof contains the session id, transport nonce
and resume protocol version, but not the selected username. A local
compatibility probe confirmed that a client starting with one identity and a
server selecting another can complete mutual `M1`/`M2` verification when the
two records use the same password.

This is not a password bypass: the supplied password must still be correct for
the server-selected record. It is an account-confusion condition for an active
transport adversary when accounts reuse a password. It also falls short of the
strongest reading of the current principal-binding contract. [RFC 5054][rfc5054]'s
verifier construction includes the identity and its TLS transcript prevents
replacement of the authenticated identity.

Repair the current wire profile without immediately replacing stored
verifiers by adding the selected identity to a versioned, key-authenticated
server-info proof. New clients must compare it with the identity they
requested before accepting the connection or saving resume state. Native and
web clients need the same check. Retire the compatibility grace only through
the normal server-capability and hosted-version process.

A later verifier migration may include the identity directly in password
derivation, but that requires password-dependent re-enrollment and a distinct
protocol version; it is not a safe in-place dependency swap.

### Improve arithmetic and timing assurance

**Value: assurance; compatibility cost: medium to high.**

The username-enumeration response floor is not a claim that the full protocol
is constant-time. The TypeScript dependency performs modular exponentiation
with JavaScript BigInt square-and-multiply and secret-dependent branches, and
compares proof BigInts normally. The server uses a fresh random exponent per
handshake, closes failed proof attempts and rate limits attempts, so the
2026-11-24 review did not establish a practical remote password-recovery
attack. It also did not establish a formal side-channel bound.

Before claiming whole-protocol constant-time behavior, use an implementation
with an explicit side-channel contract and commission focused cryptographic
review of the adapter and transcript. Prefer maintained native or carefully
reviewed WASM primitives over new handwritten arithmetic. Preserve differential
vectors and live old/new client compatibility tests through any migration.

The Rust mobile implementation similarly has no whole-adapter constant-time
claim. Its constant-time proof comparison, bounded integer parsing and recent
`crypto-bigint` repairs are useful controls, not a substitute for that review.

### Raise password and verifier-theft resilience

**Value: defense in depth; compatibility cost: low for new credentials.**

The server stores a salted verifier rather than the password, but theft of the
verifier permits offline password guessing. The current eight-character
minimum is a weak proxy for entropy, especially because the Remote Access
credential grants full operator authority.

Improve new-password guidance toward long generated passwords or passphrases,
offer strength/known-compromise feedback without sending the password away,
and avoid silently invalidating existing credentials. Consider a
memory-hard, versioned password preprocessing/enrollment scheme only as a
protocol migration: both clients and the stored verifier format must agree.
Document that OPAQUE improves protocol properties but does not make weak
passwords or a fully compromised endpoint harmless.

### Apply uniform admission to resume

**Value: defense in depth; compatibility cost: low to medium.**

An unknown resume session receives an immediate generic invalid response,
while a known session receives a challenge. Session ids are random UUIDs and
the caller must also name the identity, so this is not a practical session-id
search oracle by itself. A leaked session id can nevertheless be checked for
liveness, and resume traffic currently lacks the full-login computation
budget.

Put resume under the global admission limit. If liveness confidentiality
becomes a product requirement, return a bounded decoy challenge and uniform
floor for unknown sessions, then reject at proof. Do not add that cost without
the requirement and measurements.

### Keep transport dependencies inside security maintenance

**Value: routine but urgent when advisories apply.**

SRP authenticates the Remote Access endpoint, but TLS still protects routing,
metadata and non-SRP requests. The 2026-11-24 Rust audit found the mobile TLS
path's `rustls-webpki` affected by [RUSTSEC-2026-0382][rustsec-webpki], with a
patched release available. Treat that update as dependency maintenance rather
than an SRP redesign. Re-run live direct and relay login tests after changes to
Rust TLS, SRP, bigint, randomness or certificate-verification dependencies.

At that review date, the audit also reported `zip` extraction advisories only
through the native library's build dependency and a `url::origin()` advisory
whose affected function the mobile core does not call. Record explicit
reachability judgments and revisit triggers under
[dependency maintenance](../docs/development/dependencies.md) instead of
suppressing new findings implicitly.

### Keep a protocol-replacement path explicit

**Value: long-term assurance; compatibility cost: high.**

OPAQUE or another reviewed augmented PAKE remains a possible future direction,
not an automatic response to every SRP implementation concern. A replacement
needs authenticated suite negotiation, downgrade protection, password-dependent
enrollment, native/web parity, credential recovery behavior, resume integration
and a retirement horizon for the old suite. `resumeProtocolVersion` alone does
not select the full-handshake algorithm.

## Suggested Sequencing

This order reduces exposed risk without prematurely committing to a protocol
migration:

1. Strict pre-authentication schemas and size ceilings.
2. One global full-login/resume computation budget.
3. A versioned authenticated selected-identity field with web/native checks.
4. Applicable mobile TLS dependency updates and ongoing audit triage.
5. A focused SRP adapter/side-channel review before selecting a replacement
   implementation or PAKE.
6. Password-policy and enrollment improvements coordinated with any verifier
   migration.

The first two items are local hardening and should retain the current wire
contract. Identity binding changes an authenticated contract and needs the
normal compatibility process. Arithmetic or PAKE replacement is separate
architecture work.

## Review Evidence, 2026-11-24

- Reviewed the GreyNoise incident report and upstream HFS repair against every
  production `Math.random()` use and every SRP/session/nonce random source.
- Traced full SRP, resume, server proof, per-connection key derivation, sequence
  checks, limited-user decoys, proof cooldowns and peer SRP admission.
- Reproduced the compatibility profile's cross-identity/same-password mutual
  proof behavior in a local dependency-level probe.
- Focused server security run: 71 passed, one skipped across SRP/NaCl,
  limited-user hello and secure-WebSocket suites. The existing
  [intermittent SRP configuration gap](../gaps/secure-websocket-srp-configuration-intermittently-missing.md)
  remains a fixture/configuration investigation, not cryptographic evidence.
- Production pnpm audit: three documented ignored moderate advisories and no
  new untriaged JavaScript production advisory.
- Rust audit: certificate-validation advisories in the mobile TLS path plus
  separately triaged build-only/unreached findings. Mobile Rust tests were not
  rerun because the review host had Rust 1.92 while the crate requires 1.97.

[greynoise]: https://www.greynoise.io/blog/check-point-security-management-servers-intrusion-campaign
[hfs-fix]: https://github.com/rejetto/hfs/commit/59472e5
[rfc5054]: https://www.rfc-editor.org/rfc/rfc5054.html
[rustsec-webpki]: https://rustsec.org/advisories/RUSTSEC-2026-0382.html
