// 付费/登录墙绕过与全文镜像（本地夹具与占位目标）。
// 策略顺序：全文镜像 → 快照服务 → 阅读器/AMP/打印版 → 全文 JSON-LD/RSS → 原文清理。

import { fetchPage } from "./fetch.js";
import { stealthFetch } from "./stealth.js";
import { extractImages, extractMainText, parseMeta, stripTags } from "./html.js";
import { writeFile, mkdir } from "node:fs/promises";
import { join, basename } from "node:path";

/**
 * 策略一：全文镜像 —— 下载页面 + 内联全部图片/CSS，产出单文件 HTML（离线可看）。
 * 对付"正文在前端已下发、被 CSS 遮罩/JS 拦截"的付费页最有效。
 */
export async function mirrorArticle(rawUrl, options = {}) {
  const { outDir = null, session = {}, allowPrivate = false, useStealth = true, maxImages = 200, filename = null } = options;
  const res = useStealth
    ? await stealthFetch(rawUrl, { cookieJar: session.jar, headers: session.headers, allowPrivate })
    : await fetchPage(rawUrl, { allowPrivate, cookie: session.cookie, headers: session.headers });
  const html = res.bodyText;

  const images = extractImages(html, res.finalUrl);
  const inlined = [];
  let replaced = html;
  for (const img of images.slice(0, maxImages)) {
    try {
      const r = await fetchPage(img, {
        allowPrivate,
        cookie: session.cookie,
        headers: { ...(session.headers || {}), Referer: res.finalUrl },
        maxBytes: 4 * 1024 * 1024,
      });
      const ct = r.headers["content-type"] || "image/png";
      const b64 = Buffer.from(r.bodyText, "binary").toString("base64");
      const dataUri = `data:${ct};base64,${b64}`;
      inlined.push({ src: img, dataUri: dataUri.slice(0, 40) + "...", bytes: r.byteLength });
      // 简单字符串替换（src 与 data-src 两种）
      replaced = replaced.split(img).join(dataUri);
    } catch {
      /* 单图失败不影响整体 */
    }
  }

  // 去掉付费墙遮罩/脚本弹层
  replaced = replaced
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/class="[^"]*(?:mask|modal|paywall|vip|overlay|lock)[^"]*"[^>]*>/gi, "")
    .replace(/<[^>]+style="[^"]*(?:display\s*:\s*none|visibility\s*:\s*hidden)[^"]*"[^>]*>/gi, "");

  const result = {
    strategy: "full-mirror",
    url: res.finalUrl,
    status: res.status,
    title: extractTitleLocal(replaced),
    textLength: stripTags(replaced).length,
    imagesTotal: images.length,
    imagesInlined: inlined.length,
    images: inlined.map((i) => i.src).slice(0, 20),
    htmlSize: replaced.length,
  };

  if (outDir) {
    await mkdir(outDir, { recursive: true });
    const name = (filename || safeName(res.finalUrl)) + ".html";
    const outPath = join(outDir, name);
    await writeFile(outPath, replaced, "utf-8");
    result.savedTo = outPath;
  }
  result.html = replaced.slice(0, 1000000); // 最多带 1MB 回 MCP
  result.htmlTruncated = replaced.length > 1000000;
  return result;
}

function extractTitleLocal(html) {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? stripTags(m[1]).slice(0, 200) : "";
}

function safeName(url) {
  try {
    const u = new URL(url);
    const base = (u.hostname + u.pathname).replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80);
    return base || "mirror";
  } catch {
    return "mirror";
  }
}

/**
 * 策略二：快照服务 —— archive.ph / web.archive.org 拿已存全文快照。
 */
export async function snapshotFetch(rawUrl, { allowPrivate = false, service = "archive" } = {}) {
  const map = {
    archive: (u) => `https://web.archive.org/web/2/${u}`,
    archivetoday: (u) => `https://archive.ph/newest/${u}`,
  };
  const getter = map[service] || map.archive;
  const url = getter(rawUrl);
  try {
    const res = await fetchPage(url, {
      allowPrivate,
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36" },
    });
    const text = stripTags(res.bodyText);
    return {
      strategy: `snapshot:${service}`,
      ok: text.length > 200,
      url: res.finalUrl,
      status: res.status,
      title: extractTitleLocal(res.bodyText),
      textLength: text.length,
      text: text.slice(0, 400000),
    };
  } catch (e) {
    return { strategy: `snapshot:${service}`, ok: false, error: String(e.message || e) };
  }
}

/**
 * 策略三：阅读器/AMP/打印版候选 URL 生成。
 * 常见付费墙对 Reader/AMP/print 端点放行全文。
 */
