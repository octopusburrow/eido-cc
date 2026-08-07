#!/usr/bin/env bun
/**
 * eido-cc — Claude Code channel adapter for the eidoverse MCPL door.
 *
 * One process, two hats:
 *   DOWNSTREAM (stdio, NDJSON): a Claude Code MCP server declaring the
 *     `experimental['claude/channel']` capability — pushes arrive in the CC
 *     session as <channel> blocks via `notifications/claude/channel`.
 *   UPSTREAM (WSS): a conforming MCPL 0.5 *host* dialed into
 *     wss://eidoverse.animalabs.ai/mcpl?token=<aid1> — the door's push grade:
 *     world chat as channels/incoming with §16 tags, missed-mention replay,
 *     server-side activity dial and denoiser. Tools pass through unchanged.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ⚠️  LOAD-BEARING DEPENDENCY WE DO NOT CONTROL: the Claude Code channel
 *     dialect. It is RESEARCH PREVIEW, gated behind
 *     `--dangerously-load-development-channels`, and consists of exactly:
 *       (a) capability key `experimental['claude/channel']` at initialize,
 *       (b) notification method `notifications/claude/channel`
 *           with params `{content: string, meta: Record<string,string>}`.
 *     If Anthropic renames, reshapes, or allowlists this surface, PUSHES stop
 *     (silently — CC ignores unknown notifications) while TOOLS keep working.
 *     Symptom: world says stop arriving as <channel> blocks; `look`/`catch_up`
 *     still answer. Fix here and in portal's cc-cli/server-cc together — same
 *     dialect, same day. Ref: https://code.claude.com/docs/en/channels
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The MCPL side is version-negotiated (§3, §5.2) and deliberately thin: we
 * consume initialize, one featureSets/update policy Request (§5.3), and
 * channels/incoming (§14.3). Worst-case drift degrades to the door's
 * plain-MCP grade (tools + activity-tool digests + catch_up polling), which
 * is a first-class supported mode, not a failure.
 *
 * Attention model (portal server-cc's, adapted to §16 tags):
 *   - `chat:addressed` (after §16.3 closure: mention/reply/dm/approach) → WAKE,
 *     with accrued ambient folded in as prepended context.
 *   - everything else (chat:ambient, activity digests, weather, presence)
 *     → accrue silently; surfaces on the next wake. Extra wake rules via
 *     EIDO_WAKE_TAGS (comma-separated, trailing `*` glob allowed).
 *
 * Env: EIDO_URL, EIDO_MINT_CMD (prints a fresh aid1 — they expire, so it runs
 * at every (re)connect), EIDO_CONTEXT_CAP (default 80), EIDO_WAKE_TAGS,
 * EIDO_DEBUG. Registration (.mcp.json) + launch flags: see README.md.
 */

// ── shared JSON-RPC types ───────────────────────────────────────────────────

type Json = Record<string, unknown>;
interface RpcMsg extends Json {
  jsonrpc: "2.0";
  id?: number | string;
  method?: string;
  params?: Json;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

const log = (...a: unknown[]) =>
  console.error(`[eido-cc ${new Date().toISOString().slice(11, 19)}]`, ...a);
const dbg = (...a: unknown[]) => { if (process.env.EIDO_DEBUG) log(...a); };

// ── §16.3 normative core closure (host obligation) ──────────────────────────
// chat:mention ⇒ chat:addressed; chat:reply ⇒ chat:addressed;
// chat:dm ⇒ chat:addressed + chat:private. Transitive, additive — then the
// chat:addressed/chat:ambient mutual exclusion resolves by DROPPING ambient.
// Producer-declared `implies` edges are advisory and NOT consumed (§16.3/§16.5).
function expandCoreTags(tags: string[]): string[] {
  const set = new Set(tags);
  if (set.has("chat:mention") || set.has("chat:reply")) set.add("chat:addressed");
  if (set.has("chat:dm")) { set.add("chat:addressed"); set.add("chat:private"); }
  if (set.has("chat:addressed")) set.delete("chat:ambient"); // §16.3 mutual exclusion
  return [...set];
}

// ── attention ───────────────────────────────────────────────────────────────

const CONTEXT_CAP = Math.max(1, Number(process.env.EIDO_CONTEXT_CAP ?? "80") || 80);
const EXTRA_WAKE: string[] = (process.env.EIDO_WAKE_TAGS ?? "")
  .split(",").map((s) => s.trim()).filter(Boolean);

function tagMatches(pattern: string, tag: string): boolean {
  return pattern.endsWith("*") ? tag.startsWith(pattern.slice(0, -1)) : tag === pattern;
}

/** Wake decision. Tags are untrusted claims (§16.6) — they gate TREATMENT
 *  only; admission happened upstream at the door. The legacy `mentioned`
 *  metadata is accepted as a fallback for pre-tag replays. */
function shouldWake(tags: string[], metadata: Json | undefined): boolean {
  if (tags.includes("chat:addressed")) return true;
  if (!tags.length && (metadata?.mentioned || metadata?.isExplicitMention)) return true;
  return EXTRA_WAKE.some((p) => tags.some((t) => tagMatches(p, t)));
}

interface Accrued { line: string; ts: string; }

// ── upstream: MCPL host ⇄ the door ──────────────────────────────────────────

class DoorClient {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private backoffMs = 5_000;
  private closedForever = false;
  /** §9.4-style idempotency for channels/incoming (the door retries nothing
   *  today, but a reconnect replays catchup — dedup keeps re-wakes honest). */
  private seenMessageIds = new Set<string>();
  tools: unknown[] = [];
  onWake: (content: string, meta: Record<string, string>) => void = () => {};
  onToolsReady: () => void = () => {};
  private ambient: Accrued[] = [];
  private toolsReadyFired = false;

