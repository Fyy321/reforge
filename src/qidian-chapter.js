// 起点章节正文获取：CDP 过 probe → SSR 页面内嵌 JSON 提取 → 反序列化解码。
// 免费章节：直接拿到全文。付费章节（isBuy=1）：需携带已订阅账号的会话 Cookie，
// 服务端权益校验通过后才会下发正文；否则 content 为空。
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BROWSER_CANDIDATES = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
];

export function findBrowserPath() {
  return BROWSER_CANDIDATES.find((p) => existsSync(p)) || null;
}

// 通用 CDP 会话封装：起浏览器 → 注入 Cookie → 导航 → 等待 → 提供 evaluate/send。
// dispose() 必须被调用以清理浏览器与临时目录。
export async function withCdp({ url, waitMs = 15000, cookies = null, browserPath = null }) {
  const path = browserPath || findBrowserPath();
  if (!path) throw new Error("未找到 Chrome/Edge 浏览器");
  if (typeof WebSocket === "undefined") throw new Error("该 Node 版本无 WebSocket");

  const profileDir = mkdtempSync(join(tmpdir(), "reforge-cdp-"));
  const child = spawn(path, [
    "--headless=new", "--disable-gpu", "--disable-extensions", "--no-first-run",
    "--disable-blink-features=AutomationControlled", "--mute-audio",
    "--window-size=1200,900", "--remote-debugging-port=0",
    `--user-data-dir=${profileDir}`, "about:blank",
  ], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });

  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    try { wsRef?.close(); } catch {}
    try { child.kill(); } catch {}
    setTimeout(() => {
      try { rmSync(profileDir, { recursive: true, force: true }); } catch {}
    }, 300);
  };
  let wsRef = null;

  try {
    let stderr = "";
    const wsEndpoint = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("cdp: no devtools endpoint")), 30000);
      child.stderr.on("data", (c) => {
        stderr += c.toString("utf-8");
        const m = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/);
        if (m) { clearTimeout(timer); resolve(m[1]); }
      });
      child.on("exit", () => reject(new Error("browser exited early")));
    });
    const port = new URL(wsEndpoint).port;
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const page = targets.find((t) => t.type === "page") || targets[0];
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    wsRef = ws;
    let nextId = 0;
    const pending = new Map();
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) {
        const { resolve, reject } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message || "cdp error"));
        else resolve(msg.result);
      }
    });
    const send = (method, params = {}) => new Promise((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
    await new Promise((res, rej) => {
      ws.addEventListener("open", res, { once: true });
      ws.addEventListener("error", () => rej(new Error("cdp ws error")), { once: true });
    });
    await send("Page.enable");
    await send("Runtime.enable");
    await send("Network.enable");

    // 注入会话 Cookie（支持字符串或数组）
    if (cookies) {
      const entries = typeof cookies === "string"
        ? cookies.split(/;\s*/).filter(Boolean).map((kv) => { const i = kv.indexOf("="); return { name: kv.slice(0, i).trim(), value: kv.slice(i + 1).trim() }; })
        : cookies;
      for (const c of entries) {
        if (!c.name || !c.value) continue;
        try {
          await send("Network.setCookie", { name: c.name, value: c.value, domain: ".qidian.com" });
        } catch { /* 单条失败忽略 */ }
      }
    }

    const evaluate = async (expression) => {
      const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
      if (r?.exceptionDetails) throw new Error(r.exceptionDetails.text || "evaluate failed");
      return r?.result?.value;
    };

    await send("Page.navigate", { url });
    await new Promise((r) => setTimeout(r, waitMs));

    return { evaluate, send, dispose, url };
  } catch (e) {
    dispose();
    throw e;
  }
}

// 章节列表：书页内同源调用 ajax API（csrf 自动取）
export async function getChapterList(bookId, { browserPath = null, waitMs = 14000 } = {}) {
  const cdp = await withCdp({ url: `https://www.qidian.com/book/${bookId}/`, waitMs, browserPath });
  try {
    const json = await cdp.evaluate(`(async () => {
      const csrf = (document.cookie.match(/_csrfToken=([^;]+)/) || [])[1] || '';
      const r = await fetch('https://www.qidian.com/ajax/book/category?bookId=${bookId}&_csrfToken=' + encodeURIComponent(csrf), {credentials:'include'});
      return JSON.stringify(await r.json());
    })()`);
    const data = JSON.parse(json);
    if (data.code !== 0) throw new Error(`章节列表失败: ${data.msg}`);
    const chapters = [];
    for (const vol of data.data.vs || []) {
      for (const c of vol.cs || []) {
        chapters.push({
          id: c.id,
          volume: vol.vN,
          title: c.cN,
          uuid: c.uuid,
          words: c.cnt,
          updateTime: c.uT,
          free: c.sS === 1,
          url: `https://www.qidian.com/chapter/${bookId}/${c.id}/`,
        });
      }
    }
    return {
      bookId,
      total: data.data.chapterTotalCnt,
      publication: data.data.isPublication,
      chapters,
    };
  } finally {
    cdp.dispose();
  }
}

// 从 SSR 页面 HTML 提取 chapterInfo 嵌入 JSON（括号匹配）
function extractBalancedJson(html, keyLiteral) {
  const idx = html.indexOf(keyLiteral);
  if (idx === -1) return null;
  const brace = html.indexOf("{", idx);
  if (brace === -1) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = brace; i < html.length; i++) {
    const ch = html[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(html.slice(brace, i + 1)); } catch { return null; }
      }
    }
  }
  return null;
}

function extractChapterInfo(html) {
  return extractBalancedJson(html, '"chapterInfo"');
}

function contentHtmlToText(contentHtml) {
  return String(contentHtml || "")
    .replace(/<p>/gi, "\n\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\u00a0/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// 章节正文：免费章节直接全文；付费章节需会话（已订阅账号 Cookie）。
export async function getChapterContent(bookId, chapterId, { browserPath = null, waitMs = 18000, cookie = null } = {}) {
  const url = `https://www.qidian.com/chapter/${bookId}/${chapterId}/`;
  const cdp = await withCdp({ url, waitMs, cookies: cookie, browserPath });
  try {
    const html = await cdp.evaluate("document.documentElement.outerHTML");
    const info = extractChapterInfo(html);
    if (!info) {
      throw new Error("未找到章节数据：页面可能被验证码拦截或章节不存在");
    }
    const content = contentHtmlToText(info.content);
    return {
      bookId,
      chapterId,
      title: typeof info.title === "string" ? info.title : null,
      uuid: info.uuid,
      wordsCount: info.wordsCount,
      isBuy: info.isBuy === 1,
      totalPrice: info.totalPrice,
      prev: info.prev,
      next: info.next,
      freeReadable: !(info.isBuy === 1) || content.length > 0,
      contentLength: content.length,
      content,
    };
  } finally {
    cdp.dispose();
  }
}
