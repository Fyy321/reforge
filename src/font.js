import fs from "node:fs";
import zlib from "node:zlib";

// WOFF → sfnt 表提取
export function woffToTables(buf) {
  if (buf.subarray(0, 4).toString("latin1") !== "wOFF") throw new Error("不是 WOFF 文件");
  let flavor = buf.readUInt32BE(4);
  let length = buf.readUInt32BE(8);
  let numTables = buf.readUInt16BE(12);
  const tables = new Map();
  let off = 44;
  const dir = [];
  for (let i = 0; i < numTables; i++) {
    const tag = buf.subarray(off, off + 4).toString("latin1");
    const offset = buf.readUInt32BE(off + 4);
    const compLength = buf.readUInt32BE(off + 8);
    const origLength = buf.readUInt32BE(off + 12);
    const origChecksum = buf.readUInt32BE(off + 16);
    dir.push({ tag, offset, compLength, origLength, origChecksum });
    off += 20;
  }
  for (const d of dir) {
    let data = buf.subarray(d.offset, d.offset + d.compLength);
    if (d.compLength < d.origLength) {
      data = zlib.inflateSync(data);
    }
    tables.set(d.tag, data);
  }
  return { flavor, tables };
}

// sfnt cmap 解析：支持 format 0 / 4 / 12 → Map(codepoint → glyphId)
// 返回所有子表里条目最多的映射（优先 Unicode 平台）。
export function parseCmap(cmapBuf) {
  const version = cmapBuf.readUInt16BE(0);
  const numTables = cmapBuf.readUInt16BE(2);
  const candidates = [];
  for (let i = 0; i < numTables; i++) {
    const platform = cmapBuf.readUInt16BE(4 + i * 8);
    const encoding = cmapBuf.readUInt16BE(6 + i * 8);
    const offset = cmapBuf.readUInt32BE(8 + i * 8);
    if (offset + 2 > cmapBuf.length) continue;
    const format = cmapBuf.readUInt16BE(offset);
    let map = null;
    if (format === 0) {
      map = new Map();
      for (let c = 0; c < 256; c++) {
        const gid = cmapBuf[offset + 6 + c];
        if (gid !== 0) map.set(c, gid);
      }
    } else if (format === 4) {
      const segCountX2 = cmapBuf.readUInt16BE(offset + 6);
      const segCount = segCountX2 / 2;
      const endCodes = [];
      for (let s = 0; s < segCount; s++) endCodes.push(cmapBuf.readUInt16BE(offset + 14 + s * 2));
      const startCodes = [];
      for (let s = 0; s < segCount; s++) startCodes.push(cmapBuf.readUInt16BE(offset + 16 + segCountX2 + s * 2));
      const idDeltas = [];
      for (let s = 0; s < segCount; s++) idDeltas.push(cmapBuf.readInt16BE(offset + 16 + segCountX2 * 2 + s * 2));
      const idRangeOffsets = [];
      for (let s = 0; s < segCount; s++) idRangeOffsets.push(cmapBuf.readUInt16BE(offset + 16 + segCountX2 * 3 + s * 2));
      map = new Map();
      for (let s = 0; s < segCount; s++) {
        const end = endCodes[s];
        if (end === 0xffff) continue;
        const start = startCodes[s];
        const delta = idDeltas[s];
        const ro = idRangeOffsets[s];
        for (let c = start; c <= end && c <= 0xffff; c++) {
          let gid;
          if (ro === 0) {
            gid = (c + delta) & 0xffff;
          } else {
            const addr = offset + 16 + segCountX2 * 3 + s * 2 + ro + (c - start) * 2;
            if (addr + 2 > cmapBuf.length) continue;
            const g = cmapBuf.readUInt16BE(addr);
            gid = g === 0 ? 0 : (g + delta) & 0xffff;
          }
          if (gid !== 0) map.set(c, gid);
        }
      }
    } else if (format === 12) {
      const nGroups = cmapBuf.readUInt32BE(offset + 12);
      map = new Map();
      for (let g = 0; g < nGroups; g++) {
        const base = offset + 16 + g * 12;
        if (base + 12 > cmapBuf.length) break;
        const startChar = cmapBuf.readUInt32BE(base);
        const endChar = cmapBuf.readUInt32BE(base + 4);
        const startGid = cmapBuf.readUInt32BE(base + 8);
        for (let c = startChar; c <= endChar; c++) {
          map.set(c, startGid + (c - startChar));
        }
      }
    }
    if (map && map.size > 0) candidates.push({ platform, encoding, map });
  }
  candidates.sort((a, b) => b.map.size - a.map.size);
  const unicode = candidates.find((c) => c.platform === 0 || c.platform === 3);
  return (unicode || candidates[0])?.map || new Map();
}

