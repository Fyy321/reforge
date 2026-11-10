import fs from "node:fs";
import { join } from "node:path";
import { getQidianRank } from "../src/qidian.js";

const kinds = ["yuepiao", "hotsales", "retention", "readindex", "newfans", "recom", "collect", "vipup"];
const outDir = process.argv[2];

for (const kind of kinds) {
  const outFile = join(outDir, `rank-${kind}.json`);
  const r = await getQidianRank(kind, { waitMs: 12000, timeoutMs: 90000 });
  fs.writeFileSync(outFile, JSON.stringify(r, null, 2), "utf-8");
  const withTotal = r.books.filter((b) => b.total && b.total.length > 0).length;
  const sample = (r.books[0] || {}).total;
  console.log(`[${kind}] ${r.name} | books=${r.count} | totals=${withTotal} | dataSource=${r.dataSource || "ssr"} | 样例="${sample}"${r.totalsNote ? " | " + r.totalsNote : ""}`);
}
console.log("DONE");
