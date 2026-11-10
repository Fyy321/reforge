import fs from "node:fs";
import { fetchPage } from "../src/fetch.js";

const url = "https://qdfepccdn.qidian.com/www.qidian.com/js/views/www.qidian.com/rank/hotnew.0542f.bundle.js";
const res = await fetchPage(url, { binary: true, maxBytes: 4 * 1024 * 1024, headers: { Referer: "https://www.qidian.com/rank/hotsales/" } });
const source = res.bodyBuffer.toString("utf-8");

// 所有字符串字面量（去引号），找含 ajax/api/rank 的
const strs = new Set();
const re = /["']([^"']{3,120})["']/g;
let m;
while ((m = re.exec(source)) !== null) {
  const s = m[1];
  if (/ajax|api|rank|total|value|data/i.test(s) && !/^[a-z0-9_.-]{1,6}$/i.test(s)) strs.add(s);
}
for (const s of strs) console.log(s);