export function paywallCandidateUrls(rawUrl) {
  const u = new URL(rawUrl);
  const base = u.origin + u.pathname;
  const candidates = [];
  const amp = `${base.replace(/\/$/, "")}/amp`;
  const amp2 = u.origin + "/amp" + u.pathname;
  const print = base + (base.includes("?") ? "&" : "?") + "print=1";
  const reader = base + (base.includes("?") ? "&" : "?") + "output=1";
  for (const c of [amp, amp2, print, reader]) {
    try {
      const cu = new URL(c);
      candidates.push(cu.href);
    } catch { /* skip */ }
  }
  // 移除追踪参数版本
  const clean = new URL(rawUrl);
  for (const k of [...clean.searchParams.keys()]) {
    if (/^(utm_|from|share_token|spm|ref$)/i.test(k)) clean.searchParams.delete(k);
  }
  candidates.push(clean.href);
  return [...new Set(candidates)];
}

/**
 * 策略四：结构化数据提取 —— JSON-LD / og / RSS 全文字段，直接绕过渲染层。
 */
export function extractStructuredFulltext(html, baseUrl = "") {
  const out = { jsonLd: [], og: parseMeta(html), rss: [] };
  const ldRe = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = ldRe.exec(html)) !== null) {
    try {
      out.jsonLd.push(JSON.parse(m[1].trim()));
    } catch { /* skip malformed */ }
  }
  // 常见付费内容在 <meta name="description"> 之外还藏在 articleBody 结构化字段
  const bodyMatch = html.match(/"articleBody"\s*:\s*"([\s\S]{0,50000}?)(?="\s*[,}])/);
  if (bodyMatch) {
    out.articleBody = bodyMatch[1].replace(/\\n/g, "\n").replace(/\\"/g, '"');
  }
  return out;
}

/**
 * 组合：tryBypassPaywall —— 依序尝试上述策略直到拿到足够长的全文。
 * options: { minTextLength = 300, session, allowPrivate, mirrorOutDir }
 */
export async function tryBypassPaywall(rawUrl, options = {}) {
  const { minTextLength = 300, session = {}, allowPrivate = false, mirrorOutDir = null } = options;
  const attempts = [];
  const record = (r) => {
    attempts.push(r);
    return r;
  };

  // 1) 直接抓取（含会话）
  try {
    const direct = await fetchPage(rawUrl, {
      allowPrivate,
      cookie: session.cookie,
      headers: session.headers || {},
    });
    const text = stripTags(direct.bodyText);
    record({ step: "direct", status: direct.status, textLength: text.length, title: extractTitleLocal(direct.bodyText) });
    if (text.length >= minTextLength) {
      return { ok: true, via: "direct", text, title: extractTitleLocal(direct.bodyText), attempts };
    }
  } catch (e) {
    record({ step: "direct", error: String(e.message || e) });
  }

  // 2) 结构化全文（JSON-LD / articleBody）
  try {
    const direct = await fetchPage(rawUrl, { allowPrivate, cookie: session.cookie, headers: session.headers || {} });
    const structured = extractStructuredFulltext(direct.bodyText, direct.finalUrl);
    const candidates = [structured.articleBody, ...structured.jsonLd.map((l) => l.articleBody).filter(Boolean), ...structured.jsonLd.map((l) => l.text).filter(Boolean)];
    for (const t of candidates) {
      if (t && t.length >= minTextLength) {
        record({ step: "structured", textLength: t.length });
        return { ok: true, via: "structured-fulltext", text: t, title: extractTitleLocal(direct.bodyText), attempts };
      }
    }
    record({ step: "structured", textLength: Math.max(0, ...candidates.map((c) => (c || "").length)) });
  } catch (e) {
    record({ step: "structured", error: String(e.message || e) });
  }

  // 3) 阅读器/AMP/打印候选
  for (const candidate of paywallCandidateUrls(rawUrl)) {
    try {
      const res = await fetchPage(candidate, { allowPrivate, cookie: session.cookie, headers: session.headers || {} });
      const text = stripTags(res.bodyText);
      record({ step: `variant:${candidate}`, status: res.status, textLength: text.length });
      if (text.length >= minTextLength) {
        return { ok: true, via: `variant:${candidate}`, text, title: extractTitleLocal(res.bodyText), attempts };
      }
    } catch (e) {
      record({ step: `variant:${candidate}`, error: String(e.message || e) });
    }
  }

  // 4) 快照服务
  for (const service of ["archive", "archivetoday"]) {
    const snap = await snapshotFetch(rawUrl, { allowPrivate, service });
    record({ step: `snapshot:${service}`, ok: snap.ok, textLength: snap.textLength || 0 });
    if (snap.ok && (snap.textLength || 0) >= minTextLength) {
      return { ok: true, via: `snapshot:${service}`, text: snap.text, title: snap.title, attempts };
    }
  }

  // 5) 全文镜像（顺带把页面连同图片保存成单文件）
  if (mirrorOutDir) {
    try {
      const mirror = await mirrorArticle(rawUrl, { ...options, outDir: mirrorOutDir });
      const text = stripTags(mirror.html || "");
      record({ step: "mirror", textLength: text.length, savedTo: mirror.savedTo });
      if (text.length >= minTextLength) {
        return { ok: true, via: "mirror", text: text.slice(0, 800000), title: mirror.title, savedTo: mirror.savedTo, attempts };
      }
    } catch (e) {
      record({ step: "mirror", error: String(e.message || e) });
    }
  }

  return { ok: false, via: null, text: "", title: "", attempts };
}
