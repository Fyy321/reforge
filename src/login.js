// 登录/会话模块：会话恢复、Cookie 注入、令牌提取（本地夹具/占位目标）。
// 思路：登录一次，导出会话（Cookie + 本地存储令牌 + 头部），
// 之后所有抓取携带该会话即可绕过登录墙；令牌来自浏览器存储的由 CDP 提取。

import { CookieJar } from "./stealth.js";

export function createSession(input = {}) {
  const jar = new CookieJar();
  const session = {
    jar,
    cookie: null,
    headers: {},
    tokens: {},
    meta: {},
  };
  if (input.cookie) {
    session.cookie = input.cookie;
    for (const part of String(input.cookie).split(/;\s*/)) {
      const eq = part.indexOf("=");
      if (eq > 0) jar.set(input.domain || "*", part.slice(0, eq), part.slice(eq + 1));
    }
  }
  if (input.cookies && typeof input.cookies === "object") jar.fromJSON(input.cookies);
  if (input.headers) session.headers = { ...input.headers };
  if (input.tokens) session.tokens = { ...input.tokens };
  return session;
}

// 从页面 HTML/脚本里提取常见令牌（占位逻辑，真实场景配合 CDP 读 localStorage）。
export function extractTokensFromHtml(html) {
  const tokens = {};
  const patterns = {
    csrf: /csrf[-_]?token["'\s>]*?(?:content)?\s*[:=]\s*["']?([a-zA-Z0-9_\-]{8,128})/i,
    token: /"token"\s*:\s*"([a-zA-Z0-9._\-]{16,})"/,
    accessToken: /"access_?token"\s*:\s*"([a-zA-Z0-9._\-]{16,})"/i,
    bearer: /["']Authorization["']\s*:\s*["']Bearer\s+([a-zA-Z0-9._\-]{16,})["']/i,
  };
  for (const [name, re] of Object.entries(patterns)) {
    const m = html.match(re);
    if (m) tokens[name] = m[1];
  }
  return tokens;
}

// 会话请求头：Cookie + Authorization + 自定义
export function sessionHeaders(session, url) {
  const u = new URL(url);
  const jarCookie = session.jar ? session.jar.headerFor(u.hostname) : null;
  const cookie = session.cookie || jarCookie;
  const headers = { ...(session.headers || {}) };
  if (cookie) headers.Cookie = cookie;
  if (session.tokens?.accessToken) headers.Authorization = `Bearer ${session.tokens.accessToken}`;
  if (session.tokens?.csrf) headers["X-CSRF-Token"] = session.tokens.csrf;
  return headers;
}

// CDP 提取浏览器 localStorage/token 的占位脚本：
// 连接到受控浏览器（--remote-debugging-port=9222）读取目标域存储。
export function cdpTokenExtractionScript(targetOrigin) {
  return {
    target: targetOrigin,
    steps: [
      { endpoint: "http://127.0.0.1:9222/json", note: "列出 tab，取 webSocketDebuggerUrl" },
      { method: "Runtime.evaluate", expression: "JSON.stringify(Object.entries(localStorage))", note: "读出 localStorage" },
      { method: "Runtime.evaluate", expression: "document.cookie", note: "读出 cookie" },
    ],
    sampleExtraction: "localStorage.token / localStorage.access_token / localStorage.USER_INFO",
  };
}
