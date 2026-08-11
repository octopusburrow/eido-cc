import { test, expect } from "bun:test";
import { LiveSay } from "./eido-cc-extras.ts";

function chunksFor(text: string, deltaSize = 7): string[] {
  const ls: any = new LiveSay({ callTool: async () => {} } as any);
  const said: string[] = [];
  ls.speak = (t: string) => said.push(t);
  for (let i = 0; i < text.length; i += deltaSize) ls.ingest(text.slice(i, i + deltaSize));
  ls.flush(true);
  return said;
}

test("abbreviations do not split", () => {
  const c = chunksFor("I met Dr. Smith at the lab and we talked for an hour about it. Then I left.");
  expect(c.some(x => x.trim().endsWith("Dr."))).toBe(false);
});

test("initials do not split", () => {
  const c = chunksFor("The author is J. R. R. Tolkien and he wrote quite a lot of books here. Done.");
  expect(c.some(x => x.trim().endsWith("J.") || x.trim().endsWith("R."))).toBe(false);
});

test("a long opener gets clause-split", () => {
  const long = "The sender track is ended which means it is dead rather than merely silent, and no renegotiation will ever revive it because an ended track cannot produce media again. Right.";
  const c = chunksFor(long);
  expect(c.length).toBeGreaterThan(1);          // it MUST break, not run 175 chars
  for (const x of c) expect(x.length).toBeLessThan(140);
  expect(c[0].trim().endsWith("and")).toBe(false);   // split BEFORE the conjunction
});

test("short sentences are never chopped at commas", () => {
  const c = chunksFor("Yes, I can hear you. Good, that works.");
  expect(c.length).toBe(2);
});

test("unpunctuated run breaks at a conjunction, never mid-word", () => {
  const src = "This is a reasonably long sentence about audio debugging that runs on for a while without any punctuation at all so it must break somewhere sensible";
  const c = chunksFor(src);
  expect(c.length).toBeGreaterThan(1);
  expect(c.join(" ").replace(/\s+/g, " ")).toBe(src);   // nothing lost, nothing duplicated
  for (const x of c) expect(src).toContain(x.trim());    // every chunk is a real substring
});

test("fenced code never speaks", () => {
  const c = chunksFor("Run this now please. ```js\nconst x = 1;\n``` That is all done.");
  expect(c.join(" ")).not.toContain("const x");
});
