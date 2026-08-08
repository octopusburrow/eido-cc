/** Live-lane arm/disarm state machine — defects B, G, H.
 *
 *  The three interact, which is how H hid: G refuses a mid-turn wake, B needs
 *  that same wake's QUEUED turn to still be live, and H was `armTs` doing both
 *  jobs so a refusal read as a queued wake and stayed live into the tether's
 *  next turn.
 *
 *  Mirrors LiveSay's logic (same shape as wake-test.ts — reimplement, assert). */

class Lane {
  armed = false;
  armTs = 0;
  pendingWakeTs = 0;
  latchTs = 0;          // when the CURRENT main-lane turn latched
  lastMainActivity = 0;
  stampM = 0;           // turn-end stamp mtime
  wakeM = 0;            // INVERTED STAMP: last time the world fed us
  now = 1000;
  log: string[] = [];

  tick(ms = 10) { this.now += ms; }

  /** A wake arrives from the door. */
  arm(reason: string) {
    // inverted stamp: a turn that latched after the last wake is not ours
    if (reason !== "eido_live" && this.latchTs > 0 && this.latchTs > this.wakeM) {
      this.pendingWakeTs = this.now;          // defect B: its turn is still coming
      this.log.push(`refused-outside(${reason})`);
      return;
    }
    if (this.armed) {
      // extend this turn AND grant one bounded follow-on (B), which end_turn
      // consumes exactly once (H: cannot be held open indefinitely).
      this.armTs = this.now; this.pendingWakeTs = this.now;
      this.log.push(`extend(${reason})`); return;
    }
    // Defect G: a wake delivered mid-turn must not arm — that turn is the
    // tether's. Idle test: turn-end stamp must postdate main-lane activity.
    if (reason !== "eido_live" && this.lastMainActivity > 0 && this.lastMainActivity > this.stampM) {
      this.pendingWakeTs = this.now;            // defect B: its turn IS queued
      this.log.push(`refused-pending(${reason})`);
      return;
    }
    this.armTs = this.now;
    this.armed = true;
    this.log.push(`ARMED(${reason})`);
  }

  /** The world delivers a wake — stamps that WE fed the session. */
  pushWake() { this.wakeM = this.now; }

  /** The main lane starts producing tokens (a turn began). */
  latch() { this.latchTs = this.lastMainActivity = this.now; }

  /** end_turn on the main lane. */
  endTurn() {
    if (this.pendingWakeTs > this.latchTs) {
      this.pendingWakeTs = 0;
      this.armTs = this.now;
      this.log.push("stay-armed(queued wake)");
      return;
    }
    this.disarm("end_turn");
  }

  disarm(reason: string) {
    this.pendingWakeTs = 0;
    if (!this.armed) return;
    this.armed = false;
    this.log.push(`disarm(${reason})`);
  }
}

let pass = 0, fail = 0;
const ck = (n: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log((ok ? "  ✓ " : "  ✗ ") + n + (ok ? "" : `  [got ${JSON.stringify(got)}, want ${JSON.stringify(want)}]`));
  ok ? pass++ : fail++;
};

// ── 1. the ordinary case: idle, wake arrives, we speak, turn ends ───────────
{
  const L = new Lane();
  L.stampM = L.now;              // idle: last turn ended
  L.tick(); L.arm("eido wake");
  ck("idle wake arms", L.armed, true);
  L.tick(); L.latch();           // our reply begins
  L.tick(); L.endTurn();
  ck("turn end disarms", L.armed, false);
}

// ── 2. defect G: a wake mid-TETHER-turn must not arm ────────────────────────
{
  const L = new Lane();
  L.stampM = 500;                // last turn ended a while ago
  L.tick(); L.latch();           // the TETHER's turn is running now
  L.tick(); L.arm("eido wake mid-turn");
  ck("mid-turn wake does NOT arm (G)", L.armed, false);
  ck("  ...but is recorded as pending (B)", L.pendingWakeTs > 0, true);
}

// ── 3. defect B: the refused wake's queued turn MUST be live ────────────────
{
  const L = new Lane();
  L.stampM = 500;
  L.tick(); L.latch();                     // tether turn running
  L.tick(); L.arm("sill says hello");      // refused, pending
  L.tick(); L.endTurn();                   // tether turn ends
  ck("queued wake keeps the lane armed (B)", L.armed, false);   // not yet armed…
  ck("  ...pending consumed at end_turn", L.pendingWakeTs, 0);
  ck("  ...and the log shows it stayed for the queued wake",
     L.log.includes("stay-armed(queued wake)"), true);
}

// ── 4. defect H: a REFUSED wake must not keep us live into the NEXT turn ────
//    This is the bug R hit: "it keeps putting my lines out live no matter
//    whether eido pinged me". Pre-fix, arm() stamped armTs before refusing,
//    so `armTs > latchTs` was true and the lane stayed armed for a turn that
//    belonged to the tether.
{
  const L = new Lane();
  L.stampM = L.now;
  L.tick(); L.arm("eido wake");            // legitimately armed
  ck("armed for the wake", L.armed, true);
  L.tick(); L.latch();                     // our reply
  L.tick(); L.endTurn();                   // ends cleanly
  ck("disarmed after the reply", L.armed, false);

  // now the tether types. a wake lands mid-turn and is refused.
  // (stamp must PRE-date the latch — that is what "a turn is running" means)
  L.tick(); L.stampM = L.now; L.tick(); L.latch();   // tether turn begins
  L.tick(); L.arm("mid-turn wake");        // refused → pending
  ck("refused mid-tether-turn", L.armed, false);
  L.tick(); L.endTurn();
  // the pending wake DOES have a queued turn, so staying armed is correct here.
  ck("pending consumed", L.pendingWakeTs, 0);

  // …but a refusal with NO queued turn (pending older than the latch) must not.
  const M = new Lane();
  M.stampM = 500;
  M.tick(); M.pendingWakeTs = M.now;       // a stale pending from earlier
  M.tick(); M.latch();                     // a NEW tether turn starts after it
  M.tick(); M.endTurn();
  ck("stale pending does NOT keep the lane armed (H)", M.armed, false);
  ck("  ...and is cleared", M.pendingWakeTs, 0);
}

