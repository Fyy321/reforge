// 无头浏览器渲染：优先本机 Chrome/Edge --headless（零依赖）。
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CANDIDATES = [
  { key: "chrome", win: ["C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe"], linux: ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser"], mac: ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"] },
  { key: "edge", win: ["C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe", "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe"], linux: ["/usr/bin/microsoft-edge"], mac: ["/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"] },
  { key: "chromium", win: [], linux: ["/usr/bin/chromium"], mac: [] },
];

export function findBrowser() {
  const isWin = process.platform === "win32";
  const isMac = process.platform === "darwin";
  for (const c of CANDIDATES) {
    const paths = isWin ? c.win : isMac ? c.mac : c.linux;
    for (const p of paths) {
      if (p && existsSync(p)) return { key: c.key, path: p };
    }
  }
  return null;
}

// 用 Chrome/Edge --headless=new --dump-dom 渲染。
// 每次使用独立 user-data-dir（隔离 Cookie/状态，避免连跑崩溃）。
export function renderWithChrome(url, { browserPath = null, timeoutMs = 45000, waitMs = 5000, userAgent = null, extraArgs = [], retries = 2 } = {}) {
  const browser = browserPath ? { key: "custom", path: browserPath } : findBrowser();
  if (!browser) return null;
  return new Promise((resolve, reject) => {
    let attempt = 0;
    const run = () => {
      attempt++;
      let profileDir = null;
      try {
        profileDir = mkdtempSync(join(tmpdir(), "reforge-browser-"));
      } catch {
        /* 临时目录创建失败则不带 user-data-dir */
      }
      const args = [
        "--headless=new",
        "--disable-gpu",
        "--disable-extensions",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-background-networking",
        "--disable-component-update",
        "--disable-sync",
        "--disable-blink-features=AutomationControlled",
        "--mute-audio",
        "--hide-scrollbars",
        `--virtual-time-budget=${waitMs}`,
        "--dump-dom",
        ...(profileDir ? [`--user-data-dir=${profileDir}`] : []),
        ...(userAgent ? [`--user-agent=${userAgent}`] : []),
        ...extraArgs,
        url,
      ];
      const child = spawn(browser.path, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
      const chunks = [];
      const errChunks = [];
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          child.kill();
          cleanup();
          reject(new Error("render timeout"));
        }
      }, timeoutMs);
      const cleanup = () => {
        if (profileDir) {
          try { rmSync(profileDir, { recursive: true, force: true }); } catch { /* ignore */ }
        }
      };
      child.stdout.on("data", (c) => chunks.push(c));
      child.stderr.on("data", (c) => errChunks.push(c));
      child.on("error", (e) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          cleanup();
          reject(e);
        }
      });
      child.on("close", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        cleanup();
        const html = Buffer.concat(chunks).toString("utf-8");
        if (code === 0 && html.includes("<html")) {
          resolve({ browser: browser.key, html });
        } else if (attempt < retries) {
          // 崩溃/异常退出：换新 profile 重试
          setTimeout(run, 800);
        } else {
          const err = Buffer.concat(errChunks).toString("utf-8").slice(-2000);
          reject(new Error(`chrome exit ${code}: ${err}`));
        }
      });
    };
    run();
  });
}

// 统一渲染入口：优先 CDP（可等待 XHR 完成），失败回退 dump-dom，再回退普通抓取。
export async function renderPage(rawUrl, options = {}) {
  const browser = browserPathFrom(options) || findBrowser();
  if (browser) {
    try {
      const r = await renderWithCdp(rawUrl, { ...options, browserPath: browser.path });
      return { rendered: true, browser: browser.key, html: r.html, status: 200 };
    } catch {
      /* 继续尝试 dump-dom */
    }
    try {
      const { html } = await renderWithChrome(rawUrl, options);
      return { rendered: true, browser: browser.key, html, status: 200 };
    } catch {
      /* 回退抓取 */
    }
  }
  const { fetchPage } = await import("./fetch.js");
  const page = await fetchPage(rawUrl, { allowPrivate: options.allowPrivate ?? false, headers: options.headers || {} });
  return { rendered: false, browser: null, html: page.bodyText, status: page.status, finalUrl: page.finalUrl };
}

