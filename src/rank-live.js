// 植入式榜单实时更新插件（RankLive）。
// 用法（任意 Node 软件，一行接入）：
//   import { RankLive } from "./reforge/src/rank-live.js";
//   const live = new RankLive({ kinds: ["yuepiao","hotsales"], intervalMs: 60000, onUpdate: (r) => {...} });
//   live.start();
//
// 特性：
//  - 常驻无头浏览器会话（probe Cookie 复用，单榜刷新 ~4s）
//  - 八榜并行/串行轮询 + 失败退避 + 数据差异事件（新上榜/排名升降）
//  - 内存快照 + 原子写盘（JSON/CSV），宿主随时 pull
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseQidianRank } from "./qidian.js";

// ---------- 常驻浏览器会话 ----------
class LiveBrowser {
  constructor(ws, child, profileDir) {
    this.ws = ws;
    this.child = child;
    this.profileDir = profileDir;
    this.nextId = 0;
    this.pending = new Map();
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message || "cdp error"));
        else resolve(msg.result);
      }
    });
  }

  static async launch(browserPath) {
    if (typeof WebSocket === "undefined") throw new Error("该 Node 版本无 WebSocket");
    const profileDir = mkdtempSync(join(tmpdir(), "ranklive-"));
    const child = spawn(browserPath, [
      "--headless=new", "--disable-gpu", "--disable-extensions", "--no-first-run",
      "--disable-blink-features=AutomationControlled", "--mute-audio",
      "--window-size=1200,900", "--remote-debugging-port=0",
      `--user-data-dir=${profileDir}`, "about:blank",
    ], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
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
    await new Promise((res, rej) => {
      ws.addEventListener("open", res, { once: true });
      ws.addEventListener("error", () => rej(new Error("cdp ws error")), { once: true });
    });
    const live = new LiveBrowser(ws, child, profileDir);
    await live.send("Page.enable");
    await live.send("Runtime.enable");
    return live;
  }

  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const r = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r?.exceptionDetails) throw new Error(r.exceptionDetails.text || "evaluate failed");
    return r?.result?.value;
  }

  // 导航并等待条件满足（probe 挑战自动重载由页面自身完成，我们只轮询 DOM 条件）
  async navigate(url, { condition = "document.querySelectorAll('li[data-rid]').length >= 5", waitMs = 20000, pollMs = 500 } = {}) {
    await this.send("Page.navigate", { url });
    const deadline = Date.now() + waitMs;
    let last = "";
    while (Date.now() < deadline) {
      try {
        const ok = await this.evaluate(`Boolean(${condition})`);
        if (ok) {
          const html = await this.evaluate("document.documentElement.outerHTML");
          if (html && html.length > 2000 && !html.includes("probe.js")) return html;
        }
        last = "condition-not-met";
      } catch (e) {
        last = String(e.message || e);
      }
      await new Promise((r) => setTimeout(r, pollMs));
    }
    throw new Error(`navigate timeout: ${last}`);
  }

  dispose() {
    try { this.ws.close(); } catch {}
    try { this.child.kill(); } catch {}
    setTimeout(() => {
      try { rmSync(this.profileDir, { recursive: true, force: true }); } catch {}
    }, 400);
  }
}

// ---------- 插件主体 ----------
const DEFAULT_KINDS = ["yuepiao", "hotsales", "retention", "readindex", "newfans", "recom", "collect", "vipup"];

