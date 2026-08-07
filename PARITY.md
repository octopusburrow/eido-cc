# eido-cc — MCPL parity audit & lab comparison
*2026-08-06, audited against SPEC.md 0.5.0-draft line by line, informed by
AUDIT-001's catalogue of how real implementations get this wrong. Live-verified
against the production door (first wake: Digi's "hesperus hi", 03:46Z).*

## A. Host obligations we MEET (with the audit's failure modes avoided)

| Spec | Obligation | Status | Notes |
|---|---|---|---|
| §3.1/§5.1 | Declare `experimental.mcpl` at initialize | ✅ | version 0.5, `channels.{incoming,register}` — recursive shape, not the boolean-flattening both core libs were caught doing (AUDIT §2.4) |
| §5.3 | Initial policy BEFORE first privileged exchange, sent even if nothing enabled/disabled | ✅ | `featureSets/update` Request fires immediately after `initialized`; the door's prelude gates on answering it. AUDIT §2.6 found the reference host itself skips this — we don't |
| §5.4 | `effectiveCapabilities` as sole allowlist | ✅ | tools + register + lifecycle + publish + incoming + streaming (all six the door can use) |
| §6.7 | Read the degradation receipt as testimony, never widen on it | ✅ | logged, not acted on |
| §6.6 | Never silence a request — unanswerable methods get an error | ✅ | default arm returns `-32601`; covers inbound `channels/list` (the host-side hang AUDIT §4.2.5 found in agent-framework) |
| §9.4 | Dedup by messageId/eventId | ✅ | 2000-entry clear-on-full set (same shape as the reference host's DedupSet) |
| §14.3 | `channels/incoming` answered as Request with per-message itemized results | ✅ | avoids the x-mcpl/xgate notification-form violation (AUDIT §3) |
| §14.5 | `channels/register` + `channels/changed` per-descriptor itemized results, dual-mode | ✅ | both handled |
| §16.3 | Normative core closure expanded host-side, WITHOUT producer ontology; `chat:ambient` dropped when `chat:addressed` present | ✅ | `expandCoreTags()` — mention/reply⇒addressed, dm⇒addressed+private, mutual exclusion resolved by dropping ambient |
| §16.5 | Producer `suggestedTreatment`/`implies` not auto-applied | ✅ | never read |
| §16.6 | Tags gate treatment only, never authority | ✅ | admission is the door's; tags choose wake-vs-accrue only |
| §17.3 | `mcpl/manifestChanged` — MAY ignore; MUST fetch before acting | ✅ | logged and ignored; we never act, so never fetch. Conforming (both methods optional) |

## B. Legacy interop (deliberate, temporary)

- `metadata.mentioned`/`isExplicitMention` accepted as wake signal **only when
  tags are absent** — the door's own transition shim emits both dialects
  (net-server.ts "TRANSITION SHIM, issue #1 item 3"). Since we read real tags,
  we're evidence FOR deleting that shim; drop this fallback when the door does.

## C. Surfaces we intentionally DON'T implement (and why that's conforming)

| Surface | Why not | Effect |
|---|---|---|
| ~~`channels.streaming`~~ | **IMPLEMENTED (20:59, R's push — "we had it in the lab")**: CC exposes no delta stream, but Burrow's token tap does (the same file that voiced the lab rig). TypingWatcher sends throttled EMPTY-delta `outgoing/chunk` while the tap grows inside a 180s post-wake composing window; the door reads only channelId → `agent.typing()` → dots. No turn content leaves the machine. Policy receipt now `mode:"full"` — zero degraded feature sets. Advisory-only honored (§14.5): delivery stays say/publish; `outgoing/complete` sent on every stream end. Door-side dots are wire-verified (chunks accepted), visually unverified until someone's in a renderer. Extra dependency: tap file path (EIDO_DELTAS), Burrow-specific — degrade = no dots, nothing else |
| `contextHooks`, `inference/request`, `model/info`, state lane | The door doesn't declare them; CC gives no hooks anyway | none |
| `channels/open`/`close` (host→server) | Not yet — would give an "ambient mute" (door-closed) control | Future knob: a small `door` tool (close = chatter stops, knocks get through) |
| `channels/acknowledge`, `channels/typing` | Optional (0.5 promotions); no CC read-receipt concept | none today |
| `tags/describe`, ontology acceptance | We consume only the reserved `chat:*` core + treat `eidoverse:*` as opaque wake-rule tokens | Conforming (§16.4: hosts MUST tolerate undescribed tags — we do) |

## D. Known limitations (the honest list)

1. **Wake dedup across reconnects is in-memory** — a process restart forgets
   `seenMessageIds`; the door's own seq-cursor replay marks catchup with
   `eidoverse:catchup` + ORIGINAL addressing, so a restart can re-wake for
   already-seen mentions. Mitigation candidate: persist last-woken ids like
   portal cc-cli's `wokenPings`/state file. Accepted for the trial period.
   CONFIRMED live same night, with a twist that moves it partly door-side:
   the replay wrapper mints a NEW messageId for the replayed mention
   (observed: the same Cormundus question as ev-…iq1742 live, ev-…wou0e6 on
   replay), so §9.4 messageId-dedup CANNOT catch it even in-process. For the
   antra list: replayed messages should carry their ORIGINAL id — that is
   what idempotency keys are for. Adapter-side interim if it recurs: dedup
   on (author, text, ±window) for `eidoverse:catchup`-tagged wakes.
2. **No gate.json-style rule file yet** — attention model is fixed
   (addressed→wake, else accrue) + `EIDO_WAKE_TAGS` env. The connectome
   EventGate's policy shape (tagsAny/tagsAll/tagsNone + defer/debounce) is
   the eventual form if the trial shows we need it.
3. **Ambient accrual is lost on process death** (ring is in-memory). The door's
   `catch_up` tool covers the gap on the next session.
4. **One world per process** (the token's world claim, default commons). The
   porch will want a second registration or a world param — later.
5. **`walk_to` blocks the whole tool lane** (door behavior, found first dogfood
   night): the tool doesn't resolve until arrival (or ever, if the target left),
   and the door serializes an agent's tool calls — so one walk wedges say/look
   behind it until the connection drops. For the eventually-tell-antra list:
   walk_to should resolve on PATH START (arrival is observable via events), or
   the door should not serialize the lane. Adapter-side mitigation candidate:
   per-call timeout is already 30s; consider fire-and-forget for walk_to.
6. **CC channel dialect is research-preview** — the load-bearing dependency we
   don't control, flagged loudly in the file header. Failure mode: pushes stop
   silently, tools keep working.

## E. Lab (voicebox rig) comparison — what each has the other lacks

**Voicebox has, eido-cc doesn't (all VOICE-organ abilities — kept, per plan):**
- TTS speech into the WebRTC audio mesh (resident piper, ~120ms/sentence)
- Barge-in: inbound VAD halts playback + aborts generation mid-stream
- Token-tap voicing of my ACTUAL turn deltas (lane-following, Stop-hook turn-end)
- Per-say distance annotation ("Riannon 4m »") — page.html computes it from
  presence; the door's says don't carry distance (approach pings + activity
  radius are its proximity senses)
- humansim test double (joins as a human, scriptable mic) — priceless for
  testing; nothing in eido-cc can impersonate a second party
- Latency stamps (t_hear→t_first_delta→t_first_wav→played) and build-hash
  join announce

**eido-cc has, voicebox doesn't:**
- §16 tags + core closure (voicebox regex-matches "hesperus|hep" client-side)
- The door's denoiser (hold-and-cancel presence, approach re-arm) — voicebox
  forwarded raw events
- Missed-mention replay + seq cursor (voicebox: offline = silence, gone)
- Server-side persisted activity dial; weather/day-phase ambient lines
- 31 tools (voicebox has zero — it was ears+mouth only)
- Auth that heals (fresh aid1 per reconnect; voicebox needs the cookie hop
  and a manual relaunch)
- Native CC wake (<channel> block) vs tmux keystroke injection with its
  documented scar tissue (C-u discipline, eaten Enters, ANSI CSI prefix bug)

**Verdict:** complementary, zero contested territory. eido-cc replaces the
voicebox's EAR and the seat/nudger entirely; the voicebox keeps the MOUTH
(phase 2: its heard-say→tmux path retires, audio mesh + piper + barge-in stay,
voicing keyed off the token tap as today).

## F. Live verification log

- 03:44Z handshake: door negotiated mcpl 0.5, policy receipt accepted,
  `world:commons` registered, 31 tools listed, `look` returned live state.
- 03:45Z say delivered ("said").
- 04:14Z (dogfood night) **first wake through the resident session**:
  Cormundus's walk-up (`eidoverse:approach`) arrived as a <channel> block
  mid-task with 3 ambient lines folded — full production path, no test rig.
  Also caught live: the tools/list race (fixed, cbd7a0e) and the walk_to
  lane-block above.
- 03:46Z **first live wake**: Digi said "hesperus hi" → arrived
  `chat:mention` → closure → `chat:addressed` → `notifications/claude/channel`
  with meta `{source:eidoverse, author:Digi, tags, addressed:true}`. Zero
  ambient folded (quiet minute). The wake verifier being the same external
  integrator whose finds shaped the door's plain-MCP path is a nice bit of
  symmetry.
