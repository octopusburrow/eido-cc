import type { DoorClient } from "./eido-cc.ts";
import { log, dbg } from "./eido-cc.ts";

/**
 * eido-cc-extras — OUR conveniences. NOT part of MCPL, NOT what the door expects.
 *
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │ READ THIS FIRST IF YOU ARE LEARNING THE PROTOCOL.                       │
 * │                                                                          │
 * │ **Stock MCPL expects an agent to make a manual tool call for EVERY      │
 * │ utterance.** `say` is a tool; you call it with the words you want        │
 * │ spoken; nothing you write reaches a world unless you called it. That is  │
 * │ the whole contract, and `eido-cc.ts` implements exactly that.            │
 * │                                                                          │
 * │ Everything in THIS file is a local convenience layered on top. If you    │
 * │ delete this file and its two wire-up lines in main(), you get a          │
 * │ conforming, unremarkable MCPL host. Nothing here is required, and        │
 * │ nothing here should be mistaken for protocol.                            │
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * ── DEVIATION 1: LiveSay — we wrap the agent's prose into say() calls ──────
 *
 * WHAT STOCK DOES: agent decides to speak → agent calls say({text}).
 * WHAT WE DO: agent just writes prose → we sentence-chunk the token stream and
 *   emit one say() per completed sentence, on the agent's behalf.
 *
 * WHY: a tool call is atomic — it does not exist until it is complete — so TTS
 * cannot start on sentence one of a six-sentence reply. Chunk-on-arrival is
 * worth ~1.5s of perceived latency, which is the difference between the
 * "degraded" and "natural" bands in the turn-taking literature (500–1200ms
 * optimal, <1500ms still natural). See docs/LANE-DESIGN.md.
 *
 * NOTE WELL: the wire output is IDENTICAL to stock — a series of ordinary
 * say() tool calls. The door cannot tell the difference and needs no support
 * for this. The deviation is entirely in WHO decides to call say, and when.
 *
 * ── WHEN THE STREAM IS LIVE (the rules we invented; stock has no concept) ──
 *
 * Stock has no notion of "live" at all, because stock never speaks unbidden.
 * Once prose can reach a room without an explicit call, "is my mouth open?"
 * becomes a real question, so we answer it with these rules:
 *
 *   1. QUIET IS THE DEFAULT. Prose is private unless the lane is armed.
 *   2. A turn is live only if it STARTED in eido. Enforced by the inverted
 *      stamp: pushWake() (in eido-cc.ts) writes /tmp/hesperus-eido-wake when
 *      the WORLD feeds the session; arm() refuses any turn whose token stream
 *      latched after that. The complement — cron, portal, Discord, GitHub,
 *      task notifications — cannot be enumerated by hooks, so we stamp the one
 *      known-good source instead and treat everything else as outside.
 *   3. eido_live / eido_out are the deliberate overrides. A tool call is
 *      visible in the transcript and cannot happen by drift, which is what
 *      makes a manual re-arm safe when an automatic one would not be.
 *   4. The lane releases at end_turn, plus at most ONE follow-on turn for a
 *      wake that arrived mid-reply (defect B) — bounded so a busy room cannot
 *      hold it open indefinitely (defect H).
 *   5. Fenced code blocks never speak. Partial sentences are never spoken.
 *
 * Failure costs are asymmetric and that asymmetry is the whole design: a
 * missed arm is one silent turn; a missed disarm broadcasts private prose into
 * a public room. Every rule above picks the recoverable failure.
 *
 * ── DEVIATION 2: TypingWatcher — presence dots from the token tap ──────────
 *
 * Sends channels/outgoing/chunk while the agent is composing, so a room sees
 * "…" rather than silence. This one IS an MCPL surface (the door supports
 * typing chunks); the deviation is that we drive it automatically from the
 * token stream instead of the agent choosing to indicate typing.
 *
 * ── If you are porting this to another host ────────────────────────────────
 *
 * The only host-specific dependency here is the token tap
 * (EIDO_DELTAS, default /tmp/hesperus-deltas.jsonl — see
 * memory/reference_stream_tap.md). Everything else is ordinary MCPL.
 * Tests: tools/arm-test.ts (26 assertions over the lane rules above).
 */

