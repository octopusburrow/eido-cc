// Logging, extracted so eido-cc-extras.ts can import it without pulling in the
// whole host. It previously imported log/dbg from eido-cc.ts, which executes
// the wire-up block at module load — so `import { LiveSay }` booted a real MCPL
// client, and the extras were untestable in isolation (2026-08-08).
const LOG_PATH = process.env.EIDO_LOG;

export const log = (...a: unknown[]) => {
  const line = `[eido-cc ${new Date().toISOString().slice(11, 19)}] ` +
    a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ");
  console.error(line);
  if (LOG_PATH) { try { require("fs").appendFileSync(LOG_PATH, line + "\n"); } catch {} }
};
export const dbg = (...a: unknown[]) => { if (process.env.EIDO_DEBUG) log(...a); };
