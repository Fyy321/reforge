#!/usr/bin/env node
// Reforge CLI：与 MCP 工具同源的命令行接口。
import { fetchPage } from "./fetch.js";
import { stealthFetch } from "./stealth.js";
import { renderPage } from "./render.js";
import { extractWechatArticle, parseWechatHtml } from "./wechat.js";
import { detectBinary, parsePE, parseELF, parseMachO, parseMachOFat, extractStrings } from "./binary.js";
import { analyzeJavaScript } from "./js.js";
import { solveCaptcha } from "./captcha.js";
import { tryBypassPaywall, mirrorArticle, snapshotFetch, paywallCandidateUrls } from "./paywall.js";
import { extractTitle, extractLinks, extractMainText, extractImages, parseMeta } from "./html.js";
import { readFile } from "node:fs/promises";

const USAGE = `reforge — 通用逆向工具 CLI

用法: reforge <command> [options]

命令:
  fetch <url>                 抓取页面（--cookie --stealth --proxy --binary --allow-private）
  render <url>                无头浏览器渲染（--wait-ms）
  summary <url>               页面摘要（标题/meta/正文/链接/图片）
  wechat <url>                公众号文章提取（--cookie）
  wechat-html <file>          从本地 HTML 文件解析公众号文章
  mirror <url>                全文镜像到本地单文件（--out-dir --filename --cookie）
  paywall <url>               付费/登录墙组合绕过（--min-text --mirror-dir --cookie）
  paywall-candidates <url>    生成 AMP/打印/阅读器变体候选
  snapshot <url>              archive 快照全文（--service archive|archivetoday）
  captcha <mode>              验证码处理（session-reuse|token-replay|ocr|slider|manual）
  session-parse <file>        从 HTML 文件提取令牌
  new-session --cookie "..."  创建登录会话（导出 Cookie/头）
  bin <file>                  二进制识别与解析（PE/ELF/Mach-O/…）
  qidian-rank [kind]          起点榜单抓取（yuepiao|hotsale|recom|collect|readindex|fans|signnewbook|pubnewbook）
  qidian-chapters <bookId>    起点章节目录（含免费/付费标记）
  qidian-chapter <bookId> <chapterId>  起点章节正文（付费章需 --cookie 登录会话）
  chapter-mirror <书名> <章节名>       聚合站/镜像站全文检索
  strings <file>              提取可打印字符串
  js <file>                   JS 包静态分析
  serve                       启动 MCP stdio 服务器（默认入口）
`;

function out(obj) {
  process.stdout.write(JSON.stringify(obj, null, 2) + "\n");
}

function argVal(args, name, alias = null) {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === name || (alias && args[i] === alias)) return args[i + 1];
  }
  return null;
}
function argFlag(args, name) {
  return args.includes(name);
}

const [, , command, ...rest] = process.argv;

