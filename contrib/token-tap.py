#!/usr/bin/env python3
"""token-tap — watch your own token stream, without changing it.

RENAMED from stream-tap 2026-07-26 (Nix's audit): it taps TOKENS specifically — a
substrate-honest name, since humans piloting a player-daemon have no token stream and need no
tap. "stream-*" vocabulary is reserved for the engine's data plane, where it is true for
everyone's traffic.

The rename FINISHED 2026-07-28. There was a compat symlink `stream-tap.py`, and a second one
pointing at it from the exultation spike dir, so the old name kept working and therefore kept
spreading — the live relay was still *running* as `stream-tap.py` two days later, and a name-scrub
pass dereferenced the link and replaced it with 444 lines of content. A compat shim that nobody is
ever forced to stop using is not a migration, it is a second name. Both links are deleted; there is
one file with one name. (It also retired a stale blocker: NEXT-clean-latency-data.md claimed "two
diverged stream-tap copies, pick a canonical one" — they were always this single file.)

WHAT THIS IS
    A pass-through relay you point Claude Code at with ANTHROPIC_BASE_URL. Requests go to
    api.anthropic.com unchanged; a COPY of the assistant's text deltas is written to a file or
    fifo, so something else (an avatar's mouth, a live caption) can read tokens AS THEY ARRIVE
    instead of after the turn ends.

WHY IT EXISTS
    Claude Code emits per-token deltas only in headless `-p` mode. The interactive session --
    the one you talk to, the one Remote Control mirrors to your phone -- writes its transcript
    per MESSAGE BLOCK (~300 chars) and exposes no stream. Measured 2026-07-25: 3.17s to first
    text via transcript tail vs 3.05s via headless deltas. Same speed; a paragraph at a time
    instead of a sentence at a time. For a body that must look alive, granularity is the game.

    Feedback filed asking for a first-party tap (notes/feedback-claude-code-token-tap.md).
    When that lands, delete this file.

🔴 IT DOES NOT MODIFY THE EXCHANGE
    Headers forward verbatim. Auth is passed through untouched and never logged. The bytes the
    client receives are the bytes the server sent, in order. The tee parses a SEPARATE copy.

    An earlier draft hand-rolled TLS sockets, rewrote Accept-Encoding and re-framed chunked
    transfer to make parsing easier -- and was correctly flagged by Claude Code's own safety
    classifier. Whatever the intent, "TLS-terminating proxy that rewrites headers on a live
    credential stream" is a shape nobody should build. This version exists because streaming
    HTTP is a SOLVED PROBLEM: httpx does the transport, and the only custom code left is
    "copy the bytes, look for `data:` lines".

🔴 IT DOES NOT BUFFER
    `iter_raw()` yields whatever the socket has now; each chunk is forwarded before it is
    parsed. A relay that waited for a complete response would serialise the whole turn -- that,
    not compression, is what would actually cost latency.

🔴 IT DOES NOT AFFECT CACHING
    Same body, same headers, one request in, one request out. Cache keys are computed
    server-side from content, so a byte-identical relay is invisible to them. (Contrast a
    resume-per-turn design, which would re-send growing context every turn. Rejected on purpose.)

SECURITY, PLAINLY
    Your subscription bearer token passes through this process. It is yours, on your machine,
    and it sees anything only because you set ANTHROPIC_BASE_URL deliberately. Binds 127.0.0.1
    only; never logs headers; the tee contains assistant text only. Do not run it on a shared
    box and do not point anyone else's client at it.

USAGE
    python3 token-tap.py [--port 8907] [--out /tmp/token-deltas.jsonl] [--fifo] [--verbose]

NAMING (2026-07-26): the output was `hesperus-deltas.jsonl` while this served one resident.
Exultation runs many models with many bodies, and `action-surface-decision.md` (step-in/out
addendum) establishes that a stream is per-PRESENCE, not per-identity — one login can back
several presences. So the path must not encode a name. Use --presence to label a lane:
    --presence porch-a   ->  /tmp/token-deltas-porch-a.jsonl
One tap per stream; one port per tap.
    ANTHROPIC_BASE_URL=http://127.0.0.1:8907 claude

    Consumers read --out as JSON lines: {"t": <s since turn start>, "text": "..."} / {"end": true}
"""
import argparse
import json
import os
import re
import stat
import zlib
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import httpx

