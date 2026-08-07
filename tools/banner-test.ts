// Mirror of laneBanner() logic against controlled state.
const WAKE_PATTERNS = ["chat:ambient", "!eidoverse:activity-digest"];
function banner(lanes: string[], doorUrl: string, connectedAt: number, lastDelivery: number, now: number) {
  const mins = connectedAt ? Math.round((now - connectedAt) / 60000) : 0;
  const quiet = lastDelivery ? Math.round((now - lastDelivery) / 60000) : -1;
  const where = doorUrl.replace(/^wss?:\/\//, "").replace(/\/mcpl.*$/, "");
  const wake = ["chat:addressed (always)", ...WAKE_PATTERNS].join(", ");
  return `⟨lanes⟩ live on ${lanes.join(", ") || "(none)"} via ${where || "?"}`
    + ` · connected ${mins}m` + (quiet >= 0 ? ` · last inbound ${quiet}m ago` : "")
    + ` · wakes on: ${wake}`;
}
const NOW = 1_700_000_000_000;
let pass=0, fail=0;
const ck=(n:string,cond:boolean,got?:string)=>{console.log((cond?"  ✓ ":"  ✗ ")+n+(cond?"":`\n      got: ${got}`));cond?pass++:fail++;};

const b1 = banner(["world:workbench"], "ws://localhost:8941/mcpl", NOW-20*60000, NOW-3*60000, NOW);
console.log("\n  " + b1 + "\n");
ck("names the lane", b1.includes("world:workbench"), b1);
ck("names the door (lab distinguishable from prod)", b1.includes("localhost:8941"), b1);
ck("shows connected duration", b1.includes("connected 20m"), b1);
ck("shows silence duration", b1.includes("last inbound 3m ago"), b1);
ck("shows EFFECTIVE wake config", b1.includes("chat:ambient") && b1.includes("!eidoverse:activity-digest"), b1);
ck("addressed always-on is explicit", b1.includes("chat:addressed (always)"), b1);

const b2 = banner(["world:commons"], "wss://eidoverse.animalabs.ai/mcpl?token=SECRET", NOW-90*60000, 0, NOW);
console.log("\n  " + b2 + "\n");
ck("PROD door is visibly different from lab", b2.includes("eidoverse.animalabs.ai") && !b2.includes("localhost"), b2);
ck("never leaks a token", !b2.includes("SECRET") && !b2.includes("token"), b2);
ck("no inbound yet: omits the silence clause", !b2.includes("last inbound"), b2);

const b3 = banner([], "", 0, 0, NOW);
ck("empty state says (none), does not crash", b3.includes("(none)"), b3);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
