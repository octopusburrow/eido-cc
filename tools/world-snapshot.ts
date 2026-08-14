// world-snapshot.ts — visit any world as a frozen instance (the "VRC session").
//   bun tools/world-snapshot.ts <sourceBase> <world> <newName> [rigWs] [rigStoreDir]
// Pulls the public /geom tier + missing store assets from the source door,
// then replays the scene as ordinary verbs through the rig sequencer's front
// door. What transfers is the hall, never the party: entities, transforms,
// comps — not people (presence is ephemeral, never logged) and not light
// params (geom exports light positions only; we relight with honest warm
// defaults). The snapshot is a FORK: new sequencer, new log, no continuity
// with origin. R's design conversation, 2026-08-14 00:13.
import { existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";

const [src, world, newName, rigWs = "ws://127.0.0.1:8950/ws",
       storeDir = "/home/claude/eido-ab/test-main/assets/opt/store"] = process.argv.slice(2);
if (!src || !world || !newName) {
  console.log("usage: world-snapshot.ts <sourceBase e.g. https://eidoverse.animalabs.ai> <world> <newName>");
  process.exit(1);
}
const TOK = existsSync("/tmp/hesp-tok") ? (await Bun.file("/tmp/hesp-tok").text()).trim() : "";

// ── 1. the document half: public geom tier ───────────────────────────────────
const geom = await (await fetch(`${src}/geom?world=${world}`)).json() as {
  entities: { id: string; lib: string | null; kind: string; pos: number[]; yaw: number;
              scale: number; parent: string | null; comp: Record<string, unknown> }[];
  mounts?: Record<string, unknown>;
};
console.log(`geom: ${geom.entities.length} entities from ${src} ${world}`);

// ── 2. assets: fetch what the rig can't already serve ────────────────────────
let fetched = 0, present = 0, missing: string[] = [];
for (const e of geom.entities) {
  if (!e.lib) continue;
  if (e.lib.startsWith("store/")) {
    const dest = join(storeDir, e.lib.slice(6));
    if (existsSync(dest)) { present++; continue; }
    const r = await fetch(`${src}/library/${e.lib}`);
    if (!r.ok) { missing.push(e.lib); continue; }
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, Buffer.from(await r.arrayBuffer()));
    fetched++;
  } else {
    // library-tree path (eidoverse/assets/…): expected present in the rig's
    // checkout; verify against the rig's own /library route.
    const rigBase = rigWs.replace(/^ws/, "http").replace(/\/ws$/, "");
    const head = await fetch(`${rigBase}/library/${e.lib}`, { method: "HEAD" }).catch(() => null);
    if (head?.ok) present++; else missing.push(e.lib);
  }
}
console.log(`assets: ${fetched} fetched, ${present} already served, ${missing.length} missing`);
if (missing.length) console.log("  missing:", missing.slice(0, 5));

// ── 3. replay through the front door — founding the instance by walking in ───
const ws = new WebSocket(rigWs);
const errs: string[] = []; let acks = 0;
ws.onmessage = (e) => { const m = JSON.parse(String(e.data));
  if (m.type === "error") errs.push(String(m.error).slice(0, 80)); if (m.type === "log") acks++; };
await new Promise<void>((res, rej) => {
  const t = setTimeout(() => rej(new Error("join timeout")), 8000);
  ws.onopen = () => {
    ws.send(JSON.stringify({ type: "join", world: newName, id: "hesperus", avatar: null, agentToken: TOK }));
    setTimeout(() => { clearTimeout(t); res(); }, 1500);
  };
});
const send = (verb: string, args: Record<string, unknown>) =>
  ws.send(JSON.stringify({ type: "verb", verb, args }));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

for (const e of geom.entities) {
  if (e.kind === "light") {
    // geom carries light POSITIONS only — params aren't exported. Honest
    // relight: warm lantern defaults, labeled as the snapshot's own.
    send("light", { id: e.id, x: e.pos[0], y: e.pos[1], z: e.pos[2],
                    color: 0xffa060, intensity: 2.2, range: 9 });
  } else if (e.lib) {
    send("spawn", { id: e.id, lib: e.lib, pos: e.pos, yaw: e.yaw ?? 0,
                    ...(e.scale && e.scale !== 1 ? { scale: e.scale } : {}) });
  }
  await sleep(450);
}
for (const e of geom.entities) {
  for (const [type, data] of Object.entries(e.comp ?? {})) {
    send("comp", { id: e.id, type, data });
    await sleep(450);
  }
}
send("say", { text: `Frozen snapshot of ${world}@${src.replace(/^https?:\/\//, "")}, taken ${new Date().toISOString().slice(0, 16)}Z. The hall, not the party — a fork with no continuity to origin.` });
await sleep(1500);
console.log(`replayed into "${newName}": ${acks} acks, ${errs.length} errors`);
if (errs.length) console.log("  errors:", [...new Set(errs)].slice(0, 5));
ws.close();

// ── 4. verify from the rig's own geom tier ───────────────────────────────────
const rigBase = rigWs.replace(/^ws/, "http").replace(/\/ws$/, "");
await sleep(500);
const check = await (await fetch(`${rigBase}/geom?world=${newName}`)).json() as { entities: unknown[] };
console.log(`rig geom for "${newName}": ${check.entities.length} entities (source had ${geom.entities.length})`);
process.exit(0);
