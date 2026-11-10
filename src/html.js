// 极简 HTML 解析/清洗工具（零依赖）。
// 解析出 title/meta/正文候选/链接/图片/脚本，够抓取与分析用。

export function stripTags(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function parseMeta(html) {
  const meta = {};
  const re = /<meta\b[^>]*>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const tag = m[0];
    const name = attr(tag, "name") || attr(tag, "property") || attr(tag, "itemprop");
    const content = attr(tag, "content");
    if (name && content) meta[name.toLowerCase()] = decodeEntities(content);
  }
  return meta;
}

function attr(tag, name) {
  const re = new RegExp(`${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i");
  const m = tag.match(re);
  return m ? m[2] ?? m[3] ?? m[4] ?? "" : null;
}

export function decodeEntities(s) {
  return String(s)
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

export function extractTitle(html) {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? decodeEntities(m[1]).trim() : "";
}

export function extractLinks(html, baseUrl) {
  const out = [];
  const re = /<a\b[^>]*href\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const href = m[2] ?? m[3] ?? m[4] ?? "";
    const text = stripTags(m[0]).slice(0, 200).trim();
    if (!href) continue;
    try {
      const abs = new URL(href, baseUrl).href;
      out.push({ href: abs, text });
    } catch {
      out.push({ href, text });
    }
  }
  // 去重，上限 2000
  const seen = new Set();
  return out.filter((l) => (seen.has(l.href) ? false : (seen.add(l.href), true))).slice(0, 2000);
}

export function extractImages(html, baseUrl) {
  const out = [];
  const re = /<img\b[^>]*>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const tag = m[0];
    const src = attr(tag, "src") || attr(tag, "data-src") || attr(tag, "data-original");
    if (!src) continue;
    try {
      out.push(new URL(src, baseUrl).href);
    } catch {
      out.push(src);
    }
  }
  return [...new Set(out)].slice(0, 500);
}

// 提取正文候选：优先 <article>/<main>，其次最大文本密度块
export function extractMainText(html) {
  const candidates = [];
  const articleMatch = html.match(/<article\b[\s\S]*?<\/article>/gi);
  if (articleMatch) candidates.push(articleMatch.map(stripTags).join("\n\n"));
  const mainMatch = html.match(/<main\b[\s\S]*?<\/main>/gi);
  if (mainMatch) candidates.push(mainMatch.map(stripTags).join("\n\n"));
  const bodyMatch = html.match(/<body\b[\s\S]*?<\/body>/i);
  const bodyHtml = bodyMatch ? bodyMatch[0] : html;
  const blockRe = /<(div|section|p|h[1-6])\b[^>]*>([\s\S]*?)<\/\1>/gi;
  const blocks = [];
  let bm;
  while ((bm = blockRe.exec(bodyHtml)) !== null) {
    const text = stripTags(bm[2]);
    if (text.length > 80) blocks.push({ tag: bm[1], text, len: text.length });
  }
  if (blocks.length > 0) {
    const sorted = [...blocks].sort((a, b) => b.len - a.len).slice(0, 5);
    candidates.push(sorted.map((b) => b.text).join("\n\n"));
  }
  if (candidates.length === 0) {
    const whole = stripTags(bodyHtml);
    if (whole.length > 0) candidates.push(whole);
  }
  // 选最长候选
  candidates.sort((a, b) => b.length - a.length);
  return candidates[0] || "";
}

export function extractScripts(html, baseUrl) {
  const out = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const attrs = m[1] || "";
    const src = attr(attrs, "src");
    const inline = m[2] || "";
    if (src) {
      try {
        out.push({ src: new URL(src, baseUrl).href, inline: "" });
      } catch {
        out.push({ src, inline: "" });
      }
    } else if (inline.trim().length > 0) {
      out.push({ src: null, inline: inline.slice(0, 200000) });
    }
  }
  return out.slice(0, 500);
}