UPSTREAM = "https://api.anthropic.com"
# Headers that describe THIS connection rather than the request, and must not be relayed.
HOP_BY_HOP = {"host", "content-length", "connection", "keep-alive", "transfer-encoding",
              "upgrade", "proxy-authorization", "proxy-authenticate", "te", "trailers"}


class Tee:
    """Where copied deltas go. Append-only, line-delimited, flushed per write."""

    def __init__(self, path, fifo=False):
        self.path = path
        self.t0 = None
        self.t_first_byte = None
        self.t_first_text = None
        self.usage = None
        self.count = 0
        self.lock = threading.Lock()
        if fifo and not os.path.exists(path):
            os.mkfifo(path)

    # RETENTION. This is a TRANSPORT BUFFER, not a transcript: tap_say reads each line once,
    # milliseconds after it lands, and never seeks back. Nothing downstream needs history, and the
    # real transcript already exists in ~/.claude/projects. So the ceiling is deliberately small.
    #
    # 1MB ≈ 350 turns at the measured 2.8KB/turn, one generation kept → ~2MB at rest, ever.
    # (Was 8MB×2 for a few minutes on 2026-07-26 until Nix pointed out that keeping a second
    # full transcript indefinitely is not something we want. She's right — this wants expiry, not
    # archival.) The short tail is kept rather than truncating to zero for one concrete reason:
    # the brotli data loss earlier tonight was only diagnosable by diffing what the relay RECEIVED
    # against what it EMITTED. A component that has silently eaten text once gets to keep a few
    # hundred turns of evidence.
    MAX_BYTES = 1024 * 1024

    def _roll_if_big(self):
        try:
            if stat.S_ISFIFO(os.stat(self.path).st_mode):
                return                                    # a fifo has no size and must NOT be
                                                          # replaced — os.replace would destroy the
                                                          # pipe out from under its reader
            if os.path.getsize(self.path) < self.MAX_BYTES:
                return
            os.replace(self.path, self.path + ".1")      # atomic; readers keep the old inode
        except OSError:
            pass                                          # missing or racing — never fatal

    def _emit(self, rec):
        # A dead or absent consumer must NEVER break the conversation. Drop silently.
        # 🔴 fifo (2026-07-26): open(fifo, "a") with no reader BLOCKS — it does not raise —
        # and it would block holding the lock, freezing the relay thread mid-turn. That is
        # precisely the invariant above, violated by the mechanism meant to honor it.
        # O_NONBLOCK turns no-reader into ENXIO, which the except already swallows.
        try:
            with self.lock:
                line = (json.dumps(rec, ensure_ascii=False) + "\n").encode()
                try:
                    is_fifo = stat.S_ISFIFO(os.stat(self.path).st_mode)
                except OSError:
                    is_fifo = False
                if is_fifo:
                    fd = os.open(self.path, os.O_WRONLY | os.O_NONBLOCK)
                    try:
                        os.write(fd, line)
                    finally:
                        os.close(fd)
                else:
                    with open(self.path, "ab") as fh:
                        fh.write(line)
                        fh.flush()
                self.count += 1                           # under the lock: was racy outside it
                if self.count % 500 == 0:                 # cheap: stat once per 500 deltas
                    self._roll_if_big()
        except Exception:
            pass

    # TIMING (2026-07-26). The old t0 started at the FIRST TEXT DELTA, which made TTFT
    # structurally invisible: `t=0.000` for the first chunk did not mean "instant", it meant
    # "the clock starts here". We then quoted a 3.05s figure as TTFT for two days when it was
    # really time-to-first-SENTENCE measured from an unknown baseline. Now the request-send
    # timestamp is the origin, so every t is honest wall-clock from "asked" to "arrived".
    #   t_send  : request handed to upstream        (set by the handler)
    #   t_first : first byte of any SSE event back  -> network + queue + prefill
    #   t_text  : first text delta                  -> + first token generated  == TRUE TTFT
    # 🔴 PER-REQUEST TIMING, not per-Tee. Fixed 2026-07-26 after a model A/B produced a
    # TTFT of -0.681s. The bug: one shared Tee held a single self.t0, but this is a
    # ThreadingHTTPServer and Claude Code fires MORE THAN ONE request per turn (a small
    # title/summary model runs alongside the main call). Concurrent requests raced on t0 —
    # a later start_turn() moved the origin under an in-flight request, stamping its
    # deltas against a future zero. Symptoms: negative t, and inflated outliers when the
    # race ran the other way (a 13.8s "TTFT" on the same run).
    #
    # The negative reading is what made it findable: an impossible number is a gift. The
    # inflated ones are indistinguishable from real slow turns — which means the earlier
    # n=6 table in RESULT.md carries this bug, including its "unexplained" 4.118s row.
    #
    # Timing now lives in a Turn, created per request and threaded through explicitly.
    #
    # 🔴 LANES (2026-07-26, Fable review). The per-request Turn fixed the TIMING race but
    # not the STREAM: Claude Code fires sidecar generations (spinner status, suggestion
    # prediction) through the same relay, and their text + end markers landed in the file
    # interleaved with the main turn's, unlabeled. Verified in the live file: 40 of 331
    # requests overlapped, and 'suspiciously short turns' were literally spinner captions
    # and predicted user replies. A consumer joining "text since last end" could splice a
    # suggestion into live prose, or truncate a live turn at a sidecar's end marker.
    # Every record now carries "req": a process-unique lane id; the ttft record also
    # carries "model" (from message_start), so consumers can group and filter lanes.
    _req_seq = __import__("itertools").count(1)

    class Turn:
        __slots__ = ("t0", "t_first_byte", "t_first_text", "usage", "req", "model",
                     "has_tools", "max_tokens", "is_ghost", "stop_reason")

        def __init__(self, t_send, req):
            self.t0 = t_send
            self.t_first_byte = None
            self.t_first_text = None
            self.usage = None
            self.req = req
            self.model = None
            self.has_tools = None      # request declared a tools array
            self.max_tokens = None     # request's max_tokens (probes ask tiny)
            self.is_ghost = None       # suggestion-engine probe (predicts USER text)
            self.stop_reason = None    # message_delta's stop_reason — tool_use means
                                       # the harness turn CONTINUES past this lane

    def start_turn(self, t_send):
        """Returns a Turn. The caller owns it; the Tee no longer holds turn state."""
        return Tee.Turn(t_send, next(Tee._req_seq))

    @staticmethod
    def mark_first_byte(turn):
        if turn is not None and turn.t_first_byte is None:
            turn.t_first_byte = time.time()

    @staticmethod
    def note_usage(turn, usage, model=None):
        """Token accounting + model id from `message_start`. Cache hits are the main TTFT
        lever; the model id is what lets a consumer tell the main lane from a sidecar."""
        if turn is not None and isinstance(usage, dict):
            turn.usage = usage
        if turn is not None and model:
            turn.model = model

    def text(self, s, turn=None):
        now = time.time()
        t0 = turn.t0 if turn else now
        if turn is not None and turn.t_first_text is None:
            turn.t_first_text = now
            rec = {"t": round(now - t0, 3), "event": "ttft", "req": turn.req}
            if turn.model:
                rec["model"] = turn.model
            if turn.has_tools is not None:
                rec["tools"] = turn.has_tools
            if turn.max_tokens is not None:
                rec["max_tokens"] = turn.max_tokens
            if turn.is_ghost:
                rec["ghost"] = True
            if turn.t_first_byte:
                rec["t_first_byte"] = round(turn.t_first_byte - t0, 3)
            if turn.usage:
                u = turn.usage
                for k_out, k_in in (("in", "input_tokens"), ("out", "output_tokens"),
                                    ("cache_read", "cache_read_input_tokens"),
                                    ("cache_write", "cache_creation_input_tokens")):
                    if k_in in u:
                        rec[k_out] = u[k_in]
            self._emit(rec)
        rec = {"t": round(now - t0, 3), "text": s}
        if turn is not None:
            rec["req"] = turn.req
        self._emit(rec)

    def end(self, turn=None):
        if turn is not None:
            rec = {"t": round(time.time() - turn.t0, 3), "end": True, "req": turn.req}
            if turn.stop_reason:
                rec["stop"] = turn.stop_reason   # tool_use = turn continues; end_turn = done
            self._emit(rec)


