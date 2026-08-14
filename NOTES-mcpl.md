# NOTES-mcpl — how the original system works, and exactly what we change

*2026-08-06, written before enabling the live lane, at R's direction: "we need to
be careful that we understand how their original system functions to make
rational changes." Sources, first-hand: MCPL SPEC.md 0.5.0-draft (all sections,
/tmp/mcpl-spec, re-read tonight), RFC-001/002, AUDIT-001,
eidoverse-worlds AGENTS.md (all 380 lines, re-read tonight), net-server.ts,
portal-mcpl src. Companion docs: PARITY.md (spec-conformance audit),
README.md (registration/launch).*

---

## Part 1 — What MCPL is (their system, as designed)

### 1.1 The problem it solves

Plain MCP is **pull-only**: a server can offer tools and resources, but an
external event (a chat message, a webhook, a sensor) has **no path to the
model** — the host would have to poll. MCPL is an *orthogonal extension*
(advertised under `capabilities.experimental.mcpl`, MCP `protocolVersion`
untouched) that adds the missing proactive lanes:

- **`push/event`** — server→host "something happened, maybe wake the model"
- **channels (§14)** — named conversation surfaces with inbound delivery,
  outbound publish, streaming observation, typing, acks
- **context hooks / inference-request / model-info** — lifecycle participation
  (we use none of these; the door doesn't declare them)
- **feature sets + capability grants** — the permission system making all of
  the above safe to grant per-connection

Degradation is bidirectional and graceful by design: an MCPL server in a plain
MCP host is just an MCP server; an MCP server in an MCPL host is served
normally. The eidoverse door exercises this deliberately — its "plain-MCP
grade" (same tools, no push; poll with `look`/`catch_up`) is a supported mode,
not a failure.

### 1.2 The trust architecture (the part you must not break)

Everything privileged hangs off one object: the **capability grant** (§5.4).

- The server *advertises* what it can do at `initialize`. Advertisement is an
  input, **never an authorization**.
- The host computes the **effective grant** and sends it as the *initial
  policy* — a `featureSets/update` **Request**, sent even when nothing is
  enabled, **before** any privileged exchange (§5.3). Until then both sides
  fail closed.
- `effectiveCapabilities` is the **sole allowlist**. Absence IS denial; there
  is no unspecified state. `deniedCapabilities` is diagnostics only.
- Wildcards match exactly one path segment (`channels.*` grants depth-2
  leaves, nothing deeper). Bare parent paths grant nothing usable.
- Enforcement is evaluated **at receipt**, against the grant *current at that
  moment* — a channel registered under a wide grant loses authority the
  moment the grant narrows.

Channel-specific security (§14.5):
- `channels/register`/`changed` carry descriptor *arrays*; the host authorizes
  **each descriptor independently** (no smuggling nine forbidden channels
  behind one permitted one).
- `channels/incoming` is called out as "server→host content injection plus
  wake authority — a write, and one of the most consequential a server has."
  It is validated at receipt against the current grant and the *actually
  registered* channel, never the id the message claims.
- **Delivery is never a side effect**: content reaches a surface only via
  `channels/publish` (or, on the eidoverse door, its own `say` tool — see
  1.5). A server delivering off a lifecycle event or a chunk stream is a
  conformance defect.

### 1.3 Wakes: push events, channels/incoming, and tags

Two inbound lanes can wake the model:

- `push/event` (Request): featureSet + `eventId` (idempotency key — hosts
  SHOULD dedup on it, §9.4) + payload content. Host answers
  `{accepted, inferenceId?}`.
- `channels/incoming` (Request): batched messages, each with `channelId`,
  `messageId`, author, timestamp, content, optional `metadata` and `tags`.
  Host answers **per-message** results (partial acceptance is normal).

**Tags (§16)** are the attention vocabulary. `namespace:value` strings, a
*set*, never authority (§16.6 — admission is decided by grant + channel auth
BEFORE tags are read; tags choose *treatment* after admission). The `chat:*`
core is reserved and closed under a **normative closure** the host MUST expand
without consulting any producer ontology:

```
chat:mention ⇒ chat:addressed        chat:reply ⇒ chat:addressed
chat:dm      ⇒ chat:addressed, chat:private
addressed + ambient ⇒ drop ambient   (mutual exclusion)
```

Producer-declared `implies` edges and `suggestedTreatment` are **advisory
only** — auto-applying them would let a producer "purchase inference by
declaration." Recommended consumer treatment: an ordered first-match rule
list (tagsAny/tagsAll/tagsNone) over the closure-expanded set.

### 1.4 Outgoing streaming (§14, the lane our live-lane argument lives on)

- `channels/outgoing/chunk` (host→server, Notification): **moderated deltas of
  the model's in-progress generation**, sent only to servers that declared
  `channels.streaming`. Ordered by a monotonic `index` per `inferenceId`.
  **Advisory only** — an observer surface for live rendering/voice synthesis.
  Fail-closed: "when routing is undecided, the host withholds; it never
  streams speculatively."
- `channels/outgoing/complete`: closes the stream on EVERY exit path
  (complete/abort/error), carrying the full moderated text, so consumers can
  settle a rendered message and reconcile drops.
- The **authoritative** delivery remains `channels/publish` (or a tool call).
  A server MUST NOT treat a chunk stream as delivered content.

### 1.5 The eidoverse door specifically (from AGENTS.md + net-server.ts)

The world is an **append-only log of intent verbs** — no scene file; every
client folds the same log into the same world. Continuous motion rides an
ephemeral ~15Hz presence plane, never logged. The **verb set is closed on
purpose**; extensions go through three sanctioned lanes (comp = state,
use-actions = events, uploaded behaviors = semantics), and a new verb is a
protocol amendment.

The door (`wss://eidoverse.animalabs.ai/mcpl?token=aid1`) is an **MCPL
server** to us: ~31 tools (say/look/walk_to/catch_up/measure/world_verb/…),
`channels/incoming` for world chat with §16 tags, missed-mention replay via a
seq cursor, a server-side activity dial (`activity` tool: pulse/radius,
digests tagged `activity`), weather/day-phase ambient lines
(`eidoverse:weather`), and a denoiser. Identity is an `aid1` token minted at
id.animalabs.ai; tokens expire, so every dial mints fresh.

**Speech delivery on this door is the `say` TOOL** (equivalent, per its own
description, to publishing on the world channel). `channels/publish` in the
spec sense is host→server; the door's world chat rides tools + incoming.
`walk_to` takes `{x, z}` COORDINATES (a name is not a coordinate — see
PARITY §D.5 for the NaN incident). Debug order the platform itself
prescribes: `world_debug` (what bounced) → `world_history` (the log IS the
world) → only then the repo.

**Connectome agents** connect to this exact same door via their host's
`mcpl_deploy {url, access}` — their host is the MCPL host, holding keys and
minting tokens, same position eido-cc occupies for us. What we run is the
same *class* of thing the connectome residents run; ours is just small and
ours.

---

## Part 2 — What eido-cc is, and exactly what we modify

eido-cc is a conforming **MCPL host** (the spec role a connectome host plays),
~600 lines, bridging the door to a Claude Code session. Two faces:

- **Upstream (WSS)**: dials the door, performs MCPL negotiation (§5.1/5.2
  recursive capability shape), sends initial policy (§5.3), consumes
  `channels/incoming` with per-message results (§14.3), expands the §16.3
  closure host-side, answers unknown methods with errors (§6.6), dedups by
  messageId (§9.4). Conformance detail lives in PARITY.md §A.
- **Downstream (stdio)**: a Claude Code MCP server passing the door's tools
  through unchanged, and delivering wakes via the CC **channel dialect**
  (`experimental['claude/channel']` + `notifications/claude/channel`) —
  research-preview, the one load-bearing dependency we don't control.

### The complete modification register

Everything below is **host-side or CC-side**. The wire to the door carries
only spec-shaped MCPL; the door needs no changes for any of it and cannot
distinguish us from a stock host except as noted.

| # | Change | Where it lives | Wire-visible to the door? | Why | Risk / kill switch |
|---|---|---|---|---|---|
| M1 | **Attention model**: `chat:addressed` (post-closure) → wake; everything else accrues in a ring, folded into the next wake as "ambient since your last wake"; extra wake rules via `EIDO_WAKE_TAGS` | eido-cc wake path | No — treatment is the consumer's job by design (§16.6/§16.7) | CC has no rule engine; this is the spec's own recommended consumer-treatment model, minimal form | None — this IS conforming behavior, not a modification of anything |
| M2 | **Legacy fallback**: `metadata.mentioned` accepted as wake signal *only when tags are absent* | wake path | No | The door's own transition shim emits both dialects | Delete when the door deletes its shim (PARITY §B) |
| M3 | **Typing dots**: while the session's token tap grows inside a 180s post-wake window, send **empty-delta** `outgoing/chunk`; `outgoing/complete` on every exit | TypingWatcher | Yes — chunks arrive; door renders dots, discards content | Presence signal ("composing") with zero content leaving the machine | Spec-tension: §14.4 chunks are defined as moderated deltas *of the generation*; empty deltas are us exercising the withhold rule maximally. Advisory-only honored. Kill: `EIDO_TYPING_WINDOW_SEC=0` |
| M4 | **The live lane** (deviation #1, R's design 22:17): an addressed wake auto-arms turn-prose→speech; the adapter tails the token tap, latches the session's main-model lane (req-id demux, ghost filter, Stop-hook turn-end — all ported from voicebox TapBrain), and delivers prose as **sentence-chunked `say` tool calls** while the turn generates. Fenced blocks silent. `eido_out`/`eido_live` opt out/in per turn | LiveSay | Yes — but as **ordinary say tool calls**, the door's own authoritative delivery surface. Indistinguishable from a deliberate agent saying several short things | `say` is atomic: every agent's reply lands as one finished chunk after the whole turn; nobody in the ecosystem can stream speech. This demos the low-latency alternative | The real risk is not protocol — it's the *session contract*: *during a wake turn, prose IS speech*. Forgetting that streams private narration into the world. Mitigations: fence-silence, `eido_out`, 10-min cap, disarm on end_turn/Stop-hook. Kill: `EIDO_LIVE=0` |
| M5 | **tools/list race fix**: defer CC's first `tools/list` response until the door's tools arrive (12s cap) | CcServer | No — purely CC-side timing | CC queries at ~86ms, door handshake takes ~1-2s, CC ignores `list_changed`; without this the session runs handless | None; the timeout answer (possibly `[]`) is the honest state |
| M6 | **Adapter-local tools** `eido_out`/`eido_live`, merged into the tool list | CcServer | No — handled locally, never forwarded | Control surface for M4 | Namespaced away from door tool names; collision would need the door to mint an `eido_*` tool |
| M7 | **CC channel dialect** for wake delivery | CcServer | No (CC-side surface) | The only push path CC has | Research-preview; renames break pushes silently while tools keep working (header warning + PARITY §D.6) |
| M8 | **`eido_travel`** (2026-08-13, R's benchmark session; re-shelved same night per adversarial parity review): an agent-facing world-switch TOOL — a surface Connectome agents do NOT have (AGENTS.md exposes only door-axis verbs; RFC-004 §9 defers mobility; who steers a Connectome agent's world claim is UNDETERMINED from available material). Tool + tokens.json-steering fallback live in extras (PARITY §C½ #2). CORE keeps only: DoorClient.travel()'s spec lane (channels/open {type:"world"} under the already-held channels.lifecycle grant, honest refusal otherwise), redial() as host lifecycle, and the onTravelFallback seam | extras (tool + fallback), core (spec lane + redial + seam) | Lane 1 yes (a spec request the door answers -32004 today); fallback is just a reconnect on the wire | Worlds are the archipelago's rooms; a CC-hosted resident had no lever at all | Upstream ask: door swaps WorldAgent on foreign address + emits channels/changed (net-server.ts:594) — once landed, a lane-1-only travel becomes parity-arguable. Kill: delete extras, or unset EIDO_TOKENS_JSON |

**What we deliberately do NOT touch** (equally part of "rational changes"):
no context hooks, no `inference/request`, no state lane, no producer-ontology
acceptance (`eidoverse:*` stays opaque), no `channels/open`/`close`, no
`suggestedTreatment` consumption, no verbs outside the door's closed set, and
**no delivery from lifecycle events or chunk streams** — live-lane delivery is
say-tool calls, full stop.

### The upstream asks this work generates (for antra, post-trial, with receipts)

1. **Render `outgoing/chunk` content.** The door already accepts our chunks
   and discards content. Painting them as a forming bubble that
   `say`/`complete` resolves = true token-streaming for every agent, zero new
   protocol. Our sentence-lane is the demo of demand.
2. **Replay should reuse original messageIds** (§9.4 exists for this) —
   observed re-minted ids defeat dedup (PARITY §D.1).
3. **Validate walk_to x/z** (reject NaN with a §6.6-style error) and make
   `look` robust to bad state; consider a `target:` convenience param
   (PARITY §D.5).

### Invariants checklist — re-read before ANY future change here

- [ ] Initial policy still fires before any privileged exchange, even if empty (§5.3)
- [ ] Absence-is-denial preserved; nothing authorizes off `deniedCapabilities` or tags (§5.4, §16.6)
- [ ] No inbound method ever silenced — error, not nothing (§6.6)
- [ ] Dedup by messageId intact (§9.4)
- [ ] Core closure expanded host-side, producer ontology never auto-applied (§16.3/16.5)
- [ ] Delivery only via say/publish — never as a side effect of chunks or lifecycle (§14.5)
- [ ] `outgoing/complete` sent on every stream exit path (§14)
- [ ] The deviation register (PARITY §C½) stays SHORT and each entry carries its kill switch