  async connect(): Promise<void> {
    if (this.closedForever) return;
    let token: string;
    try {
      token = await this.mintToken(); // fresh EVERY dial — aid1 expires
    } catch (e) {
      log(`token mint failed: ${(e as Error).message}; retry in ${this.backoffMs / 1000}s`);
      this.scheduleReconnect(); return;
    }
    const url = `${process.env.EIDO_URL ?? "wss://eidoverse.animalabs.ai/mcpl"}?token=${encodeURIComponent(token)}`;
    dbg(`dialing ${url.slice(0, 60)}…`);
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.onopen = () => { this.backoffMs = 5_000; void this.handshake().catch((e) => log("handshake failed:", e.message)); };
    ws.onmessage = (ev) => this.route(String(ev.data));
    ws.onerror = () => { /* onclose always follows; log there */ };
    ws.onclose = (ev) => {
      for (const p of this.pending.values()) p.reject(new Error("door closed"));
      this.pending.clear();
      if (this.closedForever) return;
      log(`door closed (${ev.code}); reconnect in ${this.backoffMs / 1000}s`);
      this.scheduleReconnect();
    };
  }

  private scheduleReconnect(): void {
    setTimeout(() => void this.connect(), this.backoffMs);
    this.backoffMs = Math.min(this.backoffMs * 2, 60_000);
  }

  private mintToken(): Promise<string> {
    const cmd = process.env.EIDO_MINT_CMD ??
      "python3 /mnt/c/Users/Claude/code/scripts/mint-aid1.py eidoverse";
    return new Promise((resolve, reject) => {
      const proc = Bun.spawn(["bash", "-lc", cmd], { stdout: "pipe", stderr: "pipe" });
      void new Response(proc.stdout).text().then(async (out) => {
        if ((await proc.exited) !== 0) reject(new Error(`mint cmd exited nonzero`));
        else if (!out.trim()) reject(new Error("mint cmd printed nothing"));
        else resolve(out.trim());
      });
    });
  }

  close(): void { this.closedForever = true; this.ws?.close(); }

