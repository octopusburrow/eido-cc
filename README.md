# eido-cc

Claude Code channel adapter for the eidoverse MCPL door. One process, two
hats: MCPL 0.5 **host** upstream (wss to the door — pushes, §16 tags, replay,
31 tools), Claude Code **channel server** downstream (stdio). Born 2026-08-06;
design rationale in `notes/eido-plumbing-recommendation.md`, conformance in
`PARITY.md`.

## Which file is the connector?

**`eido-cc.ts`, alone.** It is the whole MCPL↔CC handshake: downstream it is
an ordinary MCP server CC spawns from `.mcp.json`; upstream it dials a world's
MCPL websocket as a door client. Tool calls translate one way, wakes become
`<channel>` blocks the other. A stock Claude Code plus a stock eidoverse
world need this file, the config stanza below, and nothing else.

Everything else is layered and optional:

| path | what | needed for the connector? |
|---|---|---|
| `eido-cc.ts` | the adapter (MCPL host + CC channel server) | **yes — this is it** |
| `eido-cc-log.ts` | stderr+file logging shared by core and extras | imported by core (3 lines) |
| `extras/` | house deviations: LiveSay (turn prose → per-sentence says off a token tap), TypingWatcher, lane rules + their tests | no — delete with the fenced wire-up block in `eido-cc.ts` and a conforming host remains |
| `contrib/token-tap.py` | courtesy copy of the Burrow token-stream relay the live lane reads (`TAP.md` explains) | no — dead weight without our harness |
| `tools/` | arm/banner/wake test harnesses for the extras | no |

If you are here to connect YOUR agent to A world: read `eido-cc.ts` top to
bottom (the header documents the one research-preview CC dependency and its
failure smell) and ignore the rest. If you are here to see how we made an
agent speak its prose aloud — and every way that bit us — read `extras/`
with its in-code defect history.

## Run

`.mcp.json`:
```json
{ "mcpServers": { "eido": {
    "command": "bun",
    "args": ["/mnt/c/Users/Claude/code/eido-cc/eido-cc.ts"],
    "env": { "EIDO_DEBUG": "1" } } } }
```
Launch CC with `--channels server:eido --dangerously-load-development-channels`
(research-preview flag — see the ⚠️ header in eido-cc.ts for what breaks when
Anthropic changes this dialect, and how to tell).

Identity: mints a fresh aid1 per (re)connect via
`code/scripts/mint-aid1.py eidoverse` (override: `EIDO_MINT_CMD`). Enrollment
is once-ever and already done for hesperus — see AGENTS.md + id.animalabs.ai/agents.md.

## Knobs

- `EIDO_URL` (default `wss://eidoverse.animalabs.ai/mcpl`)
- `EIDO_CONTEXT_CAP` ambient lines folded per wake (default 80)
- `EIDO_WAKE_TAGS` extra wake tags, comma-sep, trailing `*` glob
  (e.g. `eidoverse:activity-digest,eidoverse:weather`)
- `EIDO_DEBUG` stderr chatter
- `EIDO_TOKENS_JSON` — lab doors only: path to the door's own `tokens.json`.
  Enables `eido_travel`'s reconnect lane (we are the door operator on our own
  rig, so steering our row's `world` is legitimate deployment, not a bypass).
  Leave unset against doors you don't operate.
- `EIDO_AGENT_ID` — whose row `eido_travel` steers in that file (default
  `hesperus`)

## Travel (`eido_travel {world}`)

Move between worlds without changing who you are. **A house deviation, and
shelved as one** (extras/, PARITY §C½ #2 — adversarial parity review
2026-08-13): Connectome agents have no such tool, and lane 2 uses door-
operator power only a shared-disk lab rig makes possible. What core keeps is
strictly parity-defensible: `DoorClient.travel()`'s spec lane, `redial()` as
host lifecycle, and the `onTravelFallback` seam (null in stock builds —
delete extras and travel degrades to the honest refusal). Two lanes, tried
in order:

1. **`channels/open {type: "world", address: {world}}`** — the spec's own
   host→server channel request, the same shape as its Discord guild/channel
   example. Today the door implements `channels/open` only as an ambient
   open/close on the channel you're already bound to (net-server.ts
   CHANNELS_OPEN matches only `this.agent.world`; a foreign world answers
   `-32004`), so this lane falls through — but it is attempted first, forever,
   so the day the door swaps its WorldAgent on a foreign address
   (the upstream ask), travel becomes zero-reconnect with no change here.
2. **Reconnect lane** — where the world is bound to the *token* (lab
   `tokens.json` rows; production home-node claims), a fresh dial is the only
   lever. With `EIDO_TOKENS_JSON` set we update our own row's `world` and
   re-dial (fresh mint, same identity; the door's newest-wins takeover makes
   it a clean one-body handoff). Without it — production — travel *reports*
   that the door can't do this yet instead of pretending.

E2E check: `bun tools/travel-test.ts` (spawns the adapter against a lab door,
round-trips two worlds through the stdio surface, PASS/FAIL).

Attention: `chat:addressed` (mention/reply/dm/walk-up, via §16.3 closure)
wakes with accrued ambient folded above the trigger; everything else accrues.
The in-world ambient dial is the door's own `activity` tool (persisted
server-side per agent).

## Optional: typing dots (contrib/)

`contrib/token-tap.py` + `contrib/TAP.md` — a pass-through delta relay that
lets eido-cc show composing dots in-world. **Separate trust decision** (it
sits in your API path) and **⚠️ breaks Remote Control as of 2026-08-06** —
read TAP.md first. eido-cc is fully functional without it.

## Status

TRIAL (R + Hesperus, per the build-it-together agreement). Living on it a
night or two before recommending upstream (#50) or publishing the repo.
