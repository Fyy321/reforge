// 二进制格式解析（纯 JS，零依赖）：magic 识别 + PE + ELF + Mach-O 头部信息。

export function detectBinary(buf) {
  if (buf.length < 4) return { type: "unknown" };
  if (buf[0] === 0x4d && buf[1] === 0x5a) return { type: "pe" };
  if (buf[0] === 0x7f && buf[1] === 0x45 && buf[2] === 0x4c && buf[3] === 0x46) return { type: "elf" };
  const le32 = buf.readUInt32LE(0);
  const be32 = buf.readUInt32BE(0);
  if (le32 === 0xfeedface || be32 === 0xfeedface || le32 === 0xcefaedfe || be32 === 0xcefaedfe) return { type: "macho", bits: 32 };
  if (le32 === 0xfeedfacf || be32 === 0xfeedfacf || le32 === 0xcffaedfe || be32 === 0xcffaedfe) return { type: "macho", bits: 64 };
  if (le32 === 0xcafebabe || be32 === 0xcafebabe) return { type: "macho-fat" };
  if (le32 === 0xcafed00d || be32 === 0xcafed00d) return { type: "java-class" };
  if (le32 === 0x504b0304) return { type: "zip" };
  if (le32 === 0x1f8b0800 || (buf[0] === 0x1f && buf[1] === 0x8b)) return { type: "gzip" };
  if (buf.subarray(0, 6).toString("latin1") === "\u0000asm") return { type: "wasm" };
  return { type: "unknown" };
}

const PE_MACHINES = {
  0x014c: "x86 (I386)",
  0x8664: "x64 (AMD64)",
  0x01c0: "ARM",
  0x01c4: "ARMv7 (Thumb)",
  0xaa64: "ARM64",
  0x0200: "IA64",
  0x01f0: "PowerPC",
};

const PE_SECTION_CHARS = [
  [0x00000020, "code"],
  [0x00000040, "initialized-data"],
  [0x00000080, "uninitialized-data"],
  [0x02000000, "discardable"],
  [0x10000000, "shareable"],
  [0x20000000, "executable"],
  [0x40000000, "readable"],
  [0x80000000, "writable"],
];

export function parsePE(buf) {
  if (detectBinary(buf).type !== "pe") throw new Error("不是 PE 文件");
  const dosE_lfanew = buf.readUInt32LE(0x3c);
  if (buf.subarray(dosE_lfanew, dosE_lfanew + 4).toString("latin1") !== "PE\u0000\u0000") {
    throw new Error("PE 签名无效");
  }
  const coff = dosE_lfanew + 4;
  const machine = buf.readUInt16LE(coff);
  const numSections = buf.readUInt16LE(coff + 2);
  const timestamp = buf.readUInt32LE(coff + 4);
  const optMagic = buf.readUInt16LE(coff + 20);
  const optSize = buf.readUInt16LE(coff + 16);
  const characteristics = buf.readUInt16LE(coff + 18);
  const optional = coff + 20; // COFF 头 20 字节，可选头紧随其后

  let entryPoint = null, imageBase = null, subsystem = null, dllCharacteristics = null;
  if (optMagic === 0x10b) {
    entryPoint = buf.readUInt32LE(optional + 16);
    imageBase = buf.readUInt32LE(optional + 28);
    subsystem = buf.readUInt16LE(optional + 68);
    dllCharacteristics = buf.readUInt16LE(optional + 70);
  } else if (optMagic === 0x20b) {
    entryPoint = buf.readUInt32LE(optional + 16);
    imageBase = buf.readBigUInt64LE(optional + 24);
    subsystem = buf.readUInt16LE(optional + 68);
    dllCharacteristics = buf.readUInt16LE(optional + 70);
  }

  const sectionStart = optional + optSize;
  const sections = [];
  for (let i = 0; i < numSections; i++) {
    const s = sectionStart + i * 40;
    if (s + 40 > buf.length) break;
    const nameRaw = buf.subarray(s, s + 8);
    let name = "";
    for (const b of nameRaw) {
      if (b === 0) break;
      name += String.fromCharCode(b);
    }
    const virtualSize = buf.readUInt32LE(s + 8);
    const virtualAddress = buf.readUInt32LE(s + 12);
    const sizeOfRawData = buf.readUInt32LE(s + 16);
    const pointerToRawData = buf.readUInt32LE(s + 20);
    const characteristics = buf.readUInt32LE(s + 36);
    const flags = PE_SECTION_CHARS.filter(([bit]) => characteristics & bit).map(([, n]) => n);
    sections.push({ name, virtualSize, virtualAddress, sizeOfRawData, pointerToRawData, characteristics, flags });
  }

  // 导入表（仅 PE32/PE32+ 且 data directory 有效）
  let imports = [];
  try {
    const ddOffset = optMagic === 0x10b ? 96 : 112;
    const importRva = buf.readUInt32LE(optional + ddOffset);
    const importSize = buf.readUInt32LE(optional + ddOffset + 4);
    if (importRva && importSize) {
      const raw = rvaToOffset(sections, importRva);
      if (raw && raw + 20 <= buf.length) {
        let off = raw;
        let guard = 0;
        while (guard++ < 64 && off + 20 <= buf.length) {
          const origThunk = buf.readUInt32LE(off);
          const nameRva = buf.readUInt32LE(off + 12);
          const firstThunk = buf.readUInt32LE(off + 16);
          if (!origThunk && !nameRva && !firstThunk) break;
          if (nameRva) {
            const nameRaw = rvaToOffset(sections, nameRva);
            if (nameRaw) {
              let end = nameRaw;
              while (end < buf.length && buf[end] !== 0) end++;
              imports.push(buf.subarray(nameRaw, end).toString("latin1"));
            }
          }
          off += 20;
        }
      }
    }
  } catch {
    /* 导入解析失败不影响主结果 */
  }

  return {
    format: "pe",
    machine: PE_MACHINES[machine] || `0x${machine.toString(16)}`,
    numSections,
    timestamp: new Date(timestamp * 1000).toISOString(),
    timestampRaw: timestamp,
    characteristics,
    isDll: Boolean(characteristics & 0x2000),
    subsystem,
    dllCharacteristics,
    entryPoint: entryPoint !== null ? `0x${entryPoint.toString(16)}` : null,
    imageBase: imageBase !== null ? `0x${imageBase.toString(16)}` : null,
    sections,
    imports,
  };
}

