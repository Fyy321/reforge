// 微信公众号文章提取。
// 支持 mp.weixin.qq.com 直链（含临时链接）与任意含公众号文章标记的 HTML 文本。
import { fetchPage } from "./fetch.js";
import { extractImages, extractLinks, extractMainText, parseMeta, stripTags, decodeEntities } from "./html.js";

const WECHAT_HOSTS = ["mp.weixin.qq.com", "weixin.qq.com"];

// 从 HTML 文本直接提取（不联网），供任意抓到的页面复用
export function parseWechatHtml(html, pageUrl = "") {
  const meta = parseMeta(html);
  const result = {
    ok: true,
    url: pageUrl,
    title: "",
    author: "",
    account: "",
    publishTime: "",
    digest: "",
    cover: "",
    contentText: "",
    images: [],
    links: [],
    meta: {},
  };

  // 标题：meta 优先级最高，其次 h1/var 变量
  result.title =
    meta["og:title"] || meta["twitter:title"] || "";
  if (!result.title) {
    const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
    if (h1) result.title = stripTags(h1[1]).slice(0, 300);
  }
  if (!result.title) {
    const varTitle = html.match(/var\s+msg_title\s*=\s*['"]([\s\S]*?)['"]/i) || html.match(/msg_title\s*=\s*['"]([\s\S]*?)['"]/i);
    if (varTitle) result.title = decodeEntities(varTitle[1]).trim();
  }

  result.author = meta.author || meta["og:article:author"] || "";
  if (!result.author) {
    const varAuthor = html.match(/var\s+author\s*=\s*['"]([\s\S]*?)['"]/i) || html.match(/nickname\s*=\s*['"]([\s\S]*?)['"]/i);
    if (varAuthor) result.author = decodeEntities(varAuthor[1]).trim();
  }
  const accountMatch = html.match(/var\s+user_name\s*=\s*['"]([\s\S]*?)['"]/i) || html.match(/id="js_name"[^>]*>([\s\S]*?)<\//i);
  if (accountMatch) result.account = decodeEntities(accountMatch[1]).trim();

  const timeMatch = html.match(/var\s+ct\s*=\s*['"]?(\d+)['"]?/i) || html.match(/"publish_time"\s*:\s*"?(\d+)"?/i) || html.match(/og:article:published_time" content="([^"]+)"/i);
  if (timeMatch) {
    const t = Number(timeMatch[1]);
    result.publishTime = Number.isFinite(t) && t > 1000000000
      ? new Date(t * 1000).toISOString()
      : String(timeMatch[1]);
  }

  result.digest = meta.description || meta["og:description"] || "";

  // 正文：js_content 优先
  const jsContent = html.match(/<div[^>]*id="js_content"[^>]*>([\s\S]*?)<\/div>\s*(?:<div|<script|<!--)/i);
  let bodyHtml = jsContent ? jsContent[1] : "";
  if (!bodyHtml) {
    const rich = html.match(/id="js_article"[^>]*>([\s\S]*?)<\/div>\s*(?:<div|<script)/i);
    if (rich) bodyHtml = rich[1];
  }
  if (bodyHtml) {
    result.contentText = stripTags(bodyHtml);
  } else {
    result.contentText = extractMainText(html);
  }

  const base = pageUrl || "";
  result.images = extractImages(bodyHtml || html, base || "https://mp.weixin.qq.com/");
  result.links = extractLinks(bodyHtml || html, base || "https://mp.weixin.qq.com/");
  result.meta = meta;

  if (!result.title && !result.contentText) {
    result.ok = false;
    result.reason = "no-wechat-content-found";
  }
  return result;
}

// 联网抓取公众号文章
export async function extractWechatArticle(rawUrl, opts = {}) {
  const u = new URL(rawUrl);
  const hostOk = WECHAT_HOSTS.some((h) => u.hostname === h || u.hostname.endsWith("." + h));
  if (!hostOk) {
    throw new Error("URL 不是微信域名（mp.weixin.qq.com）；如需从其他域名页面提取公众号内容，请先抓取再本地解析。");
  }
  const page = await fetchPage(rawUrl, {
    ...opts,
    headers: {
      ...(opts.headers || {}),
      Referer: "https://mp.weixin.qq.com/",
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 MicroMessenger/7.0.20.1781(0x6700143B) NetType/WIFI MiniProgramEnv/Windows WindowsWechat",
    },
  });
  const parsed = parseWechatHtml(page.bodyText, page.finalUrl);
  parsed.httpStatus = page.status;
  parsed.byteLength = page.byteLength;
  return parsed;
}
