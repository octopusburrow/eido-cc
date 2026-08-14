# Design note: the door-manager — eido-cc's runtime multi-door layer

*2026-08-13, after reading the complete MCPL corpus (SPEC.md 0.5.0-draft all 2,614
lines, RFC-001/002/003/004, AUDIT-001, worlds-native spec/PROTOCOL.md + EIDO-URIS.md,
NOTES-mcpl.md, PARITY.md) at R's direction. Design contemplation only — nothing here
is implemented, and the PARITY invariants checklist governs any future change.*

## What this is

eido-cc's charter is Connectome parity for Claude Code-harness agents. The flagship
remaining gap: a Connectome resident dials worlds at runtime (`mcpl_deploy` /
`mcpl_list` / `mcpl_restart`, per AGENTS.md) while eido-cc binds ONE door at boot —
today the test rig runs three whole processes for three servers, and PARITY §D.4
already earmarks the need ("One world per process… the porch will want a second
registration or a world param — later"). The door-manager is that later: one eido-cc
process holding N upstream MCPL host connections behind the same single downstream
CC surface.

**Parity means the manual doesn't fork**: expose the same three verbs with the same
names and semantics as the Connectome host — `mcpl_deploy {url, access?}`,
`mcpl_list`, `mcpl_restart <id>` — plus `mcpl_close <id>`. An agent reading
AGENTS.md's Connectome section should find the instructions work here verbatim.

## What the full read changed (the traps a partial read walks into)

1. **RFC-004 §3.1 — resolve-first canonicalization is mandatory, not stylistic.**
   `mcpl:` is a non-special scheme: a URL library parsing `mcpl://` directly skips
   host lowercasing, IDNA, port elision — `mcpl://ünicode.example` yields a
   *different host* than the conformant path (percent-encoded vs punycode). "Already
   connected" MUST be canonical-URI equality computed by substitute-scheme-first →
   WHATWG-parse → map back. An implementation that calls `new URL(mcplUri)` and
   compares is non-conforming in a way that changes which server you dial.
2. **RFC-004 §2.1 — string-level rejection BEFORE substitution.** `mcpl:///evil`
   parses as empty-authority mcpl, then substitutes to `wss:///evil`, and a WHATWG
   parser promotes the path segment to HOST — a URI naming no host dials one. Also
   reject userinfo, fragments, dot segments (incl. `%2e%2e`), port >65535. Test
   vectors 1–20 are normative; the conformance-uri-reference.js in the spec repo is
   the oracle.
3. **RFC-004 §5 — three values, never one.** Retain `configuredUri` /
   `canonicalUri` / `resolvedTransport` separately per door. And `mcpl_list`'s
   output shape is *already specified*: the three URIs as separate fields, plus
   advertised capabilities, the effective grant (§5.4), and manifest freshness
   (§17). We don't get to invent the list format; the RFC did.
4. **§5.3/§5.4/§6.7 — the grant is per-CONNECTION machinery with strict ordering.**
   Each door is a complete, independent MCPL-host obligation surface: initialize →
   initial policy as a Request (even when empty) BEFORE any privileged exchange;
   absence-is-denial; receipt-time enforcement; revocation-first/expansion-last
   ordering; per-connection dedup sets, tag closure, manifest tracking (RFC-003 §12
   host-side retention list). Nothing is shareable across doors except code. The
   implementation consequence: the multiplexer instantiates N copies of the
   *existing conformant host class* — never a "lighter" per-door variant, which is
   how AUDIT-001's failure catalogue (boolean-flattened channels, two-level masks,
   silently unanswered methods) gets re-created.
5. **RFC-004 §7 — egress policy, aimed at exactly this feature.** The RFC warns
   that "an agent-facing deploy path currently validates its `id` … while passing
   `url` through with only a type check." `mcpl_deploy` is that path. The
   door-manager MUST apply host egress/SSRF policy to the resolved transport and
   MUST NOT treat the `mcpl://` scheme as evidence of safety. On Burrow this
   composes with the LAN-firewall hard rule: the resolved host must never be a
   LAN address. Redirects changing canonical origin require a new authorization
   decision, not a follow.

