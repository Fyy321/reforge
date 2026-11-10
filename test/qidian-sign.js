import fs from "node:fs";
import { fetchPage } from "../src/fetch.js";

const urls = [
  "https://qdfepccdn.qidian.com/www.qidian.com/fock/116594983210.js",
  "https://qdfepccdn.qidian.com/www.qidian.com/fock/l0ir4.js",
];
for (const url of urls) {
  try {
    const res = await fetchPage(url, { binary: true, maxBytes: 2 * 1024 * 1024, headers: { Referer: "https://www.qidian.com/rank/hotsales/" } });
    const source = res.bodyBuffer.toString("utf-8");
    console.log("===", url, "len:", source.length);
    let pos = 0;
    let n = 0;
    while ((pos = source.indexOf("initializeAjaxSign", pos)) !== -1 && n < 2) {
      console.log(JSON.stringify(source.slice(Math.max(0, pos - 300), pos + 900)));
      pos += 18;
      n++;
    }
    // 也找 sign 关键字
    for (const k of ["sign", "AjaxSign"]) {
      const i = source.indexOf(k);
      if (i !== -1) console.log(`[${k}]`, JSON.stringify(source.slice(Math.max(0, i - 200), i + 400)));
    }
  } catch (e) {
    console.log(url, "err", e.message);
  }
}