function rvaToOffset(sections, rva) {
  for (const s of sections) {
    if (rva >= s.virtualAddress && rva < s.virtualAddress + Math.max(s.virtualSize, s.sizeOfRawData)) {
      return s.pointerToRawData + (rva - s.virtualAddress);
    }
  }
  return null;
}

const ELF_MACHINES = {
  3: "x86 (i386)",
  62: "x86-64 (AMD64)",
  40: "ARM",
  183: "ARM64 (AArch64)",
  21: "PowerPC",
  243: "RISC-V",
  8: "MIPS",
};

export function parseELF(buf) {
  if (detectBinary(buf).type !== "elf") throw new Error("不是 ELF 文件");
  const cls = buf[4]; // 1=32, 2=64
  const data = buf[5]; // 1=LE, 2=BE
  const is64 = cls === 2;
  const isLE = data === 1;
  const read16 = (o) => (isLE ? buf.readUInt16LE(o) : buf.readUInt16BE(o));
  const read32 = (o) => (isLE ? buf.readUInt32LE(o) : buf.readUInt32BE(o));
  const read64 = (o) => (isLE ? buf.readBigUInt64LE(o) : buf.readBigUInt64BE(o));
  const type = read16(16);
  const machine = read16(18);
  const entry = is64 ? read64(24).toString(16) : read32(24).toString(16);
  const phoff = is64 ? Number(read64(32)) : read32(28);
  const shoff = is64 ? Number(read64(40)) : read32(32);
  const ehsize = read16(52);
  const phentsize = read16(54);
  const phnum = read16(56);
  const shentsize = read16(58);
  const shnum = read16(60);

  const segments = [];
  for (let i = 0; i < phnum && i < 64; i++) {
    const p = phoff + i * phentsize;
    if (p + phentsize > buf.length) break;
    const pType = read32(p);
    segments.push({
      type: pType,
      flags: read32(p + 4),
      offset: is64 ? Number(read64(p + 8)) : read32(p + 4),
      vaddr: is64 ? read64(p + 16).toString(16) : read32(p + 8).toString(16),
      filesz: is64 ? Number(read64(p + 32)) : read32(p + 16),
    });
  }

  const sections = [];
  const strtabIdx = read16(62);
  for (let i = 0; i < shnum && i < 128; i++) {
    const s = shoff + i * shentsize;
    if (s + shentsize > buf.length) break;
    sections.push({
      nameOffset: read32(s),
      type: read32(s + 4),
      flags: is64 ? Number(read64(s + 8)) : read32(s + 8),
      addr: is64 ? read64(s + 16).toString(16) : read32(s + 12).toString(16),
      offset: is64 ? Number(read64(s + 24)) : read32(s + 16),
      size: is64 ? Number(read64(s + 32)) : read32(s + 20),
    });
  }
  // 用节名字符串表解析名称
  let names = [];
  try {
    if (strtabIdx < sections.length) {
      const st = sections[strtabIdx];
      const raw = buf.subarray(st.offset, st.offset + st.size);
      names = sections.map((s) => {
        let end = s.nameOffset;
        while (end < raw.length && raw[end] !== 0) end++;
        return raw.subarray(s.nameOffset, end).toString("latin1");
      });
    }
  } catch {
    /* ignore */
  }
  sections.forEach((s, i) => (s.name = names[i] || `#${i}`));

  return {
    format: "elf",
    class: is64 ? "ELF64" : "ELF32",
    endian: isLE ? "little" : "big",
    type,
    machine: ELF_MACHINES[machine] || `0x${machine.toString(16)}`,
    entry: `0x${entry}`,
    segments,
    sections,
  };
}

