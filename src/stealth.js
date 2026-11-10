// 反爬对抗层：UA 轮换、请求头指纹、Cookie Jar、代理接线、随机退避重试。
import { fetchPage as rawFetch } from "./fetch.js";

export const UA_POOL = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1",
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0",
];

export function randomUA() {
  return UA_POOL[Math.floor(Math.random() * UA_POOL.length)];
}

export class CookieJar {
  constructor() {
    this.cookies = new Map(); // host -> Map<name, {value, domain, path}>
  }
  set(host, name, value, { domain = null, path = "/" } = {}) {
    if (!this.cookies.has(host)) this.cookies.set(host, new Map());
    this.cookies.get(host).set(name, { value, domain: domain || host, path });
  }
  setFromHeader(host, setCookieHeader) {
    if (!setCookieHeader) return;
    const parts = String(setCookieHeader).split(/,(?=\s*[a-zA-Z0-9_]+=)/);
    for (const part of parts) {
      const m = part.match(/^\s*([^=;]+)=([^;]*)/);
      if (m) this.set(host, m[1].trim(), m[2].trim());
    }
  }
  headerFor(host) {
    const direct = this.cookies.get(host);
    const out = [];
    if (direct) for (const [k, v] of direct) out.push(`${k}=${v.value}`);
    // 域名级（去掉第一个标签）也适用
    const parts = host.split(".");
    if (parts.length > 2) {
      const parent = parts.slice(1).join(".");
      const p = this.cookies.get(parent);
      if (p) for (const [k, v] of p) out.push(`${k}=${v.value}`);
    }
    return out.length ? out.join("; ") : null;
  }
  toJSON() {
    const o = {};
    for (const [host, m] of this.cookies) {
      o[host] = Object.fromEntries([...m].map(([k, v]) => [k, v.value]));
    }
    return o;
  }
  fromJSON(json) {
    for (const [host, m] of Object.entries(json || {})) {
      for (const [k, v] of Object.entries(m)) this.set(host, k, String(v));
    }
  }
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// 随机延迟 [min,max] 毫秒
export async function jitter(min = 300, max = 1200) {
  await sleep(min + Math.floor(Math.random() * Math.max(1, max - min)));
}

// 带隐身选项的抓取：UA 轮换 + cookie jar + 代理 + 重试退避。
// options: { cookieJar, proxyUrl, ua, headers, allowPrivate, timeoutMs, maxBytes,
//            retries, jitterMs: [min,max], referer, method, body }
export async function stealthFetch(rawUrl, options = {}) {
  const jar = options.cookieJar || null;
  const u = new URL(rawUrl);
  const headers = { ...(options.headers || {}) };
  if (!headers["User-Agent"]) headers["User-Agent"] = options.ua || randomUA();
  if (options.referer) headers.Referer = options.referer;
  if (jar) {
    const cookie = jar.headerFor(u.hostname);
    if (cookie) headers.Cookie = cookie;
  }
  const retries = options.retries ?? 2;
  const jm = options.jitterMs || [200, 800];
  let lastErr = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleep(1000 * 2 ** (attempt - 1) + Math.floor(Math.random() * 500));
    await jitter(jm[0], jm[1]);
    try {
      const res = await rawFetch(rawUrl, {
        headers,
        allowPrivate: options.allowPrivate ?? false,
        timeoutMs: options.timeoutMs ?? 25000,
        maxBytes: options.maxBytes ?? 8 * 1024 * 1024,
        proxyUrl: options.proxyUrl || null,
      });
      if (jar) {
        const setCookie = res.headers["set-cookie"];
        jar.setFromHeader(u.hostname, setCookie);
      }
      if (res.status === 403 || res.status === 429 || res.status === 412 || res.status === 503) {
        lastErr = new Error(`HTTP ${res.status}`);
        continue; // 触发重试换 UA
      }
      return res;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error("fetch failed");
}
