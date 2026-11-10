// Qidian 榜单：无头渲染 + 反爬字体解码 + 结构化解析。
import { renderWithChrome, renderWithCdp } from "./render.js";
import { withCdp } from "./qidian-chapter.js";
import { fetchPage } from "./fetch.js";
import { buildFontDecoder } from "./font.js";

const RANK_KINDS = {
  yuepiao: { name: "月票榜", url: "https://www.qidian.com/rank/yuepiao/" },
  hotsales: { name: "畅销榜", url: "https://www.qidian.com/rank/hotsales/" },
  hotsale: { name: "畅销榜", url: "https://www.qidian.com/rank/hotsales/", alias: true },
  recom: { name: "推荐榜", url: "https://www.qidian.com/rank/recom/" },
  collect: { name: "收藏榜", url: "https://www.qidian.com/rank/collect/" },
  readindex: { name: "阅读指数榜", url: "https://www.qidian.com/rank/readindex/" },
  retention: { name: "留存榜", url: "https://www.qidian.com/rank/retention/" },
  potential: { name: "潜力榜", url: "https://www.qidian.com/rank/potential/" },
  newfans: { name: "书友榜", url: "https://www.qidian.com/rank/newfans/" },
  vipup: { name: "更新榜", url: "https://www.qidian.com/rank/vipup/" },
  vipcollect: { name: "VIP收藏榜", url: "https://www.qidian.com/rank/vipcollect/" },
  pubnewbook: { name: "未签约新书榜", url: "https://www.qidian.com/rank/pubnewbook/" },
  signnewbook: { name: "签约新书榜", url: "https://www.qidian.com/rank/signnewbook/" },
  mm: { name: "女生精选榜", url: "https://www.qidian.com/rank/mm/" },
};

// 渲染榜单页（执行 Qidian 的 probe 挑战后取真实 DOM）
export async function fetchQidianRankPage(kind, { waitMs = 12000, timeoutMs = 90000, browserPath = null } = {}) {
  const conf = RANK_KINDS[kind];
  if (!conf) throw new Error(`未知榜单: ${kind}（可选: ${Object.keys(RANK_KINDS).join(", ")}）`);
  const effectivePath = browserPath || process.env.BROWSER_PATH || null;
  let html = "";
  let browser = null;
  // 挑战页可能首次 202 或浏览器偶发崩溃：重试；优先 CDP（能等 XHR 完成）
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      if (typeof WebSocket !== "undefined") {
        const r = await renderWithCdp(conf.url, { waitMs: waitMs, timeoutMs: timeoutMs, browserPath: effectivePath });
        html = r.html;
        browser = r.browser;
      } else {
        const r = await renderWithChrome(conf.url, { waitMs, timeoutMs, browserPath: effectivePath, retries: 2 });
        html = r.html;
        browser = r.browser;
      }
    } catch {
      html = "";
    }
    if (html.length > 2000 && !html.includes("probe.js")) break;
    await new Promise((res) => setTimeout(res, 1500));
  }
  if (html.length < 2000 || html.includes("probe.js")) {
    throw new Error("渲染结果疑似仍被反爬挑战拦截");
  }
  return { kind, name: conf.name, url: conf.url, html, browser };
}

// 下载并缓存 woff 字体解码器
async function fontDecoders(html) {
  const decoders = new Map();
  const fonts = [];
  const ffRe = /@font-face\s*{([^}]*)}/g;
  let m;
  while ((m = ffRe.exec(html)) !== null) {
    const body = m[1];
    const fam = body.match(/font-family:\s*['"]?([^;'"]+)/);
    const woff = body.match(/url\(['"]?([^'")\s]+\.woff[^'")\s]*)/);
    if (fam && woff) {
      const family = fam[1].trim();
      const url = woff[1];
      if (!fonts.some((f) => f.family === family && f.url === url)) fonts.push({ family, url });
    }
  }
  for (const f of fonts) {
    try {
      const res = await fetchPage(f.url, { binary: true, maxBytes: 2 * 1024 * 1024 });
      const decoder = buildFontDecoder(res.bodyBuffer);
      decoders.set(f.family, decoder);
    } catch {
      /* 单个字体失败不影响整体 */
    }
  }
  return decoders;
}