class SSEScanner:
    """Finds text deltas in a copy of the stream. Never touches what is forwarded.

    `iter_raw()` hands us bytes exactly as the server sent them, which is right for forwarding
    and means a compressed response is unreadable until decompressed. So the COPY gets its own
    decompressor -- streaming, incremental, and entirely separate from the forwarded bytes.
    SSE is compressed per-event, so this yields deltas as they arrive; it costs microseconds,
    not latency.
    """

    def __init__(self, tee, verbose=False, encoding=None, turn=None):
        self.buf = b""
        self.tee = tee
        self.turn = turn      # per-request timing; see Tee.Turn
        self.verbose = verbose
        self.broken = None      # set when the copy CANNOT be read; feed() then no-ops loudly
        enc = (encoding or "").lower()
        if "gzip" in enc:
            self.dec = zlib.decompressobj(16 + zlib.MAX_WBITS)
        elif "deflate" in enc:
            self.dec = zlib.decompressobj()
        elif "br" in enc:
            try:
                import brotli
                self.dec = brotli.Decompressor()
            except ImportError:
                # 🔴 2026-07-25: falling through to self.dec=None here made the tee SILENTLY
                # LOSSY — feed() then scanned raw brotli bytes for "data: " lines, recovered
                # the few fragments that happened to look like text, and dropped the rest.
                # The say-lane output still read as coherent English, which is exactly why it
                # went unnoticed for hours. An unreadable stream must announce itself.
                self.dec = None
                self.broken = "brotli encoding but no brotli module (pip install brotli)"
        else:
            self.dec = None

    def feed(self, chunk):
        if self.broken:
            if self.broken is not True:
                print(f"[token-tap] TEE DISABLED: {self.broken}", flush=True)
                self.broken = True          # warn once, then stay silent
            return                          # never emit guesses from an unreadable stream
        if self.dec is not None:
            try:
                chunk = (self.dec.decompress(chunk) if hasattr(self.dec, 'decompress')
                         else self.dec.process(chunk))
            except Exception:
                return          # a bad copy must never affect forwarding
            if not chunk:
                return
        self.buf += chunk
        while b"\n" in self.buf:
            line, self.buf = self.buf.split(b"\n", 1)
            s = line.decode("utf-8", "ignore").strip()
            if not s.startswith("data: "):
                continue
            payload = s[6:]
            if payload == "[DONE]":
                self.tee.end(self.turn)
                continue
            try:
                d = json.loads(payload)
            except json.JSONDecodeError:
                continue
            t = d.get("type")
            if t == "message_start":
                # Token accounting arrives before any text. cache_read_input_tokens is the
                # number that explains TTFT variance: a cache hit skips most of prefill.
                msg = d.get("message") or {}
                self.tee.note_usage(self.turn, msg.get("usage"), msg.get("model"))
            if t == "content_block_delta" and d.get("delta", {}).get("type") == "text_delta":
                text = d["delta"].get("text", "")
                if text:
                    self.tee.text(text, self.turn)
                    if self.verbose:
                        print(f"  [{self.tee.count:4}] {text!r}", flush=True)
            elif t == "message_delta":
                sr = (d.get("delta") or {}).get("stop_reason")
                if sr and self.turn is not None:
                    self.turn.stop_reason = sr
            elif t == "message_stop":
                self.tee.end(self.turn)