async function main() {
  switch (command) {
    case "fetch": {
      const url = rest[0];
      if (!url) throw new Error("缺 URL");
      const cookie = argVal(rest, "--cookie");
      const proxy = argVal(rest, "--proxy");
      const stealth = argFlag(rest, "--stealth");
      const binary = argFlag(rest, "--binary");
      const allowPrivate = argFlag(rest, "--allow-private");
      const res = stealth
        ? await stealthFetch(url, { cookie, proxyUrl: proxy, allowPrivate })
        : await fetchPage(url, { cookie, proxyUrl: proxy, allowPrivate, binary });
      if (binary) {
        out({ status: res.status, finalUrl: res.finalUrl, contentType: res.headers["content-type"], byteLength: res.byteLength, base64: Buffer.from(res.bodyBuffer).toString("base64") });
      } else {
        out({ status: res.status, finalUrl: res.finalUrl, byteLength: res.byteLength, text: res.bodyText });
      }
      break;
    }
    case "render": {
      const url = rest[0];
      if (!url) throw new Error("缺 URL");
      const r = await renderPage(url, { waitMs: Number(argVal(rest, "--wait-ms") || 5000), allowPrivate: argFlag(rest, "--allow-private") });
      out({ rendered: r.rendered, browser: r.browser, html: r.html });
      break;
    }
    case "summary": {
      const url = rest[0];
      if (!url) throw new Error("缺 URL");
      const res = await fetchPage(url, { cookie: argVal(rest, "--cookie"), allowPrivate: argFlag(rest, "--allow-private") });
      const html = res.bodyText;
      out({
        url: res.finalUrl, status: res.status, title: extractTitle(html), meta: parseMeta(html),
        text: extractMainText(html), links: extractLinks(html, res.finalUrl), images: extractImages(html, res.finalUrl),
      });
      break;
    }
    case "wechat": {
      const url = rest[0];
      if (!url) throw new Error("缺 URL");
      out(await extractWechatArticle(url, { cookie: argVal(rest, "--cookie") }));
      break;
    }
    case "wechat-html": {
      const file = rest[0];
      if (!file) throw new Error("缺文件");
      const html = await readFile(file, "utf-8");
      out(parseWechatHtml(html, argVal(rest, "--url") || ""));
      break;
    }
    case "mirror": {
      const url = rest[0];
      if (!url) throw new Error("缺 URL");
      out(await mirrorArticle(url, {
        outDir: argVal(rest, "--out-dir") || "mirrors",
        filename: argVal(rest, "--filename"),
        session: { cookie: argVal(rest, "--cookie") },
        allowPrivate: argFlag(rest, "--allow-private"),
      }));
      break;
    }
    case "paywall": {
      const url = rest[0];
      if (!url) throw new Error("缺 URL");
      out(await tryBypassPaywall(url, {
        minTextLength: Number(argVal(rest, "--min-text") || 300),
        session: { cookie: argVal(rest, "--cookie") },
        allowPrivate: argFlag(rest, "--allow-private"),
        mirrorOutDir: argVal(rest, "--mirror-dir"),
      }));
      break;
    }
    case "paywall-candidates": {
      const url = rest[0];
      if (!url) throw new Error("缺 URL");
      out({ candidates: paywallCandidateUrls(url) });
      break;
    }
    case "snapshot": {
      const url = rest[0];
      if (!url) throw new Error("缺 URL");
      out(await snapshotFetch(url, { service: argVal(rest, "--service") || "archive" }));
      break;
    }
    case "captcha": {
      const mode = rest[0] || "session-reuse";
      out(await solveCaptcha({
        mode,
        session: { cookie: argVal(rest, "--cookie"), headers: {}, tokens: {} },
        token: argVal(rest, "--token"),
        imageUrl: argVal(rest, "--image-url"),
        solverUrl: argVal(rest, "--solver-url"),
        apiKey: argVal(rest, "--api-key"),
      }));
      break;
    }
    case "session-parse": {
      const file = rest[0];
      if (!file) throw new Error("缺文件");
      const html = await readFile(file, "utf-8");
      const { extractTokensFromHtml } = await import("./login.js");
      out({ tokens: extractTokensFromHtml(html) });
      break;
    }
    case "new-session": {
      const { createSession } = await import("./login.js");
      const session = createSession({
        cookie: argVal(rest, "--cookie"),
        headers: {},
        tokens: {},
      });
      out({ exported: { cookie: session.cookie, headers: session.headers, tokens: session.tokens } });
      break;
    }
    case "bin": {
      const file = rest[0];
      if (!file) throw new Error("缺文件");
      const buf = await readFile(file);
      const d = detectBinary(buf);
      let parsed = null;
      try {
        if (d.type === "pe") parsed = parsePE(buf);
        else if (d.type === "elf") parsed = parseELF(buf);
        else if (d.type === "macho") parsed = parseMachO(buf);
        else if (d.type === "macho-fat") parsed = parseMachOFat(buf);
      } catch (e) {
        parsed = { error: String(e.message || e) };
      }
      out({ detected: d.type, size: buf.length, parsed });
      break;
    }
    case "qidian-rank": {
      const kind = rest[0] || "yuepiao";
      const { getQidianRank, RANK_KINDS } = await import("./qidian.js");
      const r = await getQidianRank(kind, { waitMs: Number(argVal(rest, "--wait-ms") || 12000), timeoutMs: Number(argVal(rest, "--timeout-ms") || 90000) });
      out({ kind, name: r.name, url: r.url, browser: r.browser, count: r.count, books: r.books });
      break;
    }
    case "qidian-chapters": {
      const bookId = rest[0];
      if (!bookId) throw new Error("缺 bookId");
      const { getChapterList } = await import("./qidian-chapter.js");
      const r = await getChapterList(bookId, { waitMs: Number(argVal(rest, "--wait-ms") || 14000) });
      out(r);
      break;
    }
    case "qidian-chapter": {
      const bookId = rest[0];
      const chapterId = rest[1];
      if (!bookId || !chapterId) throw new Error("用法: qidian-chapter <bookId> <chapterId> [--cookie \"...\"]");
      const { getChapterContent } = await import("./qidian-chapter.js");
      const r = await getChapterContent(bookId, chapterId, {
        waitMs: Number(argVal(rest, "--wait-ms") || 18000),
        cookie: argVal(rest, "--cookie"),
      });
      out(r);
      break;
    }
    case "chapter-mirror": {
      const book = rest[0];
      const chapter = rest[1];
      if (!book || !chapter) throw new Error("用法: chapter-mirror <书名> <章节名>");
      const { chapterMirrorSearch } = await import("./mirror-search.js");
      out(await chapterMirrorSearch(book, chapter, { useStealth: !argFlag(rest, "--no-stealth") }));
      break;
    }
    case "live": {
      // 植入式实时榜单：后台轮询 + 写盘（供任何语言宿主 pull）
      const { RankLive } = await import("./rank-live.js");
      const kinds = [];
      for (let i = 0; i < rest.length; i++) {
        const a = rest[i];
        if (a === "--interval" || a === "--store-dir" || a === "--wait-ms" || a === "--timeout-ms") { i++; continue; }
        if (a.startsWith("--")) continue;
        kinds.push(a);
      }
      const live = new RankLive({
        kinds: kinds.length ? kinds : undefined,
        intervalMs: Number(argVal(rest, "--interval") || 60000),
        storeDir: argVal(rest, "--store-dir") || null,
        logger: (m) => process.stderr.write(m + "\n"),
        onUpdate: (snap) => {
          for (const [kind, v] of Object.entries(snap.kinds)) {
            const top = (v.books || []).slice(0, 3).map((b) => `${b.rank}.${b.title}(${b.total || "-"})`).join(" ");
            process.stderr.write(`[${new Date().toISOString()}] ${v.name}: ${top}\n`);
          }
        },
        onDiff: (diff) => {
          for (const [kind, events] of Object.entries(diff.kinds)) {
            for (const e of events.slice(0, 5)) {
              process.stderr.write(`  Δ ${kind} ${e.type} ${e.title} ${e.from ?? ""}->${e.to ?? ""}\n`);
            }
          }
        },
      });
      await live.start();
      process.stderr.write("rank-live 已启动（Ctrl+C 退出）\n");
      // 永不退出
      await new Promise(() => {});
      break;
    }
    case "strings": {
      const file = rest[0];
      if (!file) throw new Error("缺文件");
      const buf = await readFile(file);
      out(extractStrings(buf, { max: Number(argVal(rest, "--max") || 300) }));
      break;
    }
    case "js": {
      const file = rest[0];
      if (!file) throw new Error("缺文件");
      const source = await readFile(file, "utf-8");
      out(analyzeJavaScript(source));
      break;
    }
    case "serve":
    case "mcp": {
      const { buildServer } = await import("./mcp-server.js");
      buildServer(process.stdin, process.stdout);
      break;
    }
    default:
      process.stdout.write(USAGE);
      return;
  }
}

main().catch((e) => {
  process.stderr.write(`reforge: ${e.message || e}\n`);
  process.exit(1);
});
