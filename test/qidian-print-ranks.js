import fs from "node:fs";
import { join } from "node:path";

const outDir = process.argv[2];
const kinds = [
  ["yuepiao", "月票榜"],
  ["hotsales", "畅销榜"],
  ["retention", "留存榜"],
  ["readindex", "阅读指数榜"],
  ["newfans", "书友榜"],
  ["recom", "推荐榜"],
  ["collect", "收藏榜"],
  ["vipup", "更新榜"],
];

for (const [kind, label] of kinds) {
  const f = join(outDir, `rank-${kind}.json`);
  if (!fs.existsSync(f)) { console.log(`\n## ${label} — 缺失`); continue; }
  const r = JSON.parse(fs.readFileSync(f, "utf-8"));
  console.log(`\n## ${label}（${r.count} 本${r.dataSource ? " · 来源 " + r.dataSource : ""}${r.totalsNote ? " · " + r.totalsNote : ""}）`);
  for (const b of r.books.slice(0, 10)) {
    console.log(`${b.rank}. ${b.title} — ${b.author} [${b.category}]${b.total ? " " + b.total : ""}`);
  }
}