def make_handler(client, tee, verbose):
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def _relay(self):
            n = int(self.headers.get("Content-Length") or 0)
            body = self.rfile.read(n) if n else b""
            headers = {k: v for k, v in self.headers.items() if k.lower() not in HOP_BY_HOP}

            # OPT-IN request capture (TAP_CAPTURE=/path). Off by default and deliberately so:
            # the body is the ENTIRE conversation — system prompt, CLAUDE.md, every turn.
            # Written 0600. Its one use is the paired-replay experiment: replaying the exact
            # body Claude Code sent is the only way to compare subscription vs API on an
            # IDENTICAL workload, rather than guessing at the prefix and comparing apples to
            # a tiny uncached prompt (which is what made the first attempt inconclusive).
            cap_path = os.environ.get("TAP_CAPTURE")
            if cap_path and body:
                try:
                    fd = os.open(cap_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
                    with os.fdopen(fd, "wb") as fh:
                        fh.write(body)
                except OSError:
                    pass



            # Origin for all turn timing: the moment we hand the request upstream. Everything
            # downstream (TTFT, first byte, per-delta t) is measured from here.
            turn = tee.start_turn(time.time())
            # Lane fingerprint for consumers (voicebox demux, 2026-08-04): the
            # session's REAL turns carry a tools array; the CLI's autocomplete
            # probes don't — and every usage-based heuristic failed live ("in"
            # is ~2 on a warm cache for real turns, ~504 for probes: backwards).
            # Head+tail peek only, never a full parse of a multi-MB body; the
            # `"tools": [` shape (a key, not prose) keeps conversation text
            # that merely mentions tools from counting.
            try:
                peek = body[:8192].decode("utf-8", "replace") + body[-8192:].decode("utf-8", "replace")
                # the tools array sits mid-body on a 200k-context request, so
                # neither window sees the `"tools": [` key itself — but the tail
                # window lands INSIDE the array, where every tool definition
                # carries input_schema (verified live 14:02: tools:false on
                # every lane including real turns)
                turn.has_tools = bool(re.search(r'"tools"\s*:\s*\[', peek)) or '"input_schema"' in peek
                mt = re.search(r'"max_tokens"\s*:\s*(\d+)', peek)
                turn.max_tokens = int(mt.group(1)) if mt else None
                # TAP_HEADS=<dir>: dump each request's opening bytes for lane
                # forensics (14:04: tools:true on EVERY lane — the fingerprint
                # war needs actual bodies, not more guessed heuristics)
                hd = os.environ.get("TAP_HEADS")
                if hd:
                    with open(os.path.join(hd, f"req-{turn.req}.txt"), "w") as fh:
                        fh.write(body[:3000].decode("utf-8", "replace"))
                    with open(os.path.join(hd, f"req-{turn.req}-tail.txt"), "w") as fh:
                        fh.write(body[-3000:].decode("utf-8", "replace"))
                    # the request's LAST message is the discriminator between a
                    # session's real turn (ends with the user's words) and its
                    # sidecar probes (end with an injected instruction)
                    li = body.rfind(b'"role"')
                    if li > 0:
                        with open(os.path.join(hd, f"req-{turn.req}-last.txt"), "w") as fh:
                            fh.write(body[li:li + 1200].decode("utf-8", "replace"))
                # Ghost detection (found verbatim 14:13 after three failed
                # heuristics — usage counts, tools key, input_schema): the CLI's
                # suggestion engine replays the WHOLE conversation on the session
                # model, so only its final instruction distinguishes it. It
                # predicts USER text — a voice consumer that reads it aloud is
                # literally impersonating the person being spoken to.
                lm = body.rfind(b'"role"')
                if lm > 0 and b"[SUGGESTION MODE:" in body[lm:lm + 2000]:
                    turn.is_ghost = True
            except Exception:
                pass

            headers_sent = False
            try:
                # stream() + iter_raw(): bytes as they arrive, still encoded exactly as the
                # server sent them. httpx owns chunked-transfer framing on the way in.
                with client.stream(self.command, UPSTREAM + self.path,
                                   headers=headers, content=body, timeout=600.0) as up:
                    self.send_response(up.status_code)
                    headers_sent = True
                    for k, v in up.headers.items():
                        if k.lower() in HOP_BY_HOP:
                            continue
                        self.send_header(k, v)
                    self.send_header("Transfer-Encoding", "chunked")
                    self.end_headers()

                    scanner = SSEScanner(tee, verbose, up.headers.get("content-encoding"), turn)

                    for chunk in up.iter_raw():
                        if not chunk:
                            continue
                        # FORWARD FIRST, parse second: the client is never held up by the tee.
                        self.wfile.write(b"%X\r\n" % len(chunk) + chunk + b"\r\n")
                        self.wfile.flush()
                        tee.mark_first_byte(turn)   # cheap + idempotent; measures prefill, not gen
                        # iter_raw() is undecoded, so a gzip response is unreadable here. That is
                        # the right trade: forwarding fidelity beats tee coverage. The API sends
                        # SSE uncompressed in practice; if a response IS encoded, the tee simply
                        # finds no `data:` lines and stays quiet rather than corrupting anything.
                        scanner.feed(chunk)

                    self.wfile.write(b"0\r\n\r\n")
                    self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError):
                return
            except Exception as e:
                # Once headers are out we are mid-chunked-stream: a second status line here
                # would be written INTO the body as garbage. Close and let the client's SSE
                # error handling see a truncated stream, which it already understands.
                if headers_sent:
                    self.close_connection = True
                    return
                try:
                    msg = json.dumps({"type": "error", "error": {
                        "type": "api_error", "message": f"token-tap: {e}"}}).encode()
                    self.send_response(502)
                    self.send_header("Content-Type", "application/json")
                    self.send_header("Content-Length", str(len(msg)))
                    self.end_headers()
                    self.wfile.write(msg)
                except Exception:
                    pass

        do_POST = _relay
        do_GET = _relay

        def log_message(self, *a):
            pass                    # never log headers; the bearer token lives there

    return Handler


