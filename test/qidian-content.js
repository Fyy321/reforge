import fs from "node:fs";
const html = fs.readFileSync(process.argv[2], "utf-8");
const keys = ["__APP_DATA__", "__INITIAL_STATE__", "window.__", "readContent", "chapterInfo", "appData", "read-content", "main-text", "article-content", "density", "第1章", "第一章", "海洋"];
for (const k of keys) {
  const i = html.indexOf(k);
  console.log(k, "at", i);
  if (i > 0) console.log(JSON.stringify(html.slice(Math.max(0, i - 150), i + 400)));
}
