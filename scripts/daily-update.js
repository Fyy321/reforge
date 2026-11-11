// 每日一次性榜单更新任务：跑一轮全量爬取 → 写盘 → 退出。
// 供 cron / launchd / GitHub Actions 每日调用一次。
// 用法: node scripts/daily-update.js [--kinds yuepiao,hotsales,...] [--out-dir ./daily-ranks]
import fs from "node:fs";
import path from "node:path";
import { getQidianRank, RANK_KINDS } from "../src/qidian.js";

const args = process.argv.slice(2);
const argVal = (name) => {
  const i = args.indexOf(name);
  return i !== -1 && args[i + 1] ? args[i + 1] : null;
};
const kindsArg = argVal("--kinds");
// 默认主站十一榜 + 女频两榜；增删榜单只调整此清单与 src/qidian.js 的端点配置。
// signnewbook 页面结构不同（0 本）、mm 为女生网入口页（仅书名+封面），不在默认集合
const DEFAULT_KINDS = ["yuepiao", "hotsales", "recom", "collect", "readindex", "retention", "potential", "newfans", "vipup", "vipcollect", "pubnewbook", "mm_yuepiao", "mm_hotsales"];
const kinds = kindsArg ? kindsArg.split(",").filter(Boolean) : DEFAULT_KINDS;
const outDir = path.resolve(argVal("--out-dir") || "./daily-ranks");
fs.mkdirSync(outDir, { recursive: true });

const started = new Date();
const result = { generatedAt: started.toISOString(), kinds: {} };
let failures = 0;

for (const kind of kinds) {
  const t0 = Date.now();
  try {
    const r = await getQidianRank(kind, { waitMs: 12000, timeoutMs: 90000 });
    result.kinds[kind] = {
      name: r.name,
      url: r.url,
      group: r.group || "主站",
      ok: true,
      tookMs: Date.now() - t0,
      source: r.dataSource || "ssr",
      totalsNote: r.totalsNote || null,
      books: r.books.map((b) => ({
        rank: b.rank, bid: b.bid, title: b.title, author: b.author,
        category: b.category, total: b.total, status: b.status,
        latestChapter: b.latestChapter, updateTime: b.updateTime,
        intro: b.intro || "",
        cover: normalizeCover(b.cover || "", b.bid),
      })),
    };
    console.log(`[ok]   ${kind} (${r.group || "主站"} · ${r.name}) ${r.count} 本 ${Date.now() - t0}ms`);
  } catch (e) {
    failures++;
    result.kinds[kind] = { name: kind, ok: false, error: String(e.message || e) };
    console.log(`[fail] ${kind}: ${e.message || e}`);
  }
}

// 1) 通用格式（kinds 字典）
const jsonPath = path.join(outDir, "ranks.json");
const tmp = jsonPath + ".tmp";
fs.writeFileSync(tmp, JSON.stringify(result, null, 2));
fs.renameSync(tmp, jsonPath);

// 2) Apple 友好格式（扁平数组，Swift Codable 直接解码）
const apple = {
  generatedAt: result.generatedAt,
  ranks: Object.entries(result.kinds).map(([kind, v]) => ({
    kind, name: v.name, group: v.group || "主站", ok: v.ok, source: v.source || null,
    totalsNote: v.totalsNote || null,
    books: v.books || [],
  })),
};
const applePath = path.join(outDir, "ranks-apple.json");
const tmpA = applePath + ".tmp";
fs.writeFileSync(tmpA, JSON.stringify(apple));
fs.renameSync(tmpA, applePath);

// 3) CSV
const lines = ["kind,rank,title,author,category,total,updateTime"];
for (const [kind, v] of Object.entries(result.kinds)) {
  for (const b of v.books || []) {
    const esc = (s) => `"${String(s ?? "").replace(/"/g, '""')}"`;
    lines.push(`${kind},${b.rank},${esc(b.title)},${esc(b.author)},${esc(b.category)},${esc(b.total)},${esc(b.updateTime)}`);
  }
}
const csvPath = path.join(outDir, "ranks.csv");
const tmpC = csvPath + ".tmp";
fs.writeFileSync(tmpC, lines.join("\n"));
fs.renameSync(tmpC, csvPath);

function coverUrlFor(bid, size = 180) {
  return `https://bookcover.yuewen.com/qdbimg/349573/${bid}/${size}.webp`;
}

// 统一封面 URL：页面给的封面（150 尺寸）升级为 180；无则按 bid 构造官方 CDN 地址
function normalizeCover(cover, bid) {
  if (cover) {
    const m = cover.replace(/\/\d+\.webp$/, "/180.webp");
    if (m !== cover) return m;
  }
  return coverUrlFor(bid);
}

console.log(`完成: ${kinds.length - failures}/${kinds.length} 榜成功 → ${outDir}`);
console.log(`  ${jsonPath}`);
console.log(`  ${applePath}`);
console.log(`  ${csvPath}`);
console.log(`  （封面为官方 CDN 直链，App 端直接加载，不落地下载）`);
process.exit(failures > 0 ? 1 : 0);
