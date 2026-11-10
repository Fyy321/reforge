import fs from "node:fs";
const html = fs.readFileSync(process.argv[2], "utf-8");
const re = /href="(\/\/www\.qidian\.com\/rank\/[a-z0-9]+\/?)"[^>]*>([^<]{2,12})/g;
let m;
const seen = new Set();
while ((m = re.exec(html)) !== null) {
  const k = m[1] + "|" + m[2];
  if (!seen.has(k)) {
    seen.add(k);
    console.log(m[1], "->", m[2]);
  }
}
