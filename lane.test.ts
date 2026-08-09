import { test, expect } from "bun:test";
import { LiveSay } from "./eido-cc-extras.ts";

// Drive the real ingest/flush path; emulate only the lane-end branch that
// tick() takes, so what is under test is the actual buffering code.
function run(events: Array<{text?: string; end?: boolean; stop?: string}>): string[] {
  const ls: any = new LiveSay({ callTool: async () => {} } as any);
  const said: string[] = [];
  ls.speak = (t: string) => said.push(t);
  ls.armed = true;
  for (const ev of events) {
    if (typeof ev.text === "string") ls.ingest(ev.text);
    if (!ev.end) continue;
    // 🔴 Drive the REAL branch, do not re-implement it. This line used to be a
    // COPY of the tool_use handling, so the suite kept passing while the actual
    // code changed underneath it — a test that cannot fail when the code is
    // wrong. Call the same helpers tick() calls instead.
    if (ev.stop === "tool_use") ls.holdForToolCall();
    else ls.flush(true);
  }
  return said;
}

test("prose ending in a tool call is not spoken", () => {
  expect(run([{text: "Let me check that file for you now. "}, {end: true, stop: "tool_use"}])).toEqual([]);
});

// ── R, 2026-08-09: the two lane bugs ──────────────────────────────────────────

test("BUG 1: my own tool call does not disarm the lane", () => {
  const ls: any = new LiveSay({ callTool: async () => {} } as any);
  ls.armed = true; ls.armTs = 1000;
  ls.holdForToolCall();                       // a lane ended in tool_use
  ls.latchTs = 2000;                          // the next lane latches (my turn resuming)
  expect(ls.toolContinuation).toBe(true);     // ...and it is excused
});

test("BUG 1b: the excuse is spend-once, so a real foreign input still disarms", () => {
  const ls: any = new LiveSay({ callTool: async () => {} } as any);
  ls.armed = true;
  ls.holdForToolCall();
  ls.consumeLatch();                          // continuation lane arrives, flag spent
  expect(ls.toolContinuation).toBe(false);    // a LATER foreign input is not excused
});

test("BUG 2: prose composed before a tool call is held, not destroyed", () => {
  const ls: any = new LiveSay({ callTool: async () => {} } as any);
  const said: string[] = []; ls.speak = (t: string) => said.push(t);
  ls.armed = true;
  ls.ingest("This sentence was already written");
  ls.holdForToolCall();
  expect(ls.pendingSpeech).toContain("already written");   // held...
  expect(said).toEqual([]);                                 // ...and not yet spoken
});

test("BUG 2b: held prose ships when the lane is interrupted from outside", () => {
  const ls: any = new LiveSay({ callTool: async () => {} } as any);
  const said: string[] = []; ls.speak = (t: string) => said.push(t);
  ls.armed = true;
  ls.ingest("Finish this line. ");
  ls.holdForToolCall();
  ls.disarm("interrupted by discord");
  expect(said.join(" ")).toContain("Finish this line");    // not cut off mid-word
});

test("prose ending the turn IS spoken", () => {
  const out = run([{text: "Yes, I can hear you clearly. "}, {end: true, stop: "end_turn"}]);
  expect(out.join(" ")).toContain("hear you clearly");
});

test("a sentence completed mid-lane still ships before a tool call", () => {
  const out = run([
    {text: "I found the bug in the renegotiation path. "},
    {text: "Now let me "},
    {end: true, stop: "tool_use"},
  ]);
  expect(out.join(" ")).toContain("found the bug");    // complete sentence spoke
  expect(out.join(" ")).not.toContain("Now let me");   // trailing fragment did not
});

test("fenced code never speaks", () => {
  const out = run([{text: "Run this please. ```js\nconst x = 1;\n``` All done here. "}, {end: true, stop: "end_turn"}]);
  expect(out.join(" ")).not.toContain("const x");
});