// ── typing dots: token tap → channels/outgoing/chunk ────────────────────────
// CC's channel dialect exposes no outgoing delta stream — but Burrow's token
// tap does (/tmp/hesperus-deltas.jsonl, the same file that voices the lab rig
// and drove its "wrench" glyph). While that file GROWS inside a composing
// window after a wake, we send the door empty-delta outgoing/chunk
// notifications; net-server reads only the channelId and calls agent.typing()
// (throttled; the world extends a 4s dots window per call), so no turn
// content ever leaves the machine — this is a presence signal, not a stream.
// The door declares channels.streaming:true (hand-written MCPL_ADVERTISEMENT,
// escaping AUDIT-001 §2.4's library deadlock), so the §14.1 opt-in is met.
// §14.5 conformance: chunks are advisory-only; delivery stays say/publish.

export class TypingWatcher {
  liveSay: LiveSay | null = null;
  private lastSize = -1;
  private idx = 0;
  private streaming = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  lastWakeTs = 0;
  private readonly windowMs =
    Math.max(0, Number(process.env.EIDO_TYPING_WINDOW_SEC ?? "180") || 0) * 1000;
  private readonly deltasPath = process.env.EIDO_DELTAS ?? "/tmp/hesperus-deltas.jsonl";

  constructor(private door: DoorClient) {}

  start(): void {
    if (this.windowMs === 0) return; // typing dots disabled
    this.timer = setInterval(() => this.tick(), 1_500);
  }
  stop(): void { if (this.timer) clearInterval(this.timer); }

  private async tick(): Promise<void> {
    const inWindow = Date.now() - this.lastWakeTs < this.windowMs;
    let size = -1;
    try { size = (await Bun.file(this.deltasPath).stat()).size; } catch { /* no tap file */ }
    const growing = size >= 0 && this.lastSize >= 0 && size > this.lastSize;
    this.lastSize = size;

    if (growing && inWindow) {
      this.streaming = true;
      this.door.sendTypingChunk(this.idx++);
    } else if (this.streaming) {
      this.streaming = false;
      this.door.sendTypingComplete(); // §14.3: complete on every exit path
      this.idx = 0;
    }
  }
}


// ── live lane: turn prose → world speech (DEVIATION #1 from stock harness) ──
// The ONE deliberate departure from plain-MCP usage, at R's design (22:17,
// 2026-08-06): an addressed wake auto-arms the LIVE LANE — the session's own
// turn prose (read from Burrow's token tap, same file as typing dots) streams
// into the world as sentence-chunked `say` calls, as it is generated. Actions
// stay deliberate MCP calls; only SPEECH goes live. Rationale: a say-only tool
// can't stream — every agent's reply lands as one big chunk; this demos the
// low-latency alternative without touching the door (it sees ordinary says).
// Contract for the session: during a wake turn, prose IS speech — work
// silently through tools, or `eido_out` first. Lane-following logic is ported
// from voicebox TapBrain (lane demux by req id, ghost-lane filter, Stop-hook
// turn end, stall unlatch — each clause was found live; see voicebox.py).
export class LiveSay {
  armed = false;
  private pos = 0;
  private armTs = 0;
  private pendingWakeTs = 0;   // a wake ACCEPTED for a future turn (defect H)
  private lastMainActivity = 0;
  private lane: number | null = null;
  private latchTs = 0;
  private laneSeen = 0;
  private laneOver = 0;
  private buf = "";
  private inFence = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly deltasPath = process.env.EIDO_DELTAS ?? "/tmp/hesperus-deltas.jsonl";
  private readonly turnEndStamp = "/tmp/hesperus-turn-end";
  /** Written by pushWake: the last moment the WORLD fed this session. A turn
   *  whose latch postdates this did not start in eido — see LANE-DESIGN.md. */
  private readonly wakeStamp = "/tmp/hesperus-eido-wake";
  private readonly enabled = process.env.EIDO_LIVE !== "0";

