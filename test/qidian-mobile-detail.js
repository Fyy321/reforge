import fs from "node:fs";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const browserPath = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const kinds = ["hotsales", "retention", "readindex", "newfans", "vipup"];

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
await send("Emulation.setUserAgentOverride", {
  userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1",
  platform: "iPhone",
});
await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });

for (const kind of kinds) {
  await send("Page.navigate", { url: `https://m.qidian.com/rank/${kind}` });
  await new Promise((r) => setTimeout(r, 18000));
  const r = await send("Runtime.evaluate", {
    expression: `JSON.stringify([...document.querySelectorAll('.y-list__item')].slice(0,3).map(item => {
      const title = (item.querySelector('h2')||{}).innerText || '';
      const sub = (item.querySelector('[class*=subTitle], [class*=desc]')||{}).innerText || '';
      const nums = (item.innerText.match(/\\d{4,}[\\d,.]*/g)||[]);
      return {title: title.trim(), sub: sub.trim().slice(0,120), nums};
    }))`,
    returnByValue: true,
  });
  console.log(kind, "=>", r?.result?.value || "");
}

try { ws.close(); } catch {}
child.kill();
try { rmSync(profileDir, { recursive: true, force: true }); } catch {}