function browserPathFrom(options) {
  if (options.browserPath) return { key: "custom", path: options.browserPath };
  return null;
}

// CDP 渲染：启动带 remote-debugging-port 的浏览器，走 WebSocket 等待加载完成，
// 再取 document.documentElement.outerHTML。Node ≥22 自带全局 WebSocket。
export async function renderWithCdp(url, { browserPath = null, timeoutMs = 60000, waitMs = 6000, userAgent = null, extraArgs = [] } = {}) {
  const browser = browserPath ? { key: "custom", path: browserPath } : findBrowser();
  if (!browser) throw new Error("no browser found");
  if (typeof WebSocket === "undefined") throw new Error("this Node build has no WebSocket");

  let profileDir = null;
  try {
    profileDir = mkdtempSync(join(tmpdir(), "reforge-cdp-"));
  } catch { /* ignore */ }

  const args = [
    "--headless=new",
    "--disable-gpu",
    "--disable-extensions",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-sync",
    "--disable-blink-features=AutomationControlled",
    "--mute-audio",
    "--remote-debugging-port=0",
    ...(profileDir ? [`--user-data-dir=${profileDir}`] : []),
    ...(userAgent ? [`--user-agent=${userAgent}`] : []),
    ...extraArgs,
    "about:blank",
  ];

  const child = spawn(browser.path, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let stderr = "";
  const wsEndpoint = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("cdp: no devtools endpoint")), 30000);
    child.stderr.on("data", (c) => {
      stderr += c.toString("utf-8");
      const m = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (m) {
        clearTimeout(timer);
        resolve(m[1]);
      }
    });
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("exit", (code) => {
      if (!stderr.includes("DevTools listening on")) { clearTimeout(timer); reject(new Error(`browser exited ${code}`)); }
    });
  });

  try {
    // 用浏览器级 ws 拿到 target 列表，找页面 target
    const targets = await cdpTargets(wsEndpoint);
    const page = targets.find((t) => t.type === "page") || targets[0];
    if (!page) throw new Error("cdp: no page target");

    const ws = new WebSocket(page.webSocketDebuggerUrl);
    let nextId = 0;
    const pending = new Map();
    const events = new Map();
    const send = (method, params = {}) =>
      new Promise((resolve, reject) => {
        const id = ++nextId;
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params }));
      });

    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("cdp ws timeout")), timeoutMs);
      ws.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
      ws.addEventListener("error", (e) => { clearTimeout(timer); reject(new Error("cdp ws error")); }, { once: true });
    });
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) {
        const { resolve, reject } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message || "cdp error"));
        else resolve(msg.result);
      } else if (msg.method) {
        const list = events.get(msg.method) || [];
        list.push(msg.params);
        events.set(msg.method, list);
      }
    });

    await send("Page.enable");
    await send("Runtime.enable");
    const loaded = new Promise((resolve) => {
      const check = () => {
        const list = events.get("Page.loadEventFired") || [];
        if (list.length > 0) resolve();
        else setTimeout(check, 100);
      };
      check();
    });
    await send("Page.navigate", { url });
    await Promise.race([loaded, sleep(timeoutMs - 5000)]);
    await sleep(waitMs);

    const result = await send("Runtime.evaluate", {
      expression: "document.documentElement.outerHTML",
      returnByValue: true,
    });
    const html = result?.result?.value ?? "";
    try { ws.close(); } catch { /* ignore */ }
    return { browser: browser.key, html };
  } finally {
    try { child.kill(); } catch { /* ignore */ }
    if (profileDir) {
      try { rmSync(profileDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }
}

async function cdpTargets(browserWsUrl) {
  // 从 browser ws 端点推导 http 端点
  const u = new URL(browserWsUrl);
  const httpPort = u.port;
  const resp = await fetch(`http://127.0.0.1:${httpPort}/json/list`);
  if (!resp.ok) throw new Error(`cdp /json/list ${resp.status}`);
  return resp.json();
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