// ── 5. eido_out mid-turn clears pending too ─────────────────────────────────
{
  const L = new Lane();
  L.stampM = 500;
  L.tick(); L.latch();
  L.tick(); L.arm("wake");                 // pending
  L.tick(); L.disarm("eido_out tool");
  ck("eido_out clears pending", L.pendingWakeTs, 0);
  L.tick(); L.endTurn();
  ck("  ...so end_turn cannot resurrect the lane", L.armed, false);
}

// ── 6. an accepted wake mid-live-turn extends rather than re-arming ─────────
{
  const L = new Lane();
  L.stampM = L.now;
  L.tick(); L.arm("first wake");
  const t0 = L.armTs;
  L.tick(50); L.arm("second wake while live");
  ck("second wake extends armTs", L.armTs > t0, true);
  ck("  ...and does not double-arm", L.log.filter((x) => x.startsWith("ARMED")).length, 1);
}

// ── 7. defect H, the DAMAGING sequence (R's symptom) ───────────────────────
//    Not a refused wake — an ACCEPTED one arriving mid-reply. It extends armTs
//    (correct: we are live). Pre-fix, end_turn then read `armTs > latchTs` as
//    "a wake is queued" and stayed armed into the tether's next turn.
//    This is the common case in an active room: someone speaks while I am
//    mid-sentence.
{
  const L = new Lane();
  L.stampM = L.now;
  L.tick(); L.arm("eido wake");                 // genuinely armed
  L.tick(); L.latch();                          // our reply latches
  L.tick(); L.arm("another wake mid-reply");    // extends armTs — we ARE live
  L.tick(); L.endTurn();
  ck("H: stays armed for the ONE queued turn (B)", L.armed, true);
  L.tick(); L.latch();                          // that queued turn runs
  L.tick(); L.endTurn();                        // and ends
  ck("H: released after it — not held open (H)", L.armed, false);
  ck("H: pending fully consumed", L.pendingWakeTs, 0);
}

// ── 8. a wake refused mid-turn does not claim a queued wake either ─────────
{
  const L = new Lane();
  L.stampM = 500;
  L.tick(); L.latch();
  L.tick(); L.arm("wake mid-tether-turn");      // refused → pending
  L.tick(); L.endTurn();
  ck("refused wake: lane not armed", L.armed, false);
}

// ── 9. INVERTED STAMP: a turn from outside the world never goes live ───────
//    The rule the hooks could not express: cron, portal, Discord, GitHub and
//    task notifications are all "outside", and enumerating them is a losing
//    game. Stamp the ONE known-good source instead.
{
  const L = new Lane();
  L.stampM = L.now;
  L.tick(); L.pushWake();                 // world feeds us
  L.tick(); L.arm("eido wake");
  ck("wake-started turn arms", L.armed, true);
  L.tick(); L.latch(); L.tick(); L.endTurn();

  // now a CRON turn — no wake, no terminal typing, nothing UserPromptSubmit sees
  L.tick(); L.stampM = L.now; L.tick(); L.latch();
  L.tick(); L.arm("some other wake");
  ck("cron/portal/task turn does NOT arm", L.armed, false);
  ck("  ...refused as outside, not as mid-turn",
     L.log.includes("refused-outside(some other wake)"), true);
}

// ── 9b. the case ONLY the inverted stamp catches ───────────────────────────
//    A cron/portal/task turn that begins from a genuinely IDLE session: the
//    turn-end stamp postdates the last main activity, so defect G's idle test
//    sees "idle, fine to arm" and waves it through. Nothing about the input
//    said "eidoverse" — only the absence of our own wake-stamp does.
{
  const L = new Lane();
  L.tick(); L.pushWake();                 // a wake, long ago
  L.tick(); L.arm("eido wake"); L.tick(); L.latch(); L.tick(); L.endTurn();
  // The genuinely idle case: latch happens, THEN the turn-end stamp lands after
  // it (a completed prior turn), so G's `lastMainActivity > stampM` is FALSE —
  // it sees an idle session and waves the arm through. Only the missing
  // wake-stamp distinguishes this cron turn from an eido one.
  L.tick(); L.latch();                    // CRON turn latches
  L.tick(); L.stampM = L.now;             // ...and a turn-end stamp postdates it
  L.tick(); L.arm("cron wake");
  ck("idle-start cron turn refused (stamp-only catch)", L.armed, false);
}

// ── 10. eido_live still overrides — the deliberate escape hatch ─────────────
{
  const L = new Lane();
  L.stampM = 500;
  L.tick(); L.latch();                    // a turn from outside is running
  L.tick(); L.arm("eido_live");           // explicit call
  ck("eido_live overrides the outside-turn refusal", L.armed, true);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
