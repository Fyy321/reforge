// MCP 服务器入口：stdio JSON-RPC 2.0，任何支持 MCP 的 AI 客户端都能接。
// 协议手写实现，零运行时依赖。
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fetchPage } from "./fetch.js";
import { stealthFetch } from "./stealth.js";
import { renderPage } from "./render.js";
import { extractWechatArticle, parseWechatHtml } from "./wechat.js";
import { detectBinary, parsePE, parseELF, parseMachO, parseMachOFat, extractStrings } from "./binary.js";
import { analyzeJavaScript, extractChunks } from "./js.js";
import { solveCaptcha } from "./captcha.js";
import { tryBypassPaywall, mirrorArticle, snapshotFetch, paywallCandidateUrls } from "./paywall.js";
import { createSession, sessionHeaders, extractTokensFromHtml, cdpTokenExtractionScript } from "./login.js";
import { extractTitle, extractLinks, extractMainText, extractImages, parseMeta } from "./html.js";

const TOOLS = [
  {
    name: "fetch_page",
    description:
      "抓取网页原始内容（HTML/文本）。带 SSRF 防护、浏览器头、编码识别、反爬选项（UA 轮换/Cookie/代理/退避重试）。",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "目标 URL" },
        cookie: { type: "string", description: "可选 Cookie 字符串" },
        headers: { type: "object", description: "附加请求头" },
        allow_private: { type: "boolean", description: "允许访问内网/本机地址（默认 false）" },
        stealth: { type: "boolean", description: "启用反爬模式（UA 轮换+抖动+重试）" },
        proxy_url: { type: "string", description: "HTTP(S) 代理，如 http://127.0.0.1:7890" },
        binary: { type: "boolean", description: "按二进制下载（返回 base64）" },
      },
      required: ["url"],
    },
  },
  {
    name: "render_page",
    description: "无头浏览器渲染页面（本机 Chrome/Edge --headless，零依赖），拿 JS 渲染后的 DOM 文本；无浏览器时退回普通抓取。",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string" },
        wait_ms: { type: "number", description: "等待 JS 执行时间（毫秒），默认 5000" },
        user_agent: { type: "string" },
        allow_private: { type: "boolean" },
      },
      required: ["url"],
    },
  },
  {
    name: "extract_wechat_article",
    description: "提取微信公众号文章：标题/作者/公众号/发布时间/摘要/正文/图片/链接。支持 mp.weixin.qq.com 直链。",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "公众号文章 URL（mp.weixin.qq.com）" },
        cookie: { type: "string", description: "可选微信 Cookie" },
      },
      required: ["url"],
    },
  },
  {
    name: "parse_wechat_html",
    description: "从已抓到的 HTML 文本中解析公众号文章（不联网），适用任何来源的页面源码。",
    inputSchema: {
      type: "object",
      properties: {
        html: { type: "string" },
        page_url: { type: "string", description: "页面地址（用于拼相对图片/链接）" },
      },
      required: ["html"],
    },
  },
  {
    name: "mirror_article",
    description: "全文镜像：下载页面并把图片/资源内联为单文件 HTML 存到本地目录，移除付费墙遮罩与脚本。",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string" },
        out_dir: { type: "string", description: "保存目录（默认 ./mirrors）" },
        filename: { type: "string" },
        cookie: { type: "string" },
        headers: { type: "object" },
        allow_private: { type: "boolean" },
        max_images: { type: "number" },
      },
      required: ["url"],
    },
  },
  {
    name: "bypass_paywall",
    description:
      "付费/登录墙绕过组合拳：直接抓取→结构化全文(JSON-LD/articleBody)→AMP/打印/阅读器变体→archive 快照→全文镜像。返回最长可得的全文。",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string" },
        min_text_length: { type: "number", description: "认为拿到全文的最短正文字符数（默认 300）" },
        cookie: { type: "string" },
        headers: { type: "object" },
        allow_private: { type: "boolean" },
        mirror_out_dir: { type: "string", description: "镜像保存目录（可选）" },
      },
      required: ["url"],
    },
  },
  {
    name: "paywall_candidates",
    description: "生成目标页的 AMP/打印/阅读器变体与去追踪参数 URL 候选列表，供逐一代试。",
    inputSchema: {
      type: "object",
      properties: { url: { type: "string" } },
      required: ["url"],
    },
  },
  {
    name: "snapshot_fetch",
    description: "从 archive.org / archive.ph 取页面历史快照全文。",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string" },
        service: { type: "string", enum: ["archive", "archivetoday"], description: "快照服务，默认 archive" },
        allow_private: { type: "boolean" },
      },
      required: ["url"],
    },
  },
  {
    name: "solve_captcha",
    description:
      "验证码处理：session-reuse（会话复用跳过）/ token-replay（令牌回放）/ ocr（OCR 服务）/ slider（生成滑块轨迹脚本）/ manual（拉取图片给人判读）。",
    inputSchema: {
      type: "object",
      properties: {
        mode: { type: "string", enum: ["session-reuse", "token-replay", "ocr", "slider", "manual"] },
        session: { type: "object", description: "会话 {cookie, headers, tokens}" },
        token: { type: "string", description: "token-replay 模式：已有验证令牌" },
        header_name: { type: "string" },
        param_name: { type: "string" },
        image_url: { type: "string", description: "ocr/manual 模式：验证码图片地址" },
        image_base64: { type: "string" },
        solver_url: { type: "string", description: "OCR 服务地址（占位 SOLVER_URL）" },
        api_key: { type: "string", description: "OCR 服务密钥（占位 SOLVER_API_KEY）" },
        trajectory: { type: "object", description: "滑块轨迹参数 {startX, endX, startY, durationMs}" },
        allow_private: { type: "boolean" },
      },
      required: ["mode"],
    },
  },
  {
    name: "new_session",
    description: "创建可复用的登录会话（Cookie/请求头/令牌），之后所有工具可携带会话绕过登录墙。",
    inputSchema: {
      type: "object",
      properties: {
        cookie: { type: "string" },
        cookies: { type: "object", description: "按域名的 Cookie 表 {host: {name: value}}" },
        headers: { type: "object" },
        tokens: { type: "object", description: "令牌表 {accessToken, csrf, ...}" },
      },
    },
  },
  {
    name: "extract_tokens",
    description: "从页面 HTML 里提取 CSRF/token/accessToken/Authorization 等常见令牌。",
    inputSchema: {
      type: "object",
      properties: { html: { type: "string" } },
      required: ["html"],
    },
  },
  {
    name: "cdp_token_plan",
    description: "返回从受控浏览器（CDP）提取 localStorage/cookie 令牌的步骤脚本（占位方案）。",
    inputSchema: {
      type: "object",
      properties: { origin: { type: "string", description: "目标站点 origin，如 https://example.com" } },
      required: ["origin"],
    },
  },
  {
    name: "inspect_binary",
    description: "识别并解析二进制文件：PE（机器类型/节/导入表）、ELF（架构/段/节）、Mach-O、FAT、WASM、ZIP 等。",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "本地文件路径" },
        bytes_base64: { type: "string", description: "或直接给 base64 字节" },
        max_strings: { type: "number", description: "提取字符串上限（默认 300）" },
      },
    },
  },
  {
    name: "analyze_javascript",
    description: "静态解析 JS/Electron 包：打包器指纹、require/import 依赖、URL、接口端点、源码映射、动态执行点、敏感形字符串。",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "本地 JS 文件路径" },
        source: { type: "string", description: "或直接给源码文本" },
      },
    },
  },
  {
    name: "page_summary",
    description: "抓取并提取页面摘要：标题/meta/正文/链接/图片/脚本清单。",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string" },
        cookie: { type: "string" },
        headers: { type: "object" },
        allow_private: { type: "boolean" },
      },
      required: ["url"],
    },
  },
  {
    name: "qidian_rank",
    description:
      "抓取起点中文网榜单：无头浏览器执行反爬挑战 + 自定义字体解码还原真实票数。kind: yuepiao|hotsale|recom|collect|readindex|fans|signnewbook|pubnewbook",
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string", description: "榜单类型，默认 yuepiao" },
        wait_ms: { type: "number", description: "无头渲染等待时间（默认 12000）" },
      },
    },
  },
  {
    name: "qidian_chapters",
    description: "起点章节目录：全部卷/章节（含字数、更新时间、免费/付费标记）。",
    inputSchema: {
      type: "object",
      properties: {
        book_id: { type: "string" },
        wait_ms: { type: "number" },
      },
      required: ["book_id"],
    },
  },
  {
    name: "qidian_chapter_content",
    description:
      "起点章节正文：免费章节直接返回全文；付费章节需提供已订阅账号的 cookie（会话权益校验在服务端）。",
    inputSchema: {
      type: "object",
      properties: {
        book_id: { type: "string" },
        chapter_id: { type: "string" },
        cookie: { type: "string", description: "已登录/已订阅账号的 Cookie（可选）" },
        wait_ms: { type: "number" },
      },
      required: ["book_id", "chapter_id"],
    },
  },
  {
    name: "chapter_mirror_search",
    description: "在搜索引擎与聚合镜像站检索章节全文候选来源。",
    inputSchema: {
      type: "object",
      properties: {
        book: { type: "string" },
        chapter: { type: "string" },
      },
      required: ["book", "chapter"],
    },
  },
];

