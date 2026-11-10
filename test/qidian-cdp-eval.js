import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const browserPath = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const url = process.argv[2];

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

// 第一次导航：触发 probe，等待自刷新
await send("Page.navigate", { url });
await new Promise((r) => setTimeout(r, 15000));
// 第二次导航（同一会话，cookie 已暖）
await send("Page.navigate", { url: url + (url.includes("?") ? "&" : "?") + "t=2" });
await new Promise((r) => setTimeout(r, 15000));
// 滚动到底触发懒加载
await send("Runtime.evaluate", { expression: "window.scrollTo(0, document.body.scrollHeight)" });
await new Promise((r) => setTimeout(r, 12000));
const evalRes = await send("Runtime.evaluate", {
  expression: `JSON.stringify({totals: [...document.querySelectorAll('.book-right-info .total')].slice(0,5).map(d=>d.innerText.trim()), cookie: document.cookie.slice(0,120)})`,
  returnByValue: true,
});
console.log("RESULT", evalRes?.result?.value || "");
try { ws.close(); } catch {}
child.kill();
try { rmSync(profileDir, { recursive: true, force: true }); } catch {}