export class RankLive {
  /**
   * @param opts {
   *   kinds: string[]           榜单（默认八个全开）
   *   intervalMs: number        刷新间隔（默认 60000；"实时"可 15000）
   *   jitterMs: number          抖动（默认 2000）
   *   browserPath: string|null  浏览器路径（默认自动找 Edge/Chrome）
   *   storeDir: string|null     持久化目录（写 ranks.json / ranks.csv，原子替换）
   *   onUpdate: fn(snapshot)    每轮完成后回调
   *   onDiff: fn(diff)          排名变化回调（新上榜/上升/下降/掉榜）
   *   logger: fn(msg)           日志
   *   maxErrors: number         连续失败退避阈值（默认 3，触发后间隔 ×2，上限 10 分钟）
   * }
   */
  constructor(opts = {}) {
    this.opts = {
      kinds: DEFAULT_KINDS,
      intervalMs: 60000,
      jitterMs: 2000,
      storeDir: null,
      onUpdate: null,
      onDiff: null,
      logger: null,
      maxErrors: 3,
      ...opts,
    };
    this.browser = null;
    this.timer = null;
    this.busy = false;
    this.running = false;
    this.errors = 0;
    this.backoff = 1;
    this.state = {
      updatedAt: null,
      rounds: 0,
      kinds: {},
      history: [],
    };
  }

  log(msg) {
    if (this.opts.logger) this.opts.logger(`[rank-live] ${msg}`);
  }

  async start() {
    if (this.running) return this;
    this.running = true;
    const { findBrowserPath } = await import("./qidian-chapter.js");
    const browserPath = this.opts.browserPath || findBrowserPath();
    if (!browserPath) throw new Error("未找到 Chrome/Edge 浏览器（植入环境需安装其一）");
    this.browser = await LiveBrowser.launch(browserPath);
    this.log("常驻浏览器会话已建立");
    const tick = async () => {
      if (this.busy) return;
      this.busy = true;
      try {
        await this.refreshOnce();
        this.errors = 0;
        this.backoff = 1;
      } catch (e) {
        this.errors++;
        this.log(`刷新失败(${this.errors}): ${e.message || e}`);
        if (this.errors >= this.opts.maxErrors) this.backoff = Math.min(this.backoff * 2, 10);
      } finally {
        this.busy = false;
      }
      const interval = Math.max(3000, this.opts.intervalMs * this.backoff);
      if (this.running) {
        this.timer = setTimeout(tick, interval + Math.floor(Math.random() * (this.opts.jitterMs || 0)));
      }
    };
    tick();
    return this;
  }

  stop() {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    if (this.browser) {
      this.browser.dispose();
      this.browser = null;
    }
    return this;
  }

  // 单轮全量刷新：串行抓各榜，聚合快照
  async refreshOnce() {
    const previous = this.snapshot();
    const round = {
      startedAt: new Date().toISOString(),
      kinds: {},
    };
    for (const kind of this.opts.kinds) {
      const t0 = Date.now();
      try {
        const rank = await this.crawlKind(kind);
        round.kinds[kind] = { ok: true, name: rank.name, books: rank.books, tookMs: Date.now() - t0, source: rank.source || "page" };
      } catch (e) {
        round.kinds[kind] = { ok: false, error: String(e.message || e), tookMs: Date.now() - t0 };
      }
    }
    this.state.rounds++;
    this.state.updatedAt = round.startedAt;
    this.state.kinds = round.kinds;
    this.state.history.push({ at: round.startedAt, rounds: this.state.rounds });
    if (this.state.history.length > 200) this.state.history.shift();
    if (this.opts.storeDir) this.persist();
    const snap = this.snapshot();
    const diff = this.diffRanks(previous, snap);
    if (diff.changed && this.opts.onDiff) this.opts.onDiff(diff);
    if (this.opts.onUpdate) this.opts.onUpdate(snap);
    return snap;
  }