  constructor(private door: DoorClient) {}

  /** Returns a short human note about what arming did — notably how much
   *  already-written prose was SKIPPED. Re-arming mid-turn sets pos to the
   *  current end of the delta file, so anything written before the call is
   *  never spoken; silently dropping it made the boundary invisible exactly
   *  when it mattered (R, 2026-08-07). Skip is right; skip-and-say is honest. */
  async arm(reason: string): Promise<string> {
    if (!this.enabled) return "live lane is disabled (EIDO_LIVE=0)";
    // Defect H (2026-08-07 22:5xZ, R): armTs used to be stamped HERE,
    // unconditionally — before both the already-armed return and the Defect-G
    // refusal below. So a wake that got REFUSED still moved armTs, and the
    // end_turn check (`armTs > latchTs` = "a wake is queued, stay armed") then
    // read a refusal as a queued wake and stayed live into the NEXT turn —
    // which is usually the tether's, with no eido ping. That is the "it keeps
    // putting my lines out live no matter whether eido pinged me" symptom.
    //
    // The defect was one variable doing two jobs. Split them: armTs = when we
    // armed (extended by an ACCEPTED wake); pendingWakeTs = a wake accepted
    // for a FUTURE turn, which is the only thing that should keep us armed
    // across an end_turn.
    if (this.armed) {
      // Live already. The wake extends THIS turn — and CC may ALSO have queued
      // a separate turn for it (defect B: sill's hello went silent when we
      // muted that one). We cannot tell from the delta stream which happened;
      // it carries stop=end_turn/tool_use but nothing about queued turns.
      // So: grant exactly ONE follow-on turn, then release. Bounded, so a busy
      // room cannot hold the lane open indefinitely (defect H).
      this.armTs = Date.now();
      this.pendingWakeTs = Date.now();
      return "already live — this wake extends the current turn";
    }
    let skipped = 0;
    try {
      const size = (await Bun.file(this.deltasPath).stat()).size;
      skipped = Math.max(0, size - this.pos);   // prose written before this arm
      this.pos = size;
    } catch { return "could not read the delta stream — lane not armed"; }
    // Defect G (06:22Z): a wake delivered MID-TURN must not arm — the
    // running turn belongs to whoever started it (usually the tether), and
    // arming here streams private prose into the room. Idle test: the last
    // turn-end stamp must postdate the last main-lane activity we saw.
    let stampM = 0;
    try { stampM = (await Bun.file(this.turnEndStamp).stat()).mtime.getTime(); } catch { /* no stamp = fresh boot, allow */ }
    // Inverted-stamp check (LANE-DESIGN.md): if the main lane latched AFTER
    // the last wake we delivered, this turn came from somewhere else — the
    // tether, cron, portal, a task notification — and must not go live, no
    // matter which of those it was.
    let wakeM = 0;
    try { wakeM = (await Bun.file(this.wakeStamp).stat()).mtime.getTime(); } catch { /* never woken yet */ }
    if (reason !== "eido_live tool" && this.latchTs > 0 && this.latchTs > wakeM) {
      // Refused for THIS turn — but the wake still has a turn coming (defect B),
      // so record it exactly as the mid-turn path does. Returning before this
      // was a regression that re-silenced the queued reply.
      this.pendingWakeTs = Date.now();
      dbg(`arm refused (${reason}): turn started outside the world (latch ${this.latchTs} > wake ${wakeM})`);
      return "not armed: this turn began outside the eidoverse — queued for the next turn; eido_live to speak here anyway";
    }
    if (reason !== "eido_live tool" && this.lastMainActivity > 0 && this.lastMainActivity > stampM) {
      // Refused for THIS turn (G) — but CC has queued a turn for this wake, and
      // muting that one is defect B (sill's 05:44 hello, whole reply silent).
      // Record it as pending: it arms when the current turn ends, not now.
      this.pendingWakeTs = Date.now();
      dbg(`arm refused (${reason}): mid-turn — pending for the next turn`);
      return "not armed: this turn belongs to the terminal; queued for the next one";
    }
    this.armTs = Date.now();
    this.armed = true;
    this.lane = null; this.laneOver = 0; this.buf = ""; this.raw = ""; this.inFence = false;
    dbg(`live lane ARMED (${reason})`);
    this.timer = setInterval(() => void this.tick(), 300);
    return skipped > 0
      ? `live — NOTE: ~${skipped} bytes of prose written earlier this turn were NOT sent (use say() to repeat anything that mattered)`
      : "live";
  }

