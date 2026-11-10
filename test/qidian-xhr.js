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
  child.on("exit", () => { clearTimeout(timer); reject(new Error("exited")); });
});

const port = new URL(wsEndpoint).port;
const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = targets.find((t) => t.type === "page") || targets[0];
const ws = new WebSocket(page.webSocketDebuggerUrl);
let nextId = 0;
const pending = new Map();
const requests = [];
ws.addEventListener("message", (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve } = pending.get(msg.id);
    pending.delete(msg.id);
    resolve(msg.result);
  } else if (msg.method === "Network.requestWillBeSent") {
    const url = msg.params.request.url;
    if (/ajax|rank|hot/i.test(url)) requests.push(url);
  }
});
const send = (method, params = {}) => new Promise((resolve) => {
  const id = ++nextId;
  pending.set(id, { resolve });
  ws.send(JSON.stringify({ id, method, params }));
});
await new Promise((res) => ws.addEventListener("open", res, { once: true }));
await send("Page.enable");
await send("Network.enable");
await send("Runtime.enable");
await send("Page.navigate", { url: "https://www.qidian.com/rank/hotsales/" });
await new Promise((r) => setTimeout(r, 20000));
// 滚动触发懒加载
await send("Runtime.evaluate", { expression: "window.scrollTo(0, document.body.scrollHeight)" });
await new Promise((r) => setTimeout(r, 8000));
const cookieRes = await send("Runtime.evaluate", { expression: "document.cookie", returnByValue: true });
console.log("cookie:", cookieRes?.result?.value || "");
console.log("--- 捕获的 XHR ---");
for (const u of [...new Set(requests)]) console.log(u);
try { ws.close(); } catch {}
child.kill();
rmSync(profileDir, { recursive: true, force: true });
