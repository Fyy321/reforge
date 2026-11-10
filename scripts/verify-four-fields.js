// 四要素覆盖率验证：书名/作者/简介/封面 逐榜统计 + 封面链接活检。
import fs from "node:fs";
import path from "node:path";
import { fetchPage } from "../src/fetch.js";

const outDir = process.argv[2];
const feed = JSON.parse(fs.readFileSync(path.join(outDir, "ranks-apple.json"), "utf-8"));

console.log(`数据生成时间: ${feed.generatedAt}\n`);
console.log("榜单 | 本数 | 书名 | 作者 | 简介 | 封面URL");
let totalBooks = 0;
const misses = [];
for (const r of feed.ranks) {
  const n = r.books.length;
  totalBooks += n;
  const withTitle = r.books.filter((b) => b.title).length;
  const withAuthor = r.books.filter((b) => b.author).length;
  const withIntro = r.books.filter((b) => b.intro && b.intro.length > 0).length;
  const withCover = r.books.filter((b) => b.cover && b.cover.startsWith("https://bookcover")).length;
  console.log(`${r.name.padEnd(8)} | ${String(n).padStart(3)} | ${String(withTitle).padStart(3)} | ${String(withAuthor).padStart(3)} | ${String(withIntro).padStart(3)} | ${String(withCover).padStart(3)}`);
  for (const b of r.books) {
    if (!b.title) misses.push(`${r.name}/${b.rank} 缺书名`);
    if (!b.author) misses.push(`${r.name}/${b.rank} ${b.title} 缺作者`);
    if (!b.intro || b.intro.length <= 0) misses.push(`${r.name}/${b.rank} ${b.title} 缺简介`);
    if (!b.cover || !b.cover.startsWith("https://bookcover")) misses.push(`${r.name}/${b.rank} ${b.title} 缺封面`);
  }
}
console.log(`\n总计: ${feed.ranks.length} 榜 / ${totalBooks} 条记录`);
console.log(misses.length ? `缺失项 ${misses.length}:` : "四要素 100% 齐备");
for (const m of misses.slice(0, 20)) console.log("  ✗ " + m);

// 封面链接活检（抽样 20 个不同 bookId）
const sample = [];
const seen = new Set();
for (const r of feed.ranks) {
  for (const b of r.books) {
    if (b.cover && b.bid && !seen.has(b.bid) && sample.length < 20) {
      seen.add(b.bid);
      sample.push(b);
    }
  }
}
console.log(`\n封面链接活检（抽样 ${sample.length} 个）:`);
let ok = 0;
for (const b of sample) {
  try {
    const res = await fetchPage(b.cover, { binary: true, maxBytes: 4096 });
    if (res.status === 200) { ok++; console.log(`  ✓ ${res.status} ${b.title} (${res.headers["content-type"] || "?"})`); }
    else console.log(`  ✗ ${res.status} ${b.title}`);
  } catch (e) {
    console.log(`  ✗ ${b.title} ${e.message}`);
  }
}
console.log(`封面可访问: ${ok}/${sample.length}`);
