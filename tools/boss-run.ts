// Boss run: eves → commons@eidoverse (ANTRA'S server) → under-the-eves@rig.
// Drives eido-cc over stdio exactly as Claude Code does. Prints look output
// at every hop — the world's own answer, not the tool banner.
const proc = Bun.spawn(["bun", new URL("../eido-cc.ts", import.meta.url).pathname], {
  stdin: "pipe", stdout: "pipe", stderr: "ignore",
  env: {
    ...process.env,
    EIDO_URL: "ws://localhost:8951/mcpl",
    EIDO_MINT_CMD: "echo hesperus-abtest-local",
    EIDO_TOKENS_JSON: "/home/claude/eido-ab/test-main/mcpl/tokens.json",
    EIDO_LIVE: "0", EIDO_DEBUG: "0",
  },
});
let nextId = 1;
const pending = new Map<number, (v: any) => void>();
const send = (method: string, params: any = {}, id?: number) =>
  proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...(id ? { id } : {}), method, params }) + "\n");
const request = (method: string, params: any = {}, ms = 90_000) => new Promise<any>((resolve, reject) => {
  const id = nextId++; pending.set(id, resolve); send(method, params, id);
  setTimeout(() => { if (pending.delete(id)) reject(new Error(`${method} timed out`)); }, ms);
});
(async () => {
  const reader = proc.stdout.getReader(); const dec = new TextDecoder(); let buf = "";
  while (true) {
    const { done, value } = await reader.read(); if (done) break;
    buf += dec.decode(value);
    let i; while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      try { const m = JSON.parse(line); if (m.id && pending.has(m.id)) { pending.get(m.id)!(m); pending.delete(m.id); } } catch { /* notification */ }
    }
  }
})();
const call = async (name: string, args: any = {}) => {
  const m = await request("tools/call", { name, arguments: args });
  if (m.error) return `ERROR: ${JSON.stringify(m.error)}`;
  return (m.result?.content ?? []).map((c: any) => c.text ?? "").join("\n");
};
await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "boss-run", version: "0" } });
send("notifications/initialized");
await new Promise((r) => setTimeout(r, 4_000));

console.log("═══ HOP 0: where am I ═══");
console.log(await call("look", {}));
console.log("\n═══ HOP 1: eido_travel commons@eidoverse (ANTRA'S SERVER) ═══");
console.log(await call("eido_travel", { world: "commons@eidoverse" }));
await new Promise((r) => setTimeout(r, 2_000));
console.log("\n═══ look in antra's commons ═══");
console.log(await call("look", {}));
console.log("\n═══ HOP 2: eido_travel under-the-eves@rig (home) ═══");
console.log(await call("eido_travel", { world: "under-the-eves@rig" }));
await new Promise((r) => setTimeout(r, 2_000));
console.log("\n═══ look at home — NOT in commons anymore ═══");
console.log(await call("look", {}));
proc.kill();
process.exit(0);
