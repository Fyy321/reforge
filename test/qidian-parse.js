import fs from "node:fs";
import { fetchPage } from "../src/fetch.js";
import { buildFontDecoder } from "../src/font.js";
import { parseQidianRank } from "../src/qidian.js";

const html = fs.readFileSync(process.argv[2], "utf-8");

// 1) 直接下载 kmKuPMal 字体并解码
try {
  const res = await fetchPage("https://qdfepccdn.qidian.com/gtimg/qd_anti_spider/kmKuPMal.woff", { binary: true, maxBytes: 2 * 1024 * 1024 });
  console.log("font status:", res.status, "bytes:", res.byteLength);
  const dec = buildFontDecoder(res.bodyBuffer);
  console.log("digitGids:", dec.digitGids);
  console.log("decode sample:", JSON.stringify(dec.decode("𘡣𘡘𘡠𘡚𘡜")));
} catch (e) {
  console.log("font fetch failed:", e.message);
}

// 2) 完整 parseQidianRank
const r = await parseQidianRank(html);
console.log("\nparse count:", r.count);
for (const b of r.books.slice(0, 3)) {
  console.log(JSON.stringify(b, null, 1));
}