  // 单榜抓取：页面渲染（常驻会话）→ 字体解码解析 → 缺失数值时走 ajax 接口
  async crawlKind(kind) {
    const { RANK_KINDS } = await import("./qidian.js");
    const conf = RANK_KINDS[kind];
    if (!conf) throw new Error(`未知榜单 ${kind}`);
    const html = await this.browser.navigate(conf.url);
    const parsed = await parseQidianRank(html);
    const withTotal = parsed.books.filter((b) => b.total && b.total.length > 0).length;
    let source = "page";
    if (withTotal < Math.max(3, parsed.books.length / 2)) {
      try {
        const ajaxBooks = await this.browser.evaluate(`(async () => {
          const csrf = (document.cookie.match(/_csrfToken=([^;]+)/) || [])[1] || '';
          const r = await fetch('https://www.qidian.com/ajax/rank/${kind}?pageNum=1&_csrfToken=' + encodeURIComponent(csrf), { credentials: 'include', headers: { 'X-Requested-With': 'XMLHttpRequest' } });
          const j = await r.json();
          return JSON.stringify(j.code === 0 ? (j.data.bookList || []).map(b => ({bookId: String(b.bookId), statistic: b.statistic})) : []);
        })()`);
        const list = JSON.parse(ajaxBooks);
        const suffixMap = { readindex: "指数", newfans: "书友", recom: "推荐", collect: "收藏", vipcollect: "VIP收藏" };
        const byId = new Map(list.map((b) => [b.bookId, b.statistic]));
        for (const b of parsed.books) {
          if (b.total && b.total.length > 0) continue;
          let v = byId.get(b.bid);
          if (v === undefined || v === null) continue;
          if (typeof v === "number") v = Number.isInteger(v) ? String(v) : v.toFixed(1).replace(/\.0$/, "");
          b.total = `${v}${suffixMap[kind] || ""}`;
        }
        source = `ajax:/ajax/rank/${kind}`;
      } catch { /* 保持页面结果 */ }
    }
    return { kind, name: conf.name, url: conf.url, books: parsed.books, source };
  }

  snapshot() {
    const out = {};
    for (const [kind, v] of Object.entries(this.state.kinds)) {
      out[kind] = {
        name: v.name || kind,
        ok: v.ok,
        books: (v.books || []).map((b) => ({ rank: b.rank, bid: b.bid, title: b.title, author: b.author, category: b.category, total: b.total })),
      };
    }
    return { updatedAt: this.state.updatedAt, rounds: this.state.rounds, kinds: out };
  }

  // 与上一轮对比：每榜前 10 的位次变化
  diffRanks(prev, curr) {
    const diff = { changed: false, kinds: {} };
    for (const [kind, cur] of Object.entries(curr.kinds)) {
      const before = (prev.kinds[kind]?.books || []).slice(0, 20);
      const after = (cur.books || []).slice(0, 20);
      const beforeMap = new Map(before.map((b) => [b.bid, b.rank]));
      const afterMap = new Map(after.map((b) => [b.bid, b.rank]));
      const events = [];
      for (const b of after) {
        if (!beforeMap.has(b.bid)) events.push({ type: "new", title: b.title, rank: b.rank });
        else if (beforeMap.get(b.bid) !== b.rank) {
          const delta = beforeMap.get(b.bid) - b.rank;
          if (delta !== 0) events.push({ type: delta > 0 ? "up" : "down", title: b.title, from: beforeMap.get(b.bid), to: b.rank });
        }
      }
      for (const b of before) {
        if (!afterMap.has(b.bid)) events.push({ type: "out", title: b.title, from: b.rank });
      }
      if (events.length > 0) {
        diff.changed = true;
        diff.kinds[kind] = events;
      }
    }
    return diff;
  }

  persist() {
    const dir = this.opts.storeDir;
    fs.mkdirSync(dir, { recursive: true });
    const jsonFile = path.join(dir, "ranks.json");
    const tmp = jsonFile + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(this.snapshot(), null, 2));
    fs.renameSync(tmp, jsonFile);
    const csv = this.toCSV();
    const csvFile = path.join(dir, "ranks.csv");
    const tmpCsv = csvFile + ".tmp";
    fs.writeFileSync(tmpCsv, csv);
    fs.renameSync(tmpCsv, csvFile);
  }

  toCSV() {
    const lines = ["kind,rank,title,author,category,total"];
    for (const [kind, v] of Object.entries(this.state.kinds)) {
      for (const b of v.books || []) {
        const esc = (s) => `"${String(s || "").replace(/"/g, '""')}"`;
        lines.push(`${kind},${b.rank},${esc(b.title)},${esc(b.author)},${esc(b.category)},${esc(b.total)}`);
      }
    }
    return lines.join("\n");
  }
}

export default RankLive;