const sessions = new Map(); // sessionId -> session

function buildServer(input, output) {
  let nextId = 0;
  const pending = new Map();

  const send = (msg) => {
    const payload = JSON.stringify(msg);
    output.write(`Content-Length: ${Buffer.byteLength(payload)}\r\n\r\n${payload}`);
  };

  input.on("data", (chunk) => {
    buffer += chunk.toString("utf-8");
    parseFrames();
  });

  let buffer = "";
  function parseFrames() {
    while (true) {
      const idx = buffer.indexOf("\r\n\r\n");
      if (idx === -1) return;
      const headerText = buffer.slice(0, idx);
      const m = headerText.match(/Content-Length:\s*(\d+)/i);
      if (!m) {
        buffer = buffer.slice(idx + 4);
        continue;
      }
      const len = Number(m[1]);
      if (buffer.length < idx + 4 + len) return;
      const body = buffer.slice(idx + 4, idx + 4 + len);
      buffer = buffer.slice(idx + 4 + len);
      let msg;
      try {
        msg = JSON.parse(body);
      } catch {
        continue;
      }
      handleMessage(msg);
    }
  }

  function handleMessage(msg) {
    if (msg.method === "initialize") {
      send({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "reforge", version: "0.1.0" },
        },
      });
      return;
    }
    if (msg.method === "notifications/initialized") return;
    if (msg.method === "ping") {
      send({ jsonrpc: "2.0", id: msg.id, result: {} });
      return;
    }
    if (msg.method === "tools/list") {
      send({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          tools: TOOLS.map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
          })),
        },
      });
      return;
    }
    if (msg.method === "tools/call") {
      const { name, arguments: args } = msg.params;
      runTool(name, args || {})
        .then((result) => {
          send({
            jsonrpc: "2.0",
            id: msg.id,
            result: {
              content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
              isError: false,
            },
          });
        })
        .catch((e) => {
          send({
            jsonrpc: "2.0",
            id: msg.id,
            result: {
              content: [{ type: "text", text: `error: ${e.message || e}` }],
              isError: true,
            },
          });
        });
      return;
    }
    send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `unknown method ${msg.method}` } });
  }
}