// 把 HTML 里 <span class="FAMILY">乱码</span> 替换为解码后的数字
function decodeSpans(html, decoders) {
  let out = html;
  for (const [family, decoder] of decoders) {
    const re = new RegExp(`<span class=["']${family}["']>([^<]*)</span>`, "g");
    out = out.replace(re, (_all, scrambled) => `<span>${decoder.decode(scrambled)}</span>`);
  }
  return out;
}

// 解析榜单 HTML（完整列表页与首页预览都支持），返回结构化榜单。
export async function parseQidianRank(html) {
  const decoders = await fontDecoders(html);
  const decodedHtml = decodeSpans(html, decoders);
  const out = { books: [], panels: [] };

  // 完整列表页结构
  const itemRe = /<li[^>]*data-rid="(\d+)"[^>]*>([\s\S]*?)<\/li>/g;
  let m;
  while ((m = itemRe.exec(decodedHtml)) !== null) {
    const rid = Number(m[1]);
    const block = m[2].replace(/<style[\s\S]*?<\/style>/gi, "");
    const nameMatch = block.match(/<a[^>]*data-bid="(\d+)"[^>]*title="[^"]*"[^>]*>([^<]+)<\/a>/);
    if (!nameMatch) continue;
    const authorMatch = block.match(/<a class="name"[^>]*>([^<]+)<\/a>/);
    const typeMatch = block.match(/<a[^>]*href="\/\/www\.qidian\.com\/[a-z0-9]+"[^>]*>([^<]+)<\/a>(?:\s*<i>·<\/i>)/);
    const totalDiv = block.match(/<div class="total">([\s\S]*?)<\/div>/);
    const total = totalDiv ? totalDiv[1].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim() : "";
    const introMatch = block.match(/<p class="intro"[^>]*>([\s\S]*?)<\/p>/);
    const stateMatch = block.match(/<em>\|<\/em><span>([^<]+)<\/span>/);
    const updateMatch = block.match(/<p class="update"><a[^>]*>([^<]+)<\/a><em>·<\/em><span>([^<]+)<\/span>/);
    const coverMatch = block.match(/<img src="(\/\/bookcover[^"]+)"/);
    out.books.push({
      rank: rid,
      title: nameMatch[2].trim(),
      bid: nameMatch[1],
      url: "https://www.qidian.com/book/" + nameMatch[1] + "/",
      author: authorMatch ? authorMatch[1].trim() : "",
      category: typeMatch ? typeMatch[1].trim() : "",
      status: stateMatch ? stateMatch[1].trim() : "",
      total,
      latestChapter: updateMatch ? updateMatch[1].trim() : "",
      updateTime: updateMatch ? updateMatch[2].trim() : "",
      intro: introMatch ? introMatch[1].replace(/<[^>]+>/g, "").trim().slice(0, 500) : "",
      cover: coverMatch ? "https:" + coverMatch[1] : "",
    });
  }

  // 首页预览结构（每榜第一名，book-wrap）
  if (out.books.length === 0) {
    const wrapRe = /<h3>NO\.(\d+)<\/h3><h2><a[^>]*href="([^"]+)"[^>]*data-bid="(\d+)"[^>]*class="book-name"[^>]*>([^<]+)<\/a><\/h2><p class="digital(?: f16)?">([^<]*)<\/p><p class="author"><a class="type"[^>]*>([^<]+)<\/a><i>·<\/i><a class="writer"[^>]*>([^<]+)<\/a>/g;
    let w;
    while ((w = wrapRe.exec(decodedHtml)) !== null) {
      out.books.push({
        rank: Number(w[1]),
        title: w[4],
        bid: w[3],
        url: w[2],
        author: w[7],
        category: w[6],
        status: "",
        total: w[5],
        latestChapter: "",
        updateTime: "",
        intro: "",
      });
    }
  }

  // 面板标题
  const panelRe = /<(h1|h2|h3|em)[^>]*>([\s\S]*?)<\/\1>/g;
  while ((m = panelRe.exec(decodedHtml)) !== null) {
    const text = m[2].replace(/<[^>]+>/g, "").trim();
    if (/榜/.test(text) && text.length <= 24) out.panels.push(text);
  }
  out.panels = [...new Set(out.panels)];

  // 去重
  const seen = new Set();
  out.books = out.books.filter((b) => (seen.has(`${b.rank}:${b.bid}`) ? false : (seen.add(`${b.rank}:${b.bid}`), true)));
  out.count = out.books.length;
  return out;
}

