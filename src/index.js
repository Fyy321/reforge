// Reforge 公共导出：供其他程序/agent 直接 import 使用。
export { fetchPage } from "./fetch.js";
export { stealthFetch, CookieJar, randomUA, UA_POOL, jitter, sleep } from "./stealth.js";
export { renderPage, renderWithChrome, findBrowser } from "./render.js";
export { extractWechatArticle, parseWechatHtml } from "./wechat.js";
export { detectBinary, parsePE, parseELF, parseMachO, parseMachOFat, extractStrings } from "./binary.js";
export { analyzeJavaScript, extractChunks } from "./js.js";
export { solveCaptcha, sessionReuse, tokenReplay, ocrCaptcha, sliderTrajectory, fetchCaptchaImage } from "./captcha.js";
export { tryBypassPaywall, mirrorArticle, snapshotFetch, paywallCandidateUrls, extractStructuredFulltext } from "./paywall.js";
export { createSession, sessionHeaders, extractTokensFromHtml, cdpTokenExtractionScript } from "./login.js";
export { extractTitle, extractLinks, extractMainText, extractImages, parseMeta, stripTags } from "./html.js";
export { assertSafeUrl, isBlockedIp } from "./ssrf.js";
export { getQidianRank, parseQidianRank, fetchQidianRankPage, RANK_KINDS } from "./qidian.js";
export { getChapterList, getChapterContent, withCdp, findBrowserPath } from "./qidian-chapter.js";
export { chapterMirrorSearch, MIRROR_SITE_PATTERNS } from "./mirror-search.js";
export { RankLive, LiveBrowser } from "./rank-live.js";
export { buildFontDecoder, parseCmap, woffToTables, decodeDigitText } from "./font.js";
export { TOOLS, runTool, buildServer } from "./mcp-server.js";
