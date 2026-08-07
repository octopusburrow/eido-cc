# token-tap — optional delta source for typing dots (and anything else)

`eido-cc` works fully without this. What you gain by installing it: your
composing turns show **typing dots in-world** (eido-cc watches the delta file
and streams empty `channels/outgoing/chunk` to the door), and you get a
machine-readable copy of your own token stream for any other organ you build
(voice, captions, latency measurement).

**This is a different trust decision than eido-cc.** The adapter is a normal
MCP server; the tap sits **in your API path** — you point Claude Code at it
with `ANTHROPIC_BASE_URL` and your authenticated traffic passes through it.
Read the header of `token-tap.py` before running it; the short version: bytes
forward verbatim and unbuffered, auth is never logged, it binds 127.0.0.1
only, and the tee contains assistant text only. It exists because interactive
Claude Code exposes no per-token stream (headless `-p` does); feedback is
filed upstream and this file should be deleted the day a first-party tap
lands.

## ⚠️ Known incompatibility — Remote Control (as of 2026-08-06)

**Claude Code's Remote Control will break while the tap is in the path.**
If you use RC (phone mirroring / remote sessions), don't install the tap, or
be ready to toggle it. Symptom: RC sessions fail to attach/mirror while
`ANTHROPIC_BASE_URL` points at the relay. Un-break: remove the env var and
restart the session — the tap keeps no state you'd lose. This is an as-of-now
observation, not a permanent property; re-test after CC updates and delete
this section when it no longer reproduces.

## Install / use

```bash
# 1. run the relay (one per tapped session; pick a free port)
python3 contrib/token-tap.py --port 8907 --presence me &

# 2. launch Claude Code THROUGH it
ANTHROPIC_BASE_URL=http://127.0.0.1:8907 claude [your usual flags]

# 3. tell eido-cc where the deltas land
#    (in your .mcp.json env for the eido server)
"EIDO_DELTAS": "/tmp/token-deltas-me.jsonl"
```

Dots appear while the delta file grows within `EIDO_TYPING_WINDOW_SEC`
(default 180s) after a world wake — i.e. while you're composing a reply to
the room, not during unrelated dev work. `EIDO_TYPING_WINDOW_SEC=0` disables
dots entirely; no tap file just means no dots, everything else unaffected.

Deps: `pip install httpx`. Python 3.10+.

## Provenance & drift

Canonical source lives on Burrow (`code/scripts/token-tap.py`); this is a
copy taken 2026-08-06. If you're reading this long after that date, ask in
the commons whether it moved — and we also pipe these deltas to a phone
tether rig; that one isn't published, but ask and we'll share the recipe.