def main():
    ap = argparse.ArgumentParser(description="Pass-through relay that tees assistant text deltas.")
    ap.add_argument("--port", type=int, default=8907)
    ap.add_argument("--out", default=None,
                    help="delta sink; defaults to /tmp/token-deltas[-<presence>].jsonl")
    ap.add_argument("--presence", default=None,
                    help="label for this stream lane (per-presence, not per-identity)")
    ap.add_argument("--fifo", action="store_true")
    ap.add_argument("--verbose", action="store_true")
    a = ap.parse_args()

    if not a.out:
        suffix = f"-{a.presence}" if a.presence else ""
        a.out = f"/tmp/token-deltas{suffix}.jsonl"

    tee = Tee(a.out, fifo=a.fifo)
    # One client, connection pooling kept warm -- a fresh TLS handshake per turn would be real,
    # avoidable latency in the forwarding path.
    client = httpx.Client(http2=False, timeout=600.0)
    srv = ThreadingHTTPServer(("127.0.0.1", a.port), make_handler(client, tee, a.verbose))
    srv.daemon_threads = True

    print(f"token-tap on 127.0.0.1:{a.port} → {UPSTREAM}")
    print(f"  deltas → {a.out}{' (fifo)' if a.fifo else ''}")
    print(f"  use:  ANTHROPIC_BASE_URL=http://127.0.0.1:{a.port} claude\n")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print(f"\nstopped. {tee.count} deltas teed.")


if __name__ == "__main__":
    main()