async function runTool(name, args) {
  switch (name) {
    case "fetch_page": {
      const opts = {
        cookie: args.cookie,
        headers: args.headers,
        allowPrivate: Boolean(args.allow_private),
        proxyUrl: args.proxy_url,
        binary: Boolean(args.binary),
      };
      const res = args.stealth ? await stealthFetch(args.url, opts) : await fetchPage(args.url, opts);
      if (args.binary) {
        return {
          status: res.status,
          finalUrl: res.finalUrl,
          contentType: res.headers["content-type"],
          byteLength: res.byteLength,
          base64: Buffer.from(res.bodyBuffer || Buffer.from(res.bodyText, "binary")).toString("base64"),
        };
      }
      return {
        status: res.status,
        finalUrl: res.finalUrl,
        headers: res.headers,
        byteLength: res.byteLength,
        truncated: res.truncated,
        text: res.bodyText.slice(0, 800000),
      };
    }
    case "render_page": {
      const r = await renderPage(args.url, {
        waitMs: args.wait_ms || 5000,
        userAgent: args.user_agent,
        allowPrivate: Boolean(args.allow_private),
      });
      return { rendered: r.rendered, browser: r.browser, status: r.status, html: r.html.slice(0, 800000) };
    }
    case "extract_wechat_article":
      return extractWechatArticle(args.url, { cookie: args.cookie });
    case "parse_wechat_html":
      return parseWechatHtml(args.html, args.page_url || "");
    case "mirror_article": {
      const outDir = args.out_dir || join(process.cwd(), "mirrors");
      return mirrorArticle(args.url, {
        outDir,
        filename: args.filename,
        session: { cookie: args.cookie, headers: args.headers },
        allowPrivate: Boolean(args.allow_private),
        maxImages: args.max_images || 200,
      });
    }
    case "bypass_paywall":
      return tryBypassPaywall(args.url, {
        minTextLength: args.min_text_length || 300,
        session: { cookie: args.cookie, headers: args.headers },
        allowPrivate: Boolean(args.allow_private),
        mirrorOutDir: args.mirror_out_dir || null,
      });
    case "paywall_candidates":
      return { candidates: paywallCandidateUrls(args.url) };
    case "snapshot_fetch":
      return snapshotFetch(args.url, { allowPrivate: Boolean(args.allow_private), service: args.service || "archive" });
    case "solve_captcha":
      return solveCaptcha({
        mode: args.mode,
        session: args.session,
        token: args.token,
        headerName: args.header_name,
        paramName: args.param_name,
        imageUrl: args.image_url,
        imageBase64: args.image_base64,
        solverUrl: args.solver_url,
        apiKey: args.api_key,
        trajectory: args.trajectory,
        allowPrivate: Boolean(args.allow_private),
      });
    case "new_session": {
      const session = createSession({
        cookie: args.cookie,
        cookies: args.cookies,
        headers: args.headers,
        tokens: args.tokens,
      });
      const id = `s${Date.now().toString(36)}`;
      sessions.set(id, session);
      return { session_id: id, exported: { cookie: args.cookie, cookies: args.cookies, headers: args.headers, tokens: args.tokens } };
    }
    case "extract_tokens":
      return { tokens: extractTokensFromHtml(args.html) };
    case "cdp_token_plan":
      return cdpTokenExtractionScript(args.origin);
    case "inspect_binary": {
      let buf;
      if (args.path) buf = await readFile(args.path);
      else if (args.bytes_base64) buf = Buffer.from(args.bytes_base64, "base64");
      else throw new Error("需要 path 或 bytes_base64");
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
      const strings = extractStrings(buf, { max: args.max_strings || 300 });
      return { detected: d.type, size: buf.length, parsed, strings };
    }
    case "analyze_javascript": {
      let source;
      if (args.path) source = await readFile(args.path, "utf-8");
      else if (args.source) source = args.source;
      else throw new Error("需要 path 或 source");
      const analysis = analyzeJavaScript(source);
      analysis.chunks = extractChunks(source);
      return analysis;
    }
    case "page_summary": {
      const res = await fetchPage(args.url, {
        cookie: args.cookie,
        headers: args.headers,
        allowPrivate: Boolean(args.allow_private),
      });
      const html = res.bodyText;
      return {
        url: res.finalUrl,
        status: res.status,
        title: extractTitle(html),
        meta: parseMeta(html),
        text: extractMainText(html).slice(0, 200000),
        links: extractLinks(html, res.finalUrl).slice(0, 300),
        images: extractImages(html, res.finalUrl).slice(0, 100),
      };
    }
    case "qidian_rank": {
      const { getQidianRank } = await import("./qidian.js");
      const r = await getQidianRank(args.kind || "yuepiao", { waitMs: args.wait_ms || 12000 });
      return { kind: r.kind, name: r.name, url: r.url, browser: r.browser, panels: r.panels, count: r.count, books: r.books };
    }
    case "qidian_chapters": {
      const { getChapterList } = await import("./qidian-chapter.js");
      return getChapterList(String(args.book_id), { waitMs: args.wait_ms || 14000 });
    }
    case "qidian_chapter_content": {
      const { getChapterContent } = await import("./qidian-chapter.js");
      return getChapterContent(String(args.book_id), String(args.chapter_id), {
        waitMs: args.wait_ms || 18000,
        cookie: args.cookie || null,
      });
    }
    case "chapter_mirror_search": {
      const { chapterMirrorSearch } = await import("./mirror-search.js");
      return chapterMirrorSearch(String(args.book), String(args.chapter));
    }
    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

// 供库内复用
export { TOOLS, runTool, buildServer };