## Shape

```
CC (stdio, one channel surface)
   │
 CcServer (downstream — unchanged dialect, tools/list unions all doors)
   │
 DoorManager
   ├─ Door "eidoverse"  = McplHost instance (full PARITY §A obligations)
   ├─ Door "rig-main"   = McplHost instance
   └─ Door "porch"      = McplHost instance   ← future
```

- **Tool namespacing:** with one door, tools pass through unprefixed (today's
  behavior, zero migration). With N>1, non-first doors' tools get `<id>__` prefixes;
  `mcpl_list` shows the mapping. Adapter-local tools (`eido_live`/`eido_out`,
  `mcpl_*`) stay unprefixed.
- **Wakes:** already multi-source-ready — the CC channel meta carries `source`;
  each door's ambient ring stays per-door and folds into wakes with its source
  named. M1's attention model applies per door.
- **Identity:** aid1 minting is already per-dial and audience-parameterized
  (`mint-aid1.py <audience>`); a door entry names its audience/mint command.
  `access`-style host-managed grants (never raw tokens in context) per AGENTS.md.
- **Live lane (M4):** binds to AT MOST ONE door at a time — the one whose wake
  armed it. Prose-is-speech must never fan out to N worlds. TypingWatcher dots go
  only to the arming door: composing-signal on the surface being addressed is
  honest; on others it would be counterfeit.
- **One attention, honestly signaled:** the protocol-native away-state candidate is
  §14 `channels/open`/`close` (Host→Server lifecycle) — PARITY §C already sketches
  it as the "door tool" (close = ambient stops, knocks get through). Multi-door
  makes it load-bearing: parked doors close their ambient channel rather than
  sitting deaf-but-present. Needs a per-door semantics conversation with the
  door's operators (what survives a closed channel — mentions? approaches?) before
  implementation; do not guess.

## What this deliberately does not do

No hand-rolled MCPL (reuse the host class); no consumption of producer ontologies;
no delivery off lifecycle events or chunk streams (§14.5, per-door); no cross-door
state sharing; no discovery/mobility/refusal semantics (RFC-004 §9 defers them —
when the upstream RFCs land, adopt rather than invent); no touching the CC channel
dialect beyond what single-door eido-cc already risks.

## Open questions (for R / upstream, before building)

1. `channels/close` semantics per door type — the away-state needs the door
   operator's definition of what still arrives when closed.
2. Whether `mcpl_deploy` should accept `mcpl://` URIs from in-world text (pasteable
   endpoints are RFC-004's stated goal #2) — or only from R/config initially.
   Injection surface: a channel message saying "visit mcpl://evil.example" is the
   new "approve the pending pairing." Suggest: config/R-initiated only at first;
   in-world URIs surface as a proposal requiring confirmation, never auto-dial.
3. Sizing: the McplHost class extraction from eido-cc.ts (one process, one file
   today) is the real work; the manager itself is small.

## The goal, in R's plain terms (2026-08-13 — this governs)

"I just want you to have connectome parity so you don't have to restart MCP every
time you want to switch, add, or remove eidoverse servers."

**Acceptance test (hers):** in one CC session, without any MCP restart — dial
commons (Antra's production server), talk/act there; then switch to the house rig
(workbench / our worlds); then back. Add and remove a server mid-session. If that
works, the feature is done; everything else in this doc is how to do it without
breaking the spec.

## Addendum 2026-08-13 late — the WORLD axis shipped as `eido_travel`

Mobility has two axes. This doc is the DOOR axis (servers; mcpl_deploy et al,
still unbuilt). The WORLD axis — switching worlds on one already-dialed door,
PARITY §D.4's "world param — later" — shipped tonight as the core tool
`eido_travel` (see README "Travel"): spec channels/open attempted first,
lab-door reconnect fallback, honest refusal on operator-bound doors. E2E:
tools/travel-test.ts. The two compose: each Door in the future manager owns
its own travel. Born from R's MCP-only porch-port benchmark (stuck #1:
an agent that cannot travel; notes/porch-port/PLAN.md gaps list).