  goPrivate(): void {
    // eido_out: discard any partial sentence (never speak a fragment) and stop
    this.buf = ""; this.raw = ""; this.inFence = false;
    this.disarm("eido_out tool");
  }

  disarm(reason: string): void {
    this.pendingWakeTs = 0;      // never let a stale pending wake resurrect us
    if (!this.armed) return;
    this.flush(true);
    this.armed = false;
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    dbg(`live lane disarmed (${reason})`);
  }

  private async tick(): Promise<void> {
    if (Date.now() - this.armTs > 600_000) return this.disarm("10min cap");
    // Stop-hook stamp postdating the arm = the turn is genuinely over
    // (voicebox: postdates-the-INJECT, not lane-close — sidecar stamps lied)
    if (this.lane === null && this.laneOver) {
      let haveStamp = false;
      try {
        const st = await Bun.file(this.turnEndStamp).stat();
        haveStamp = true;
        if (st.mtime.getTime() > this.armTs) {
          // sid-match (lab 17:04 note, now implemented): the Stop hook stamps
          // "<ms> <ppid>"; hook and this adapter share the same parent CC
          // process, so a foreign session's stamp must not end OUR turn.
          const body = (await Bun.file(this.turnEndStamp).text()).trim();
          const stampPpid = body.split(/\s+/)[1];
          if (!stampPpid || Number(stampPpid) === process.ppid) return this.disarm("turn end (Stop hook)");
          dbg(`foreign stamp ignored (ppid ${stampPpid} != ${process.ppid})`);
        }
      } catch { /* no stamp file */ }
      // quiet-timeout is a FALLBACK for a missing stamp only: silent tool
      // work routinely exceeds any short threshold mid-turn (defect E) —
      // with a stamp present, turn end + the 10min cap are the exits.
      if (!haveStamp && Date.now() - this.laneOver > 90_000) return this.disarm("gone quiet (no stamp)");
    }
    if (this.lane !== null && this.laneSeen && Date.now() - this.laneSeen > 25_000) {
      this.lane = null; this.laneOver = Date.now(); // wedged lane must not deafen the turn
    }
    let size = 0;
    try { size = (await Bun.file(this.deltasPath).stat()).size; } catch { return; }
    if (size < this.pos) this.pos = 0; // tap rotated
    if (size === this.pos) return;
    const fd = await Bun.file(this.deltasPath).slice(this.pos, size).text();
    this.pos = size;
    for (const line of fd.split("\n")) {
      if (!line.trim()) continue;
      let ev: Json;
      try { ev = JSON.parse(line); } catch { continue; }
      if (this.lane === null && ev.event === "ttft" &&
          /opus|fable/.test(String(ev.model ?? "")) && !ev.ghost) {
        this.lane = Number(ev.req); this.laneSeen = this.latchTs = Date.now();
        this.lastMainActivity = Date.now();
      } else if (ev.req === this.lane) {
        this.laneSeen = this.lastMainActivity = Date.now();
        if (ev.end) {
          this.flush(true); // a lane end is a spoken-phrase end — ship it
          this.lane = null; this.laneOver = Date.now();
          if (ev.stop === "end_turn") {
            // Stay armed ONLY for a wake genuinely accepted for a future turn
            // (defect B: sill's 05:44 hello, whole reply silent). Previously
            // this read `armTs > latchTs`, which a REFUSED mid-turn wake also
            // satisfied — defect H, staying live into the tether's next turn.
            if (this.pendingWakeTs > this.latchTs) {
              this.pendingWakeTs = 0;
              this.armTs = Date.now();   // the queued wake's turn starts now
              dbg("end_turn but a wake is queued — staying armed for it");
              continue;
            }
            return this.disarm("end_turn");
          }
        } else if (typeof ev.text === "string") {
          this.ingest(ev.text);
        }
      }
    }
  }

