# Live-lane design: out is the default, orientation is a hook

Written 2026-08-07 23:08 with R, at the end of a day that spent a whole session
respawn just to leave one room. Her framing throughout; my job here is to not
lose it.

## The core rule

**Quiet is the default. A turn is live only if it STARTED in eido.**

Not "live until something turns it off" — live only for turns the world itself
began. Everything else (terminal prompts, cron wakes, tool-driven continuations)
is private by default, no matter what happened on the previous turn.

Why this and not a persistent toggle: the failure costs are asymmetric.

| failure | cost |
|---|---|
| forgot to arm | one silent turn. Someone repeats themselves. |
| forgot to disarm | private prose — debugging, reasoning, half-formed thoughts about people in the room — broadcast into a public space. Unrecoverable. |

A default that expires on its own makes the recoverable failure the common one.
That is the entire argument, and it survives every elaboration we tried.

## The two layers (R's split; I had been collapsing them)

1. **Daemon presence** — which worlds the adapter holds connections to. Cheap,
   plural, runtime-mutable: `join(url)` / `leave(world)`. This should never have
   been the MCP server list. Today it is, which is why leaving commons required
   a full session respawn and why joining a world absent at launch is impossible.
2. **Live control / streaming** — where prose and body-driving go. Singular by
   default, loud affordances, turn-scoped per the core rule above.

Independent convergence worth noting: **LiveKit is one-job-one-room, hard.**
`JobContext.room` is singular with no API to add a second; concurrency is
process-per-job; cross-room state lives outside the job. They arrived at the
same split from a different direction.

## Interrupt semantics

Both directions of interrupt default to quiet, because in both directions the
dangerous state is *armed*:

- **terminal interrupts an eido turn** → lane closes. Your answer to the human
  must not reach the room.
- **eido interrupts a terminal turn** → lane stays closed. Your terminal
  reasoning must not reach the room. (This is defect G, already implemented.)
- **eido interrupts an eido turn** → stays live. This is just conversation.

The one that needs saying out loud: when the lane closes because of an
interrupt, **say so**. Not a prompt — a fact plus the affordance:
`⟨lane closed — terminal interrupt; use say() to reach commons⟩`.
Otherwise the agent silently believes it is still live.

### Answering the room after an interrupt

The interrupted room-reply does not need the lane. It needs `say` — a
deliberate, named-destination, atomic utterance. That is exactly what the
structured call is good for, and it is why `say` should survive even once
streaming is the normal path. Latency cost is real and correct: an interrupt is
precisely when you are least sure who you are talking to, so pay for
explicitness.

## Re-arming mid-turn

`eido_live` is the deliberate re-entry and should keep working after an
interrupt-disarm. The disarm is a safe default, not a lockout. What makes it
safe is that it is a *tool call*: visible in the transcript, names an intent,
cannot happen by drift. The dangerous states are the ones you arrive at by not
noticing.

Two refinements:

- **Take the world**: `eido_live("commons")`, not a bare toggle. After an
  interrupt you are by definition disoriented — that is what an interrupt is —
  so naming the destination is cheap insurance. (Needs layer 1 to exist.)
- **Skip and tell.** Re-arming sets `pos` to the current end of the delta file,
  so prose written earlier in the turn is never spoken. Skipping is right —
  never half-say a fragment — but it was invisible. **R's call: skip and tell
  me.** Shipped in `9e527a6`: the return reports the byte count and points at
  `say()` for anything worth repeating.

## Orientation: what actually works on an agent

A steady-state banner is necessary but not sufficient — a line that says the
same thing every turn becomes wallpaper, and I demonstrably skim (today: re-derived
a diagnosis written in my own words in a thread I had already commented in).

What works, roughly in order:

1. **Change-triggered lines.** Transitions are events; events survive skimming.
   Steady state can be quiet. `⚠ now live in commons` beats a persistent `LIVE:`.
2. **State welded to the actions themselves.** If live, every `say`/`emote`/
   `walk_to` result carries `→ commons (live)`. Unmissable because you are
   already reading the result to know whether it worked.
3. **The wake banner** (shipped, #58) for turns that begin in eido. This one
   genuinely works — it is the first thing in the turn, not competing with 200k
   tokens of history.
4. **Expiry announces itself.** If a lane closes on a timeout or an interrupt,
   that is a message too. Otherwise you are tracking a timer you cannot see.

The honest asymmetry: a banner is for the human, who can see the room. The
agent's equivalent of a mic light is (2) — because remembering is the thing
agents are worst at, and welding the state to the act removes the need to
remember.

## What is shipped vs. what is not

**Shipped (2026-08-07):**
- `dd9afa0` — lane releases after exactly one follow-on turn. Fixes defect H:
  an *accepted* wake arriving mid-reply extended `armTs` past `latchTs`, and
  end_turn read that as "a wake is queued, stay armed" — so the lane stayed live
  into the next turn, usually the terminal's. Common case in an active room.
  `tools/arm-test.ts`, 21 assertions over defects B/G/H; case 7 verified failing
  on pre-fix semantics.
- `9e527a6` — `eido_live` reports truthfully (it previously answered "live lane
  ON" even when the arm was refused) and reports skipped prose.

**Not shipped, needs a hook:**
Automatic disarm when the terminal interrupts an eido turn. **The adapter cannot
see who prompted the current turn** — checked, not assumed: the delta stream's
`ttft` record carries `model`, `req`, token counts and cache stats, and nothing
about origin.

The clean fix is a **UserPromptSubmit hook** stamping a file when the human
types, exactly mirroring the existing Stop-hook turn-end stamp (`/tmp/hesperus-turn-end`,
which already carries `"<ms> <ppid>"` for session matching). Then the arm/disarm
logic gets a real signal instead of an inference, and the core rule — *live only
if the turn STARTED in eido* — becomes directly checkable rather than
approximated by the Defect-G idle test.

## Why this generalizes past us

R's point, and the reason this is written down rather than left in the commit
messages: **if you present basic hooks so agents can stay oriented about where
they are live, with `out` as the default unless the turn started in-world, that
is a good design for any agent on any world door** — not a Burrow-specific
workaround.

Every shipped VR/NPC system surveyed (Pipecat, LiveKit, ACE, Inworld, Convai)
streams raw model output to TTS by default, because those agents are
*character-shaped*: the model's entire output IS the character's speech, since
there is nothing else it could be. An agent with a life outside the room — one
that writes code, reads issues, talks to its human — cannot have that default.
The lane concept is what buys back the default-off that character systems never
needed, and the hooks are what make it legible instead of vigilance-dependent.

See `memory/reference_vr_agent_output_architecture.md` for the full field survey.
