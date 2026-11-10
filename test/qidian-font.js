import { fetchPage } from "../src/fetch.js";
import { woffToTables } from "../src/font.js";

const fontUrl = "https://qdfepccdn.qidian.com/gtimg/qd_anti_spider/uaZnndRv.woff";
const res = await fetchPage(fontUrl, { binary: true, maxBytes: 2 * 1024 * 1024 });
const { tables } = woffToTables(res.bodyBuffer);

// glyf + loca：算每个 glyph 的 bbox
const glyf = tables.get("glyf");
const loca = tables.get("loca");
const head = tables.get("head");
const maxp = tables.get("maxp");
const indexToLocFormat = head.readInt16BE(50);
const numGlyphs = maxp.readUInt16BE(4);
console.log("numGlyphs:", numGlyphs, "locaFormat:", indexToLocFormat);

const offsets = [];
if (indexToLocFormat === 0) {
  for (let i = 0; i <= numGlyphs; i++) offsets.push(loca.readUInt16BE(i * 2) * 2);
} else {
  for (let i = 0; i <= numGlyphs; i++) offsets.push(loca.readUInt32BE(i * 4));
}

const bboxes = [];
for (let g = 0; g < numGlyphs; g++) {
  const start = offsets[g];
  const end = offsets[g + 1];
  if (end <= start) { bboxes.push(null); continue; }
  const numberOfContours = glyf.readInt16BE(start);
  if (numberOfContours < 0) { bboxes.push(null); continue; }
  const xMin = glyf.readInt16BE(start + 2);
  const yMin = glyf.readInt16BE(start + 4);
  const xMax = glyf.readInt16BE(start + 6);
  const yMax = glyf.readInt16BE(start + 8);
  bboxes.push({ xMin, yMin, xMax, yMax, h: yMax - yMin, w: xMax - xMin, n: numberOfContours });
}
bboxes.forEach((b, i) => {
  if (b) console.log(`gid ${i}: w=${b.w} h=${b.h} xMin=${b.xMin} yMin=${b.yMin} contours=${b.n}`);
});

// post 表：glyph 名称
const post = tables.get("post");
console.log("post format:", post.readUInt32BE(0));