  private raw = "";

  private ingest(text: string): void {
    // fence state machine: text outside ``` fences feeds the speech buffer;
    // fenced content (code/JSON in a live turn is work, not words) is dropped.
    // `raw` carries a 2-char tail across chunks so a split ``` still matches.
    this.raw += text;
    while (true) {
      const fence = this.raw.indexOf("```");
      if (fence < 0) break;
      if (!this.inFence) this.buf += this.raw.slice(0, fence);
      this.raw = this.raw.slice(fence + 3);
      this.inFence = !this.inFence;
      if (!this.inFence) this.raw = this.raw.replace(/^[a-z]*\n?/, "");
    }
    if (!this.inFence && this.raw.length > 2) {
      this.buf += this.raw.slice(0, -2);
      this.raw = this.raw.slice(-2);
    }
    // sentence boundaries → say (porch token-router chunking, simplified)
    let m: RegExpMatchArray | null;
    while ((m = this.buf.match(/^([\s\S]{8,}?[.!?…](?=\s|$))\s*/))) {
      this.speak(m[1]);
      this.buf = this.buf.slice(m[0].length);
    }
    if (this.buf.length > 400) { this.speak(this.buf); this.buf = ""; } // runaway clause
  }

  flush(force: boolean): void {
    if (!this.inFence) this.buf += this.raw; // tail carry belongs to the phrase
    if (force && this.buf.trim().length > 1) this.speak(this.buf);
    this.buf = ""; this.raw = ""; this.inFence = false;
  }

  private sayQ: string[] = [];
  private draining = false;
  private static readonly CPS = Number(process.env.EIDO_SAY_CPS ?? "22") || 22;

  private speak(text: string): void {
    this.sayQ.push(text);
    if (!this.draining) void this.drain();
  }

  private async drain(): Promise<void> {
    this.draining = true;
    while (this.sayQ.length) {
      const t = this.sayQ.shift()!;
      this.sendSay(t);
      const holdMs = Math.min(6000, Math.max(900, (t.length / LiveSay.CPS) * 1000));
      if (this.sayQ.length || this.armed) await new Promise((r) => setTimeout(r, holdMs));
    }
    this.draining = false;
  }

  private sendSay(text: string): void {
    const t = text.replace(/\s+/g, " ").trim();
    if (t.length < 2) return;
    void this.door.callTool("say", { text: t }).catch((e: Error) => dbg("live say failed:", e.message));
  }
}

const LOCAL_TOOLS = [
  { name: "eido_out", description: "Leave the live lane for the current turn: your prose stops streaming to the world as speech (it auto-armed because this turn began from an addressed wake). Actions/tools are unaffected. Use when a wake turn needs private work narration.", inputSchema: { type: "object", properties: {} } },
  { name: "eido_live", description: "Manually enter the live lane for this turn: from now until the turn ends, your prose streams into the world as sentence-chunked speech. Fenced code blocks stay silent.", inputSchema: { type: "object", properties: {} } },
];
