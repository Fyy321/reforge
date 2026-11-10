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
const requests = [];
const responses = [];
ws.addEventListener("message", (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve } = pending.get(msg.id);
    pending.delete(msg.id);
    resolve(msg.result);
  } else if (msg.method === "Network.requestWillBeSent") {
    requests.push({ url: msg.params.request.url, method: msg.params.request.method });
  } else if (msg.method === "Network.responseReceived") {
    responses.push({ url: msg.params.response.url, status: msg.params.response.status, mime: msg.params.response.mimeType, requestId: msg.params.requestId });
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

await send("Page.navigate", { url: "https://vipreader.qidian.com/chapter/925357978/" });
await new Promise((r) => setTimeout(r, 20000));

console.log("--- 请求 ---");
for (const r of requests) console.log(r.method, r.url.slice(0, 160));
console.log("--- 响应 ---");
for (const r of responses) console.log(r.status, r.mime, r.url.slice(0, 160));

// 拉取 XHR 响应体
for (const r of responses) {
  if (/chapter|content/i.test(r.url) && r.mime.includes("json")) {
    try {
      const body = await send("Network.getResponseBody", { requestId: r.requestId });
      const txt = body?.body || "";
      console.log("BODY", r.url.slice(0, 120), "len:", txt.length);
      console.log(txt.slice(0, 1500));
    } catch (e) {
      console.log("BODY err", e.message);
    }
  }
}

try { ws.close(); } catch {}
child.kill();
try { rmSync(profileDir, { recursive: true, force: true }); } catch {}
