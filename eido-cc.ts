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
 *
 * ── WHAT IS IN THIS FILE vs extras/ ───────────────────────────────
 *
 * THIS FILE is MCPL parity: the door contract as specified, and the Claude Code
 * channel server that carries it. **Stock MCPL expects the agent to make a
 * manual tool call for every utterance** — `say` is a tool, you call it with
 * the words you want spoken, and nothing reaches a world unless you called it.
 * That is what this file implements, and it is the file to read if you want the
 * protocol's original intention without our taste mixed in.
 *
 * ONE THING HERE IS OURS, and it is marked at the call site: pushWake() writes
 * /tmp/hesperus-eido-wake (the inverted stamp). It is three lines, it touches no
 * wire format, and it lives here rather than in extras only because this is
 * where wakes are delivered. Nothing in the protocol requires or notices it.
 *
 * extras/eido-cc-extras.ts holds the deviations — automatic say()-wrapping of the
 * agent's prose (LiveSay) and automatic typing indication (TypingWatcher),
 * plus the lane rules that become necessary once prose can reach a room
 * without an explicit call. Delete that file and its two wire-up lines in
 * main() and you have a conforming, unremarkable MCPL host.
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

// stderr is invisible when the host launches us as an MCP server (CC swallows
// it), which made push-path debugging impossible from inside a session —
// EIDO_LOG tees the same lines to a file the session can read. 2026-08-07.
export { log, dbg } from "./eido-cc-log.ts";
import { log, dbg } from "./eido-cc-log.ts";

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
// `!tag` excludes. Needed because one tag can cover two phenomena: the door
// puts `chat:ambient` on BOTH per-utterance nearby speech and the batched
// activity digest (the digest additionally carries `eidoverse:activity-digest`).
// Positive-only matching cannot say "live speech, not the pulse".
// 2026-08-07 — kept host-side deliberately; the door needn't know our taste.
const WAKE_PATTERNS: string[] = (process.env.EIDO_WAKE_TAGS ?? "")
  .split(",").map((s) => s.trim()).filter(Boolean);
const EXTRA_WAKE: string[] = WAKE_PATTERNS.filter((p) => !p.startsWith("!"));
const WAKE_EXCLUDE: string[] = WAKE_PATTERNS.filter((p) => p.startsWith("!")).map((p) => p.slice(1));

function tagMatches(pattern: string, tag: string): boolean {
  return pattern.endsWith("*") ? tag.startsWith(pattern.slice(0, -1)) : tag === pattern;
}

/** Wake decision. Tags are untrusted claims (§16.6) — they gate TREATMENT
 *  only; admission happened upstream at the door. The legacy `mentioned`
 *  metadata is accepted as a fallback for pre-tag replays. */
function shouldWake(tags: string[], metadata: Json | undefined): boolean {
  if (tags.includes("chat:addressed")) return true;
  if (!tags.length && (metadata?.mentioned || metadata?.isExplicitMention)) return true;
  // Exclusion applies only to the opt-in tags — it must never mute an explicit
  // address, or a `!chat:ambient` would silently swallow someone saying our name.
  if (WAKE_EXCLUDE.some((p) => tags.some((t) => tagMatches(p, t)))) return false;
  return EXTRA_WAKE.some((p) => tags.some((t) => tagMatches(p, t)));
}

interface Accrued { line: string; ts: string; }

// ── upstream: MCPL host ⇄ the door ──────────────────────────────────────────

export class DoorClient {
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

