function tagMatches(pattern: string, tag: string): boolean {
  return pattern.endsWith("*") ? tag.startsWith(pattern.slice(0, -1)) : tag === pattern;
}
function mk(env: string) {
  const P = env.split(",").map(s=>s.trim()).filter(Boolean);
  const INC = P.filter(p=>!p.startsWith("!"));
  const EXC = P.filter(p=>p.startsWith("!")).map(p=>p.slice(1));
  return (tags: string[], meta?: any) => {
    if (tags.includes("chat:addressed")) return true;
    if (!tags.length && (meta?.mentioned || meta?.isExplicitMention)) return true;
    if (EXC.some(p=>tags.some(t=>tagMatches(p,t)))) return false;
    return INC.some(p=>tags.some(t=>tagMatches(p,t)));
  };
}
let pass=0, fail=0;
const ck=(n:string,a:boolean,b:boolean)=>{const ok=a===b;console.log((ok?"  ✓ ":"  ✗ ")+n+(ok?"":`  [got ${a}, want ${b}]`));ok?pass++:fail++;};

const w = mk("chat:ambient,!eidoverse:activity-digest");
ck("live nearby speech wakes", w(["chat:ambient"]), true);
ck("activity digest does NOT wake", w(["chat:ambient","eidoverse:activity-digest"]), false);
ck("mention still wakes despite exclusion", w(["chat:mention","chat:addressed","chat:ambient"]), true);
ck("addressed+digest still wakes (never mute an address)", w(["chat:addressed","eidoverse:activity-digest"]), true);
ck("unrelated tag ignored", w(["eidoverse:weather"]), false);
ck("legacy mention fallback", w([], {mentioned:true}), true);

const w2 = mk("chat:*,!chat:ambient");
ck("glob include + specific exclude", w2(["chat:ambient"]), false);
ck("glob include passes other chat tags", w2(["chat:proximate"]), true);

const w3 = mk("");
ck("empty config: ambient does not wake", w3(["chat:ambient"]), false);
ck("empty config: addressed still wakes", w3(["chat:addressed"]), true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
