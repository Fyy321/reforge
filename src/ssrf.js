// SSRF 防护：默认禁止访问内网/环回/链路本地地址，除非显式 allowPrivate。
import { isIP } from "node:net";

const BLOCKED_CIDR = [
  { base: [127, 0, 0, 0], mask: 8 },        // loopback
  { base: [10, 0, 0, 0], mask: 8 },         // private
  { base: [172, 16, 0, 0], mask: 12 },      // private
  { base: [192, 168, 0, 0], mask: 16 },     // private
  { base: [169, 254, 0, 0], mask: 16 },     // link-local (含云元数据)
  { base: [0, 0, 0, 0], mask: 8 },          // "this" network
  { base: [100, 64, 0, 0], mask: 10 },      // CGNAT
  { base: [192, 0, 0, 0], mask: 24 },
  { base: [198, 18, 0, 0], mask: 15 },
];

function ipv4ToInt(parts) {
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

export function isBlockedIp(ip) {
  const v = isIP(ip);
  if (v === 6) {
    const lower = ip.toLowerCase();
    if (lower === "::1" || lower === "::" || lower.startsWith("fe80") || lower.startsWith("fc") || lower.startsWith("fd")) return true;
    return false; // 其余 v6 公网放行；内网 v6 由运营商前缀决定，不静态拦
  }
  if (v !== 4) return false;
  const parts = ip.split(".").map(Number);
  const int = ipv4ToInt(parts);
  for (const { base, mask } of BLOCKED_CIDR) {
    const baseInt = ipv4ToInt(base);
    const maskBits = mask;
    const maskInt = maskBits === 0 ? 0 : (0xffffffff << (32 - maskBits)) >>> 0;
    if (((int ^ baseInt) & maskInt) === 0) return true;
  }
  return false;
}

// 校验 URL 的 host，返回 { ok, reason }。
// 规则：协议仅 http/https；host 解析出的所有 A/AAAA 记录必须通过 isBlockedIp，
// 除非 options.allowPrivate === true（供本地测试目标使用）。
export async function assertSafeUrl(rawUrl, { allowPrivate = false } = {}) {
  let u;
  try {
    u = new URL(rawUrl);
  } catch {
    return { ok: false, reason: "invalid-url", url: null };
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    return { ok: false, reason: "unsupported-protocol", url: null };
  }
  const host = u.hostname;
  const version = isIP(host);
  if (version) {
    if (!allowPrivate && isBlockedIp(host)) {
      return { ok: false, reason: "private-address", url: u };
    }
    return { ok: true, reason: null, url: u };
  }
  // 域名：做 DNS 解析并检查全部记录
  const { lookup } = await import("node:dns/promises");
  try {
    const records = await lookup(host, { all: true, verbatim: true });
    if (!allowPrivate) {
      for (const r of records) {
        if (isBlockedIp(r.address)) {
          return { ok: false, reason: `private-address:${r.address}`, url: u };
        }
      }
    }
    return { ok: true, reason: null, url: u, resolved: records.map((r) => r.address) };
  } catch (e) {
    return { ok: false, reason: `dns-error:${e.code || e.message}`, url: u };
  }
}