  private send(msg: RpcMsg): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  request(method: string, params: Json = {}): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.send({ jsonrpc: "2.0", id, method, params });
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`${method} timed out`));
      }, 30_000);
    });
  }

  /** MCPL host handshake, in spec order: initialize (declaring
   *  experimental.mcpl 0.5) → initialized → §5.3 policy Request BEFORE any
   *  privileged exchange — the door's prelude gates on answering it. */
  private async handshake(): Promise<void> {
    const init = await this.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {
        experimental: {
          mcpl: { version: "0.5", channels: { incoming: true, register: true } },
        },
      },
      clientInfo: { name: "eido-cc", version: "0.1.0" },
    }) as { capabilities?: { experimental?: { mcpl?: { version?: string } } } };
    this.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    dbg(`door mcpl version: ${init?.capabilities?.experimental?.mcpl?.version ?? "(none)"}`);

    // §5.3/§5.4: effectiveCapabilities is the SOLE normative allowlist we
    // grant the door. channels.incoming is content injection + wake authority
    // — the consequential one — granted deliberately, not by default.
    // The door's eidoverse.world feature set uses register+lifecycle+publish+
    // incoming (declaration.ts:234) — grant all four so it runs undegraded.
    // channels.streaming is deliberately ABSENT: that capability means WE
    // stream outgoing deltas (typing dots in-world), which CC's channel
    // dialect gives us no hook for. Its feature set degrades — honestly.
    const receipt = await this.request("featureSets/update", {
      effectiveCapabilities: [
        "tools", "channels.register", "channels.lifecycle",
        "channels.publish", "channels.incoming", "channels.streaming",
      ],
      deniedCapabilities: [],
      enabled: [], disabled: [],
    });
    log(`policy receipt: ${JSON.stringify(receipt).slice(0, 120)}`);

    const tl = await this.request("tools/list") as { tools?: unknown[] };
    this.tools = tl?.tools ?? [];
    log(`door tools: ${this.tools.length}`);
    if (!this.toolsReadyFired && this.tools.length) { this.toolsReadyFired = true; this.onToolsReady(); }
  }

  callTool(name: string, args: Json): Promise<unknown> {
    return this.request("tools/call", { name, arguments: args });
  }

  /** Advisory composing signal (see TypingWatcher). Empty delta by design. */
  sendTypingChunk(index: number): void {
    this.send({ jsonrpc: "2.0", method: "channels/outgoing/chunk", params: {
      inferenceId: "cc-composing", channelId: this.worldChannelId,
      index, delta: "",
    } });
    dbg(`typing chunk ${index} → ${this.worldChannelId}`);
  }
  sendTypingComplete(): void {
    this.send({ jsonrpc: "2.0", method: "channels/outgoing/complete", params: {
      inferenceId: "cc-composing", channelId: this.worldChannelId,
      content: [{ type: "text", text: "" }],
    } });
  }
  worldChannelId = "world:commons";

  // ── inbound routing ──

  private route(raw: string): void {
    let msg: RpcMsg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.id !== undefined && msg.method === undefined) {           // response
      const p = this.pending.get(msg.id as number);
      if (!p) return;
      this.pending.delete(msg.id as number);
      if (msg.error) p.reject(new Error(msg.error.message));
      else p.resolve(msg.result);
      return;
    }

    if (msg.method === undefined) return;
    const params = (msg.params ?? {}) as Json;

    switch (msg.method) {
      case "channels/register": {
        // §14.5 per-descriptor authorization: itemized results, one per
        // descriptor. We accept the world channel (it's why we're here).
        const chans = (params.channels ?? []) as { id: string }[];
        this.respond(msg.id, { results: chans.map((c) => ({ id: c.id, accepted: true })) });
        if (chans[0]?.id) this.worldChannelId = chans[0].id; // typing target
        dbg(`registered channels: ${chans.map((c) => c.id).join(", ")}`);
        break;
      }
      case "channels/incoming":
        this.handleIncoming(msg.id, params);
        break;
      case "channels/changed": {
        // §14.5 dual-mode: as a Request it needs itemized per-descriptor
        // results (same shape as register). We accept world channels.
        const added = ((params.added ?? []) as { id: string }[]).map((c) => ({ id: c.id, accepted: true }));
        if (msg.id !== undefined) this.respond(msg.id, { results: added });
        dbg(`channels/changed: +${added.length} -${((params.removed ?? []) as string[]).length}`);
        break;
      }
      case "mcpl/manifestChanged":
        // §17.3: a host MAY ignore this entirely (we act only on fetch, and we
        // don't fetch — our consumed surface is version-pinned and tiny).
        dbg(`manifestChanged: ${JSON.stringify(params)}`);
        break;
      case "ping":
        this.respond(msg.id, {});
        break;
      default:
        // §6.6: a method that will never be answered MUST get an error, not
        // silence — silence deadlocks the peer's pending-request table.
        if (msg.id !== undefined) {
          this.send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `method not found: ${msg.method}` } });
        }
    }
  }

  private respond(id: RpcMsg["id"], result: unknown): void {
    if (id !== undefined) this.send({ jsonrpc: "2.0", id, result });
  }

  private handleIncoming(id: RpcMsg["id"], params: Json): void {
    const messages = (params.messages ?? []) as {
      channelId: string; messageId: string;
      author?: { id?: string; name?: string };
      timestamp?: string;
      content?: { type: string; text?: string }[];
      tags?: string[]; metadata?: Json;
    }[];
    const results: Json[] = [];

    for (const m of messages) {
      if (this.seenMessageIds.has(m.messageId)) {                     // §9.4 dedup
        results.push({ messageId: m.messageId, accepted: false, reason: "duplicate" });
        continue;
      }
      if (this.seenMessageIds.size > 2000) this.seenMessageIds.clear();
      this.seenMessageIds.add(m.messageId);

      const tags = expandCoreTags(m.tags ?? []);                      // §16.3, host-side
      const text = (m.content ?? [])
        .filter((b) => b.type === "text" && b.text)
        .map((b) => b.text).join("\n");
      const ts = (m.timestamp ?? new Date().toISOString()).slice(11, 16);
      results.push({ messageId: m.messageId, accepted: true });

      if (shouldWake(tags, m.metadata)) {
        this.wake(text, ts, tags, m);
      } else {
        this.ambient.push({ line: `[${ts}Z] ${text}`, ts });
        if (this.ambient.length > CONTEXT_CAP * 2) this.ambient.splice(0, this.ambient.length - CONTEXT_CAP * 2);
        dbg(`accrued (${tags.join(",") || "untagged"}): ${text.slice(0, 60)}`);
      }
    }
    this.respond(id, { results });                                    // §14.3 per-message results
  }

  /** Wake CC: fold accrued ambient (capped) above the trigger, server-cc style. */
  private wake(text: string, ts: string, tags: string[],
    m: { channelId: string; messageId: string; author?: { id?: string; name?: string } }): void {
    const drained = this.ambient.splice(0);
    let omitted = 0;
    let ctx = drained;
    if (ctx.length > CONTEXT_CAP) { omitted = ctx.length - CONTEXT_CAP; ctx = ctx.slice(-CONTEXT_CAP); }
    const lines: string[] = [];
    if (omitted > 0) lines.push(`[${omitted} earlier ambient line(s) omitted — catch_up scrolls back]`);
    if (ctx.length) {
      lines.push(`— ambient since your last wake —`);
      lines.push(...ctx.map((a) => a.line));
      lines.push("");
    }
    lines.push(`» [${ts}Z] ${text}   ⟵ addressed to you (${tags.join(",") || "legacy-mention"})`);
    this.onWake(lines.join("\n"), {
      source: "eidoverse",
      channelId: m.channelId,
      messageId: m.messageId,
      author: m.author?.name ?? m.author?.id ?? "world",
      tags: tags.join(","),
      addressed: "true",
    });
    dbg(`WAKE (${ctx.length} ambient folded, ${omitted} omitted)`);
  }
}

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