// 用 cmap 把"假字符"解码成数字：假字符→glyphID，glyphID 升序位置 = 真实数字
export function decodeDigitText(scrambled, cmap) {
  const fakeChars = [...scrambled];
  const pairs = fakeChars.map((ch) => {
    const cp = ch.codePointAt(0);
    const gid = cmap.get(cp);
    return { ch, cp, gid };
  });
  if (pairs.some((p) => p.gid === undefined)) return { ok: false, decoded: scrambled };
  // 该字体只含 10 个数字字形：glyphID 排序后位置即数字
  const sorted = [...new Set(pairs.map((p) => p.gid))].sort((a, b) => a - b);
  const gidToDigit = new Map(sorted.map((g, i) => [g, i]));
  let out = "";
  for (const p of pairs) out += String(gidToDigit.get(p.gid));
  return { ok: true, decoded: out, mapping: Object.fromEntries([...gidToDigit].map(([g, d]) => [g, d])) };
}

// 解析 glyf/loca 计算每个 glyph 的 bbox
function glyphBboxes({ tables }) {
  const glyf = tables.get("glyf");
  const loca = tables.get("loca");
  const head = tables.get("head");
  const maxp = tables.get("maxp");
  if (!glyf || !loca || !head || !maxp) return [];
  const indexToLocFormat = head.readInt16BE(50);
  const numGlyphs = maxp.readUInt16BE(4);
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
    if (end <= start || end > glyf.length) { bboxes.push(null); continue; }
    const numberOfContours = glyf.readInt16BE(start);
    if (numberOfContours < 0) { bboxes.push(null); continue; }
    bboxes.push({
      yMin: glyf.readInt16BE(start + 4),
      yMax: glyf.readInt16BE(start + 8),
      h: glyf.readInt16BE(start + 8) - glyf.readInt16BE(start + 4),
      w: glyf.readInt16BE(start + 6) - glyf.readInt16BE(start + 2),
    });
  }
  return bboxes;
}

// 完整解码器：下载的 woff 字节 → decode(scrambledText) → 真实文本。
// 规则：数字字形是 cmap 里出现、bbox 高度接近最大高度的字形；
// 按 glyphID 升序编号为 0..9；小 bbox 字形映射为 "."，其余映射为空。
export function buildFontDecoder(woffBytes) {
  const { tables } = woffToTables(woffBytes);
  const cmap = parseCmap(tables.get("cmap"));
  const bboxes = glyphBboxes({ tables });
  const mappedGids = [...new Set(cmap.values())].sort((a, b) => a - b);
  const heights = mappedGids.map((g) => (bboxes[g] ? bboxes[g].h : 0));
  const maxH = Math.max(...heights, 1);
  const digitGids = mappedGids.filter((g) => bboxes[g] && bboxes[g].h >= maxH * 0.5).sort((a, b) => a - b);
  const digitRank = new Map(digitGids.map((g, i) => [g, i]));
  const gidToChar = new Map();
  for (const g of mappedGids) {
    if (digitRank.has(g)) gidToChar.set(g, String(digitRank.get(g)));
    else if (bboxes[g] && bboxes[g].h < maxH * 0.3) gidToChar.set(g, ".");
  }
  const cpToChar = new Map();
  for (const [cp, gid] of cmap) {
    if (gidToChar.has(gid)) cpToChar.set(cp, gidToChar.get(gid));
  }
  const decode = (text) => {
    let out = "";
    for (const ch of text) {
      const cp = ch.codePointAt(0);
      out += cpToChar.get(cp) ?? "";
    }
    return out;
  };
  return { decode, cmap, digitGids, cpToChar };
}