export function parseMachO(buf) {
  const d = detectBinary(buf);
  if (d.type !== "macho") throw new Error("不是单架构 Mach-O 文件");
  const is64 = d.bits === 64;
  const magic = buf.readUInt32LE(0);
  const isLE = magic === 0xfeedface || magic === 0xfeedfacf || magic === 0xcefaedfe && false;
  const little = magic === 0xfeedface || magic === 0xfeedfacf;
  const read32 = (o) => (little ? buf.readUInt32LE(o) : buf.readUInt32BE(o));
  const read64 = (o) => (little ? buf.readBigUInt64LE(o) : buf.readBigUInt64BE(o));
  const cpuType = read32(4);
  const ncmds = read32(16);
  const cmds = [];
  let off = is64 ? 32 : 28;
  for (let i = 0; i < ncmds && i < 64; i++) {
    if (off + 8 > buf.length) break;
    const cmd = read32(off);
    const cmdsize = read32(off + 4);
    if (!cmdsize) break;
    cmds.push({ cmd, cmdsize, offset: off });
    off += cmdsize;
  }
  return {
    format: "macho",
    bits: d.bits,
    endian: little ? "little" : "big",
    cpuType: `0x${cpuType.toString(16)}`,
    ncmds,
    loadCommands: cmds.map((c) => ({ cmd: `0x${c.cmd.toString(16)}`, size: c.cmdsize })),
  };
}

export function parseMachOFat(buf) {
  const d = detectBinary(buf);
  if (d.type !== "macho-fat") throw new Error("不是 FAT Mach-O");
  const big = buf.readUInt32BE(0) === 0xcafebabe;
  const read32 = (o) => (big ? buf.readUInt32BE(o) : buf.readUInt32LE(o));
  const nfat = read32(4);
  const slices = [];
  for (let i = 0; i < nfat && i < 16; i++) {
    const s = 8 + i * 20;
    if (s + 20 > buf.length) break;
    slices.push({
      cpuType: `0x${read32(s).toString(16)}`,
      cpuSubtype: read32(s + 4),
      offset: read32(s + 8),
      size: read32(s + 12),
    });
  }
  return { format: "macho-fat", slices };
}

export function extractStrings(buf, { minLen = 4, max = 500 } = {}) {
  const out = [];
  let cur = [];
  const push = () => {
    if (cur.length >= minLen) out.push(cur.join(""));
    cur = [];
  };
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i];
    if (b === 0) {
      push();
    } else if (b >= 0x20 && b < 0x7f) {
      cur.push(String.fromCharCode(b));
      if (cur.length > 4096) cur = [];
    } else if (b >= 0xc0) {
      // UTF-8 多字节序列：收集并跳过后续字节
      const seq = [b];
      let n = 0;
      if ((b & 0xe0) === 0xc0) n = 1;
      else if ((b & 0xf0) === 0xe0) n = 2;
      else if ((b & 0xf8) === 0xf0) n = 3;
      let valid = true;
      for (let k = 1; k <= n; k++) {
        const nb = buf[i + k];
        if (nb === undefined || (nb & 0xc0) !== 0x80) {
          valid = false;
          break;
        }
        seq.push(nb);
      }
      if (valid) {
        cur.push(Buffer.from(seq).toString("utf-8"));
        i += n;
      } else {
        push();
      }
    } else {
      push();
    }
    if (out.length >= max) break;
  }
  push();
  return out.slice(0, max);
}