// 一步到位：渲染 + 解析
export async function getQidianRank(kind, options = {}) {
  const page = await fetchQidianRankPage(kind, options);
  const parsed = await parseQidianRank(page.html);
  const withTotal = parsed.books.filter((b) => b.total && b.total.length > 0).length;
  if (withTotal < Math.max(3, parsed.books.length / 2)) {
    // PC 端数值可能走 ajax 接口（readindex/newfans/recom/collect/vipcollect）
    try {
      const ajax = await fetchRankAjax(kind, options);
      if (ajax.books && ajax.books.length > 0) {
        const merged = mergeAjaxTotals(parsed, ajax);
        return {
          kind, name: page.name, url: page.url, browser: page.browser,
          dataSource: ajax.source, panels: parsed.panels, count: parsed.count, books: merged,
        };
      }
    } catch { /* ajax 失败继续 */ }
    // 其余榜单（hotsales/retention/vipup）数值由签名接口下发，匿名会话不可得
    return {
      kind, name: page.name, url: page.url, browser: page.browser,
      panels: parsed.panels, count: parsed.count, books: parsed.books,
      totalsNote: "该榜单数值由签名接口异步下发，匿名会话不返回；书目/作者/分类/章节完整。",
    };
  }
  return { kind, name: page.name, url: page.url, browser: page.browser, dataSource: "ssr", panels: parsed.panels, count: parsed.count, books: parsed.books };
}

const AJAX_KIND_SUFFIX = {
  readindex: "指数",
  newfans: "书友",
  recom: "推荐",
  collect: "收藏",
  vipcollect: "VIP收藏",
};

// /ajax/rank/<kind>?pageNum=1&_csrfToken=… 返回 bookList[].statistic
export async function fetchRankAjax(kind, { browserPath = null, waitMs = 14000 } = {}) {
  const url = `https://www.qidian.com/rank/${kind}/`;
  const cdp = await withCdp({ url, waitMs, browserPath });
  try {
    const json = await cdp.evaluate(`(async () => {
      const csrf = (document.cookie.match(/_csrfToken=([^;]+)/) || [])[1] || '';
      const r = await fetch('https://www.qidian.com/ajax/rank/${kind}?pageNum=1&_csrfToken=' + encodeURIComponent(csrf), { credentials: 'include', headers: { 'X-Requested-With': 'XMLHttpRequest' } });
      return JSON.stringify(await r.json());
    })()`);
    const data = JSON.parse(json);
    if (data.code !== 0 || !Array.isArray(data.data?.bookList)) return { books: [], source: null };
    return {
      source: `https://www.qidian.com/ajax/rank/${kind}`,
      suffix: AJAX_KIND_SUFFIX[kind] || "",
      books: data.data.bookList.map((b) => ({
        bookId: String(b.bookId),
        bookName: b.bookName,
        statistic: b.statistic,
        desc: b.desc || "",
      })),
    };
  } finally {
    cdp.dispose();
  }
}

function mergeAjaxTotals(pcParsed, ajax) {
  const byId = new Map(ajax.books.map((b) => [b.bookId, b]));
  const suffix = ajax.suffix || "";
  for (const b of pcParsed.books) {
    const entry = byId.get(b.bid);
    if (!entry) continue;
    if (!b.total || b.total.length === 0) {
      let v = entry.statistic;
      if (v === undefined || v === null) v = "";
      if (typeof v === "number") v = Number.isInteger(v) ? String(v) : v.toFixed(1).replace(/\.0$/, "");
      b.total = `${v}${suffix}`;
    }
    // 简介：ajax 的 desc 是完整简介，比榜单页（可能被截短）长时覆盖
    if (entry.desc && entry.desc.length > (b.intro || "").length) {
      b.intro = entry.desc.slice(0, 1000);
    }
  }
  return pcParsed.books;
}

export { RANK_KINDS };