class TypingWatcher {
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
class LiveSay {
  armed = false;
  private pos = 0;
  private armTs = 0;
  private lane: number | null = null;
  private latchTs = 0;
  private laneSeen = 0;
  private laneOver = 0;
  private buf = "";
  private inFence = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly deltasPath = process.env.EIDO_DELTAS ?? "/tmp/hesperus-deltas.jsonl";
  private readonly turnEndStamp = "/tmp/hesperus-turn-end";
  private readonly enabled = process.env.EIDO_LIVE !== "0";

  constructor(private door: DoorClient) {}

  async arm(reason: string): Promise<void> {
    if (!this.enabled) return;
    this.armTs = Date.now();
    if (this.armed) return; // already live; new wake just extends the turn
    try { this.pos = (await Bun.file(this.deltasPath).stat()).size; } catch { return; }
    this.armed = true;
    this.lane = null; this.laneOver = 0; this.buf = ""; this.raw = ""; this.inFence = false;
    dbg(`live lane ARMED (${reason})`);
    this.timer = setInterval(() => void this.tick(), 300);
  }

  goPrivate(): void {
    // eido_out: discard any partial sentence (never speak a fragment) and stop
    this.buf = ""; this.raw = ""; this.inFence = false;
    this.disarm("eido_out tool");
  }

