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
    if (ev.stop === "tool_use") { ls.buf = ""; ls.raw = ""; ls.inFence = false; }
    else ls.flush(true);
  }
  return said;
}

test("prose ending in a tool call is not spoken", () => {
  expect(run([{text: "Let me check that file for you now. "}, {end: true, stop: "tool_use"}])).toEqual([]);
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