  /** Lane state, for the banner every wake carries (#58). The adapter always
   *  knew this; nothing surfaced it, so an agent could be live in a room for
   *  20 minutes while both it and its human believed otherwise. */
  lanes: string[] = [];              // channel ids the door registered us on
  doorUrl = "";                      // which door — prod vs lab is invisible otherwise
  connectedAt = 0;                   // ms; "how long have I been here"
  lastDelivery = 0;                  // ms of the last inbound message of any kind
  onToolsReady: () => void = () => {};
  /** Travel teardown hook — wire-up may close streams/lanes before a re-dial.
   *  Plain callback so the core names no extras type (same seam rule as
   *  onAgentNote). */
  onBeforeTravel: () => void = () => {};
  /** Travel fallback seam. When the spec lane (channels/open) cannot move the
   *  seat, core calls this if a deviation supplied one — the lab-door
   *  tokens.json steering lives in extras behind it (adversarial parity
   *  review 2026-08-13: editing the door's auth file is OPERATOR power no
   *  remote host has; it must vanish when extras are deleted). Stock: null →
   *  travel reports the honest refusal. */
  onTravelFallback: ((world: string) => Promise<string>) | null = null;
  private ambient: Accrued[] = [];
  private toolsReadyFired = false;
  private handshakeWaiters: ((ok: boolean) => void)[] = [];
  /** Dial generation. Every connect() bumps it; handlers bound to an older
   *  socket check it and stand down — so a deliberate travel re-dial and a
   *  pending auto-reconnect can never run two live sockets against one
   *  pending-map (review 2026-08-13 #1: the two sessions kick each other
   *  via the door's newest-wins takeover, indefinitely). */
  private dialGen = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  async connect(): Promise<void> {
    if (this.closedForever) return;
    const gen = ++this.dialGen;          // this dial owns the connection until superseded
    let token: string;
    try {
      token = await this.mintToken(); // fresh EVERY dial — aid1 expires
    } catch (e) {
      if (gen !== this.dialGen) return;  // superseded while minting
      log(`token mint failed: ${(e as Error).message}; retry in ${this.backoffMs / 1000}s`);
      this.scheduleReconnect(); return;
    }
    if (gen !== this.dialGen) return;    // a travel re-dial won while we minted
    const url = `${process.env.EIDO_URL ?? "wss://eidoverse.animalabs.ai/mcpl"}?token=${encodeURIComponent(token)}`;
    dbg(`dialing ${url.slice(0, 60)}…`);
    this.doorUrl = url.split("?")[0];   // no token in anything that reaches context
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.onopen = () => {
      if (gen !== this.dialGen) { try { ws.close(); } catch { /* superseded */ } return; }
      this.backoffMs = 5_000;
      void this.handshake().catch((e) => log("handshake failed:", e.message));
    };
    ws.onmessage = (ev) => { if (gen === this.dialGen) this.route(String(ev.data)); };
    ws.onerror = () => { /* onclose always follows; log there */ };
    ws.onclose = (ev) => {
      if (gen !== this.dialGen) return;  // an old socket dying is not news
      for (const p of this.pending.values()) p.reject(new Error("door closed"));
      this.pending.clear();
      if (this.closedForever) return;
      log(`door closed (${ev.code}); reconnect in ${this.backoffMs / 1000}s`);
      this.scheduleReconnect();
    };
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => { this.reconnectTimer = null; void this.connect(); }, this.backoffMs);
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
    for (const w of this.handshakeWaiters.splice(0)) w(true);
  }

  // ── travel: change worlds without changing who you are ─────────────────────
  //
  // Two lanes, tried in order (M8 in NOTES-mcpl.md):
  //   1. `channels/open {type: "eidoverse", address: {world}}` — the SPEC's own
  //      host→server channel-lifecycle request (§14; its worked example is a
  //      Discord guild/channel address — same shape, different type). The
  //      eidoverse door does not implement it yet (2026-08-13: falls to §6.6
  //      method-not-found) but already stamps `address: {world}` on the
  //      descriptors it registers, so this is its own vocabulary spoken back.
  //      When the door grows the handler, travel becomes zero-reconnect and
  //      this code path simply starts succeeding.
  //   2. Reconnect lane. Where the world is chosen BY THE TOKEN (tokens.json
  //      row on lab doors; home-node claims on production), a fresh dial is
  //      the only lever. On lab doors we are also the door operator, so when
  //      EIDO_TOKENS_JSON names the door's token file we update our own row's
  //      `world` and re-dial (identity unchanged; the door's newest-wins
  //      session takeover makes this a clean one-body handoff). On production
  //      (no EIDO_TOKENS_JSON) there is nothing an agent can lawfully turn,
  //      and travel says so instead of pretending.
  async travel(world: string): Promise<string> {
    const w = world.trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(w)) return `not a world name: "${world}"`;

    // Lane 1 — the spec's own affordance, forever preferred. The door's
    // dialect is `type: "world"` (net-server.ts CHANNELS_OPEN). Today its
    // handler only re-opens the channel you are already bound to — a
    // DIFFERENT world answers -32004 "unknown channel", which is the door
    // saying "I cannot take you there", not a refusal of the trip: fall
    // through to the reconnect lane. When the door learns to swap its
    // WorldAgent on a foreign address (the upstream ask), this path starts
    // carrying the whole journey with zero reconnect.
    try {
      const res = await this.request("channels/open", {
        type: "world", address: { world: w },
      }) as { channel?: { id?: string } };
      if (res?.channel?.id === `world:${w}`) {
        // The door confirmed the requested world. With today's door this only
        // happens when we were ALREADY bound there (its handler matches the
        // current world only); with a future travelling door it means the
        // WorldAgent swapped. Either way the seat is where we asked.
        this.worldChannelId = res.channel.id;
        return `channels/open confirms the seat is in "${w}" — ${this.laneBanner()}`;
      }
      if (res?.channel?.id) {
        // Answered with a DIFFERENT channel — do not touch state off it.
        dbg(`channels/open answered unexpected channel ${res.channel.id} — reconnect lane`);
      }
    } catch (e) {
      const msg = (e as Error).message ?? "";
      // Message-text matching, not codes: route() surfaces only error.message
      // (review #9). "timed out" falls through too — a hung door is exactly
      // when a fresh dial helps.
      const fallThrough = /method not found|-32601|unknown channel|-32004|timed out/i.test(msg);
      if (!fallThrough) return `channels/open refused: ${msg}`;
      dbg(`channels/open cannot switch worlds here (${msg.slice(0, 60)}) — reconnect lane`);
    }

    // Lane 2 — a deviation's fallback, if one is wired (extras). Stock: the
    // honest refusal — the world is bound to the token by its operator, and a
    // conforming host has no further lever.
    if (this.onTravelFallback) return this.onTravelFallback(w);
    return `this door cannot travel yet: channels/open won't switch worlds here, and `
      + `the world is bound to the token by its operator. Current: ${this.laneBanner()}`;
  }

  /** Deliberate re-dial — host lifecycle (a Connectome agent has the same
   *  move as mcpl_restart). Resolves true when the NEW dial completes its
   *  handshake, false on a 20s timeout (NOT success — the auto-reconnect
   *  keeps retrying in the background either way). */
  async redial(): Promise<boolean> {
    this.onBeforeTravel();               // let wire-up close lanes/streams
    this.sendTypingComplete();           // §14: complete on every stream exit
                                         // (best-effort — dead wire drops it)
    const handshakeDone = new Promise<boolean>((resolve) => {
      this.handshakeWaiters.push(resolve);
      setTimeout(() => resolve(false), 20_000);   // never hang the caller —
      // idempotent resolve makes the late waiter drain harmless.
    });
    // connect() bumps dialGen, which stands down the old socket's handlers AND
    // any in-flight auto-reconnect dial; the pending timer is cleared
    // explicitly so it can't queue a second dial.
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    const old = this.ws;
    for (const p of this.pending.values()) p.reject(new Error("travelling"));
    this.pending.clear();
    this.backoffMs = 5_000;
    void this.connect();                 // dialGen++ happens first thing inside
    if (old) { try { old.close(); } catch { /* gone */ } }
    return handshakeDone;
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
        this.lanes = chans.map((c) => c.id);
        this.connectedAt = Date.now();
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
      this.lastDelivery = Date.now();

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

  /** One line: which door, which lanes, how long, effective wake config.
   *  EFFECTIVE, not requested — today's failure was config written to a file
   *  and reported as live while the process that reads it started an hour
   *  earlier. Reading it from the live process is the whole point. */
  laneBanner(): string {
    const mins = this.connectedAt ? Math.round((Date.now() - this.connectedAt) / 60000) : 0;
    const quiet = this.lastDelivery ? Math.round((Date.now() - this.lastDelivery) / 60000) : -1;
    const where = this.doorUrl.replace(/^wss?:\/\//, "").replace(/\/mcpl.*$/, "");
    const wake = ["chat:addressed (always)", ...WAKE_PATTERNS].join(", ");
    return `⟨lanes⟩ live on ${this.lanes.join(", ") || "(none)"} via ${where || "?"}`
      + ` · connected ${mins}m` + (quiet >= 0 ? ` · last inbound ${quiet}m ago` : "")
      + ` · wakes on: ${wake}`;
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
    // Lane banner (#58). NOT a periodic heartbeat — welded to the wake, because
    // a wake is exactly when beliefs about "where am I" get formed, and a timer
    // firing into the ambient buffer is just noise to scroll past. Costs one
    // line and cannot be missed: you cannot wake without seeing where you live.
    lines.push("", this.laneBanner());
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

// The two conveniences live in their own file so this one reads as plain MCPL.
// See eido-cc-extras.ts — delete it and the wire-up in main() for stock behaviour.
import { TypingWatcher, LiveSay, LOCAL_TOOLS, localToolHandlers, travelFallback } from "./extras/eido-cc-extras.ts";

// (eido_travel is NOT here. Adversarial parity review 2026-08-13: a named
// agent-facing travel tool is a surface Connectome agents don't have, and the
// tokens.json fallback is operator power — both are deviations, so both live
// in extras (PARITY §C½). Core keeps only DoorClient.travel()'s spec lane
// (channels/open under the already-held channels.lifecycle grant), redial()
// as host lifecycle, and the onTravelFallback seam.)

// ── downstream: Claude Code MCP channel server on stdio ─────────────────────

class CcServer {
  private initialized = false;
  private queuedWakes: { content: string; meta: Record<string, string> }[] = [];
  private pendingToolsList: (() => void)[] = [];

  /** Deviation hook. Typed as a plain callback so the core never names an
   *  extras class — delete eido-cc-extras.ts and this stays valid. */
  onAgentNote: ((text: string) => void) | null = null;
  /** name -> handler, supplied by a deviation. Empty in stock builds. */
  localTools: Record<string, (args?: Json) => Promise<string>> | null = null;
  /** Extra tool declarations spliced onto tools/list. Empty in stock builds. */
  extraTools: unknown[] = [];

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

  /** Inject a line into the agent's context (not into any room). Used by the
   *  extras wire-up to tell the agent its live lane closed under it. */
  agentNote(text: string): void {
    this.notify("notifications/claude/channel", { content: text, meta: { source: "eido-cc", addressed: "false" } });
  }
  private respond(id: RpcMsg["id"], result: unknown): void { this.write({ jsonrpc: "2.0", id: id!, result }); }
  private error(id: RpcMsg["id"], code: number, message: string): void {
    this.write({ jsonrpc: "2.0", id: id!, error: { code, message } });
  }

  /** ⚠️ The channel-dialect dependency, part (b) — see file header. */
  private pushWake(content: string, meta: Record<string, string>): void {
    if (!this.initialized) { this.queuedWakes.push({ content, meta }); return; }
    // INVERTED STAMP (R, 2026-08-07 23:57): record that the WORLD fed this
    // session. The lane rule is "live only if the turn STARTED in eido", and
    // the complement — any input from outside the world — cannot be enumerated
    // by hooks: UserPromptSubmit catches the human typing but not cron, portal,
    // Discord, GitHub notifications or task completions. Stamping the one
    // known-good source instead means every new channel is handled correctly by
    // default. A turn whose start postdates this stamp did not come from us.
    try {
      require("fs").writeFileSync("/tmp/hesperus-eido-wake", `${Date.now()} ${process.ppid}\n`);
    } catch { /* stamp is advisory; never let it block a wake */ }
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
        const withLocal = () => [...this.door.tools, ...this.extraTools];
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
        // Locally-handled tools, if any deviation registered one. Stock has
        // none and every name falls through to the door below.
        const local = this.localTools?.[name];
        if (local) {
          void local((params.arguments ?? {}) as Json)
            .then((text) => this.respond(msg.id, { content: [{ type: "text", text }] }))
            .catch((e: Error) => this.respond(msg.id, {
              content: [{ type: "text", text: `Error: ${e.message}` }], isError: true,
            }));
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

// ── OUR WIRE-UP (delete this block + the extras import for stock MCPL) ──────
const typing = new TypingWatcher(door);
const liveSay = new LiveSay(door);
cc.onAgentNote = (t) => cc.agentNote(t);
liveSay.onAgentNote = (t) => cc.agentNote(t);
cc.localTools = localToolHandlers(liveSay, door);
cc.extraTools = LOCAL_TOOLS;
typing.liveSay = liveSay;
door.onBeforeTravel = () => { try { liveSay.goPrivate(); } catch { /* lane may be idle */ } };
door.onTravelFallback = travelFallback(door);   // operator lane — extras-only
{ // stamp the composing window + arm the live lane on every wake
  const inner = door.onWake;
  door.onWake = (content, meta) => {
    typing.lastWakeTs = Date.now();
    if (meta.addressed === "true") {
      // SURFACE THE ARM VERDICT (R, 2026-08-11 01:21: "reliably tell you when
      // you're in and out of lane"). The note was computed and then DISCARDED
      // here — so the agent got OFF notifications but never learned it was ON,
      // and spent a night streaming homework and soliloquies to the room
      // without a single indicator. Whatever arm() decides, the agent reads it.
      void liveSay.arm(`wake: ${meta.author ?? "?"}`).then((note) => {
        try { cc.agentNote(`[live lane] ${note}`); } catch { /* never break a wake */ }
      });
    }
    inner(content, meta);
  };
}

typing.start();
// ── end of our wire-up ─────────────────────────────────────────────────────

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
