// 章节镜像检索：在聚合站/镜像站里找已收录的章节全文（占位目标模式）。
// 用法：给书名+章节名，返回候选来源链接，可用 fetch_page/mirror_article 进一步抓取。
import { fetchPage } from "./fetch.js";
import { stealthFetch } from "./stealth.js";
import { stripTags } from "./html.js";

const SEARCH_ENDPOINTS = [
  {
    name: "bing",
    build: (q) => `https://www.bing.com/search?q=${encodeURIComponent(q)}&count=20`,
    parse: (html, base) => extractResultLinks(html, base),
  },
  {
    name: "baidu",
    build: (q) => `https://www.baidu.com/s?wd=${encodeURIComponent(q)}`,
    parse: (html, base) => extractBaiduLinks(html, base),
  },
];

function extractResultLinks(html, base) {
  const links = [];
  const re = /<a[^>]+href="(https?:\/\/[^"]+)"[^>]*>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const url = m[1];
    if (/bing\.com|microsoft\.com|go\.microsoft|msn\.com/.test(url)) continue;
    if (!links.includes(url)) links.push(url);
  }
  return links.slice(0, 20);
}

function extractBaiduLinks(html, base) {
  const links = [];
  const re = /mu="(https?:\/\/[^"]+)"/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    if (!/baidu\.com/.test(m[1]) && !links.includes(m[1])) links.push(m[1]);
  }
  return links.slice(0, 20);
}

// 常见网文聚合/镜像站点模式（占位清单，部署方自行增删）
export const MIRROR_SITE_PATTERNS = [
  { name: "newxuan", build: (kw) => `https://www.newxuan.com/so/?q=${encodeURIComponent(kw)}` },
  { name: "biquge", build: (kw) => `https://www.biquge5200.cc/modules/article/search.php?searchkey=${encodeURIComponent(kw)}` },
  { name: "69shu", build: (kw) => `https://www.69shu.com/modules/article/search.php?searchkey=${encodeURIComponent(kw)}` },
  { name: "xbiquge", build: (kw) => `https://www.xbiqugu.net/modules/article/search.php?searchkey=${encodeURIComponent(kw)}` },
  { name: "soushu555", build: (kw) => `https://www.soushu555.org/search.html?keyword=${encodeURIComponent(kw)}` },
  { name: "qidian-mirror-api", build: (kw) => `https://api.example-mirror.local/search?q=${encodeURIComponent(kw)}` },
];

// 组合搜索：搜索引擎 + 镜像站直达
export async function chapterMirrorSearch(bookName, chapterTitle, { allowPrivate = false, useStealth = true } = {}) {
  const queries = [
    `${bookName} ${chapterTitle} 全文`,
    `${bookName} ${chapterTitle} 免费阅读`,
    `${bookName} 章节列表 ${chapterTitle}`,
  ];
  const results = [];
  const seen = new Set();

  for (const q of queries) {
    for (const engine of SEARCH_ENDPOINTS) {
      try {
        const url = engine.build(q);
        const res = useStealth
          ? await stealthFetch(url, { allowPrivate, retries: 1 })
          : await fetchPage(url, { allowPrivate });
        const links = engine.parse(res.bodyText, res.finalUrl);
        for (const link of links) {
          if (!seen.has(link)) {
            seen.add(link);
            results.push({ engine: engine.name, query: q, url: link });
          }
        }
      } catch (e) {
        results.push({ engine: engine.name, query: q, error: String(e.message || e) });
      }
    }
  }

  // 镜像站直达（占位域名，返回可尝试的检索 URL）
  const direct = MIRROR_SITE_PATTERNS.map((s) => ({ engine: "mirror-direct", name: s.name, query: bookName, url: s.build(bookName) }));

  return {
    book: bookName,
    chapter: chapterTitle,
    engineResults: results.slice(0, 40),
    mirrorDirects: direct,
    hint: "从候选链接里找到章节页后，用 fetch_page 或 mirror_article 抓取；聚合站通常全文可见。",
  };
}
