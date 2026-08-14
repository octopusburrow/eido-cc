#!/usr/bin/env bun
// travel-test — end-to-end eido_travel against a LAB door.
// Spawns eido-cc as CC would (stdio MCP), then: tools/list (expects
// eido_travel present) → look (world A) → eido_travel(B) → look (world B)
// → eido_travel(A). PASS iff both looks name their world.
//
// Env it passes through: EIDO_URL (default ws://127.0.0.1:8951),
// EIDO_TOKENS_JSON (default the test-main door's tokens.json),
// EIDO_MINT_CMD (default: cat the local bearer out of that same file).
const DOOR = process.env.EIDO_URL ?? "ws://127.0.0.1:8951";
const TOKENS = process.env.EIDO_TOKENS_JSON ?? "/home/claude/eido-ab/test-main/mcpl/tokens.json";
const MINT = process.env.EIDO_MINT_CMD ??
  `python3 -c "import json;d=json.load(open('${TOKENS}'));print(next(t for t,v in d.items() if v.get('id')=='hesperus'))"`;

const proc = Bun.spawn(["bun", new URL("../eido-cc.ts", import.meta.url).pathname], {
  stdin: "pipe", stdout: "pipe", stderr: "pipe",
  env: { ...process.env, EIDO_URL: DOOR, EIDO_TOKENS_JSON: TOKENS, EIDO_MINT_CMD: MINT, EIDO_DEBUG: "1" },
});
let nextId = 1;
const pending = new Map<number, (v: any) => void>();
const send = (method: string, params: any = {}, id?: number) => {
  const msg: any = { jsonrpc: "2.0", method, params };
  if (id !== undefined) msg.id = id;
  proc.stdin.write(JSON.stringify(msg) + "\n");
};
const request = (method: string, params: any = {}) => new Promise<any>((resolve, reject) => {
  const id = nextId++; pending.set(id, resolve); send(method, params, id);
  setTimeout(() => { if (pending.delete(id)) reject(new Error(`${method} timed out (test)`)); }, 45_000);
});
(async () => {
  const reader = proc.stdout.getReader();
  const dec = new TextDecoder(); let buf = "";
  void (async () => {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
        try {
          const m = JSON.parse(line);
          if (m.id !== undefined && pending.has(m.id)) { pending.get(m.id)!(m.result ?? m.error); pending.delete(m.id); }
        } catch { /* not json */ }
      }
    }
  })();

  await request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "travel-test", version: "0" } });
  send("notifications/initialized");
  const tl = await request("tools/list");
  const names = (tl.tools ?? []).map((t: any) => t.name);
  const hasTravel = names.includes("eido_travel");
  console.log(`tools: ${names.length}, eido_travel present: ${hasTravel}`);
  if (!hasTravel) { console.log("FAIL"); proc.kill(); process.exit(1); }

  const look = async () => {
    const r = await request("tools/call", { name: "look", arguments: {} });
    const text = r?.content?.[0]?.text ?? JSON.stringify(r);
    return String(text).match(/in world "([^"]+)"/)?.[1] ?? "?";
  };
  const travel = async (w: string) => {
    const r = await request("tools/call", { name: "eido_travel", arguments: { world: w } });
    const t = r?.content?.[0]?.text ?? JSON.stringify(r);
    console.log(`  travel(${w}) → ${String(t).slice(0, 110)}`);
  };

  const start = await look();
  console.log(`start world: ${start}`);
  const other = start === "voicetest" ? "under-the-eves" : "voicetest";
  await travel(other);
  const mid = await look();
  console.log(`after travel 1: ${mid}`);
  await travel(start);
  const end = await look();
  console.log(`after travel 2: ${end}`);
  const pass = mid === other && end === start;
  console.log(pass ? "PASS" : "FAIL");
  proc.kill();
  process.exit(pass ? 0 : 1);
})();