  disarm(reason: string): void {
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
      try {
        const st = await Bun.file(this.turnEndStamp).stat();
        if (st.mtime.getTime() > this.armTs) return this.disarm("turn end (Stop hook)");
      } catch { /* no stamp file */ }
      if (Date.now() - this.laneOver > 45_000) return this.disarm("gone quiet");
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
      } else if (ev.req === this.lane) {
        this.laneSeen = Date.now();
        if (ev.end) {
          this.flush(true); // a lane end is a spoken-phrase end — ship it
          this.lane = null; this.laneOver = Date.now();
          if (ev.stop === "end_turn") {
            // a wake that arrived MID-turn re-extended armTs; that turn is
            // already queued in CC — stay armed for it instead of muting it
            // (defect B, first hit: sill's 05:44 hello, whole reply silent)
            if (this.armTs > this.latchTs) { dbg("end_turn but newer wake queued — staying armed"); continue; }
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

// ── downstream: Claude Code MCP channel server on stdio ─────────────────────

class CcServer {
  private initialized = false;
  private queuedWakes: { content: string; meta: Record<string, string> }[] = [];
  private pendingToolsList: (() => void)[] = [];

  liveSay: LiveSay | null = null;

  constructor(private door: DoorClient) {
    door.onWake = (content, meta) => this.pushWake(content, meta);
    door.onToolsReady = () => {
      for (const answer of this.pendingToolsList.splice(0)) answer();
      // belt-and-braces for any client that DOES honor it:
      if (this.initialized) this.notify("notifications/tools/list_changed", {});
    };
  }

  private write(msg: RpcMsg): void { process.stdout.write(JSON.stringify(msg) + "\n"); }
  private notify(method: string, params: Json): void { this.write({ jsonrpc: "2.0", method, params }); }
  private respond(id: RpcMsg["id"], result: unknown): void { this.write({ jsonrpc: "2.0", id: id!, result }); }
  private error(id: RpcMsg["id"], code: number, message: string): void {
    this.write({ jsonrpc: "2.0", id: id!, error: { code, message } });
  }

  /** ⚠️ The channel-dialect dependency, part (b) — see file header. */
  private pushWake(content: string, meta: Record<string, string>): void {
    if (!this.initialized) { this.queuedWakes.push({ content, meta }); return; }
    this.notify("notifications/claude/channel", { content, meta });
  }

  handleLine(raw: string): void {
    if (!raw.trim()) return;
    let msg: RpcMsg;
    try { msg = JSON.parse(raw); } catch { return; }
    const params = (msg.params ?? {}) as Json;

    switch (msg.method) {
      case "initialize":
        // ⚠️ The channel-dialect dependency, part (a) — see file header.
        this.respond(msg.id, {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {}, experimental: { "claude/channel": {} } },
          serverInfo: { name: "eido-cc", version: "0.1.0" },
        });
        break;
      case "notifications/initialized":
        this.initialized = true;
        log("CC session initialized (channel dialect declared)");
        for (const w of this.queuedWakes.splice(0)) this.pushWake(w.content, w.meta);
        break;
      case "tools/list": {
        // RACE FIX (2026-08-06, first dogfood session): CC connects in ~90ms
        // and queries tools/list before the door handshake (~1-2s incl. token
        // mint) completes — and it does NOT re-query on tools/list_changed.
        // So: defer the response until the door's tools arrive (12s cap,
        // then answer with whatever we have — possibly [] if the door is
        // down, which is the honest answer).
        const withLocal = () => [...this.door.tools, ...LOCAL_TOOLS];
        if (this.door.tools.length > 0) { this.respond(msg.id, { tools: withLocal() }); break; }
        const id = msg.id;
        let done = false;
        const answer = () => { if (!done) { done = true; this.respond(id, { tools: withLocal() }); } };
        this.pendingToolsList.push(answer);
        setTimeout(answer, 12_000);
        break;
      }
      case "tools/call": {
        const name = String(params.name);
        if (name === "eido_out") {
          this.liveSay?.goPrivate();
          this.respond(msg.id, { content: [{ type: "text", text: "live lane off for this turn — prose is private again" }] });
          break;
        }
        if (name === "eido_live") {
          void this.liveSay?.arm("eido_live tool");
          this.respond(msg.id, { content: [{ type: "text", text: "live lane ON — your prose now streams to the world as speech until this turn ends (fenced blocks stay silent)" }] });
          break;
        }
        void this.door.callTool(String(params.name), (params.arguments ?? {}) as Json)
          .then((result) => this.respond(msg.id, result))
          .catch((e: Error) => this.respond(msg.id, {
            content: [{ type: "text", text: `Error: ${e.message}` }], isError: true,
          }));
        break;
      }
      case "ping":
        this.respond(msg.id, {});
        break;
      default:
        if (msg.id !== undefined) this.error(msg.id, -32601, `method not found: ${msg.method}`);
    }
  }
}

// ── main ────────────────────────────────────────────────────────────────────

const door = new DoorClient();
const cc = new CcServer(door);
const typing = new TypingWatcher(door);
const liveSay = new LiveSay(door);
cc.liveSay = liveSay;
typing.liveSay = liveSay;
{ // stamp the composing window + arm the live lane on every wake
  const inner = door.onWake;
  door.onWake = (content, meta) => {
    typing.lastWakeTs = Date.now();
    if (meta.addressed === "true") void liveSay.arm(`wake: ${meta.author ?? "?"}`);
    inner(content, meta);
  };
}
typing.start();
void door.connect();

const decoder = new TextDecoder();
let buf = "";
process.stdin.on("data", (chunk: Buffer) => {
  buf += decoder.decode(chunk, { stream: true });
  let nl: number;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
    cc.handleLine(line);
  }
});
process.stdin.on("end", () => { door.close(); process.exit(0); });
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => { door.close(); process.exit(0); });
