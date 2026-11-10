import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const browserPath = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const profileDir = mkdtempSync(join(tmpdir(), "reforge-cdp-"));
const child = spawn(browserPath, [
  "--headless=new", "--disable-gpu", "--disable-extensions", "--no-first-run",
  "--disable-blink-features=AutomationControlled", "--mute-audio",
  "--remote-debugging-port=0", `--user-data-dir=${profileDir}`, "about:blank",
], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
let stderr = "";
const wsEndpoint = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("no devtools endpoint")), 30000);
  child.stderr.on("data", (c) => {
    stderr += c.toString("utf-8");
    const m = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/);
    if (m) { clearTimeout(timer); resolve(m[1]); }
  });
  child.on("exit", () => reject(new Error("exited early")));
});
const port = new URL(wsEndpoint).port;
const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = targets.find((t) => t.type === "page") || targets[0];
const ws = new WebSocket(page.webSocketDebuggerUrl);
let nextId = 0;
const pending = new Map();
ws.addEventListener("message", (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve } = pending.get(msg.id);
    pending.delete(msg.id);
    resolve(msg.result);
  }
});
const send = (method, params = {}) => new Promise((resolve) => {
  const id = ++nextId;
  pending.set(id, { resolve });
  ws.send(JSON.stringify({ id, method, params }));
});
await new Promise((res) => ws.addEventListener("open", res, { once: true }));
await send("Page.enable");
await send("Runtime.enable");

await send("Page.navigate", { url: "https://www.qidian.com/rank/hotsales/" });
await new Promise((r) => setTimeout(r, 15000));

const candidates = [
  "hotnews", "hotnew", "buy", "xiaoshou", "sell", "saleRank", "hotsale2", "top100",
  "liucun", "retain", "save", "update", "updates", "vipupdate", "gengxin", "ticket",
  "monthlyticket", "mt", "monthTicket", "yuepiaoV2", "up", "fresh",
];
const evalJs = `(async () => {
  const csrf = (document.cookie.match(/_csrfToken=([^;]+)/) || [])[1] || '';
  const out = {};
  for (const kind of ${JSON.stringify(candidates)}) {
    try {
      const u = 'https://www.qidian.com/ajax/rank/' + kind + '?pageNum=1&_csrfToken=' + encodeURIComponent(csrf);
      const r = await fetch(u, { credentials: 'include', headers: { 'X-Requested-With': 'XMLHttpRequest' } });
      const t = await r.text();
      if (r.status !== 404 && t.length > 100) {
        let info = { status: r.status, len: t.length };
        try { const j = JSON.parse(t); info.code = j.code; info.dataKeys = j.data ? Object.keys(j.data).slice(0, 10) : null; } catch {}
        out[kind] = info;
      }
    } catch {}
  }
  return JSON.stringify(out);
})()`;
const r = await send("Runtime.evaluate", { expression: evalJs, awaitPromise: true, returnByValue: true });
console.log(r?.result?.value || "");
try { ws.close(); } catch {}
child.kill();
try { rmSync(profileDir, { recursive: true, force: true }); } catch {}
