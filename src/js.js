// JavaScript / Electron 包静态分析（零依赖）：
// 打包器识别、依赖清单、URL/接口端点提取、源码映射、动态执行点、敏感形字符串。

export function analyzeJavaScript(source, { maxResults = 500 } = {}) {
  const out = {
    size: source.length,
    bundlers: [],
    requires: [],
    imports: [],
    urls: [],
    endpoints: [],
    sourceMaps: [],
    dynamicExec: [],
    suspicious: [],
    filePaths: [],
  };

  // 打包器指纹
  if (/__webpack_require__/.test(source)) out.bundlers.push("webpack");
  if (/__webpack_modules__/.test(source)) out.bundlers.push("webpack5");
  if (/self\.webpackChunk|webpackChunk_/.test(source)) out.bundlers.push("webpack-chunk");
  if (/__rspack_require__/.test(source)) out.bundlers.push("rspack");
  if (/__rolldown_runtime__|RolldownRuntime|rolldown-runtime/.test(source)) out.bundlers.push("rolldown");
  if (/__turbopack_require__|turbopack/.test(source)) out.bundlers.push("turbopack");
  if (/__esbuildRegisterLoader__|\/\* esbuild/.test(source)) out.bundlers.push("esbuild");
  if (/System\.register/.test(source)) out.bundlers.push("systemjs");
  if (/define\(\[.*?\],\s*function/.test(source) && /require\.config/.test(source)) out.bundlers.push("requirejs");
  if (/function\s+_interopRequireDefault/.test(source)) out.bundlers.push("babel");
  if (/parcelRequire/.test(source)) out.bundlers.push("parcel");
  if (/__vite__|import\.meta\.hot/.test(source)) out.bundlers.push("vite");

  // require 依赖
  const reqRe = /(?:__webpack_require__|require)\(\s*["']([^"']+)["']\s*\)/g;
  let m;
  const reqSet = new Set();
  while ((m = reqRe.exec(source)) !== null && reqSet.size < maxResults) reqSet.add(m[1]);
  out.requires = [...reqSet];

  // ESM import
  const impRe = /\bimport\s*(?:[\w*{},\s$]*\s+from\s*)?["']([^"']+)["']/g;
  const impSet = new Set();
  while ((m = impRe.exec(source)) !== null && impSet.size < maxResults) impSet.add(m[1]);
  out.imports = [...impSet];

  // 动态 import
  const dynRe = /import\(\s*["']([^"']+)["']\s*\)/g;
  while ((m = dynRe.exec(source)) !== null) {
    out.imports.push(`dynamic:${m[1]}`);
    if (out.imports.length > maxResults) break;
  }

  // URL
  const urlRe = /https?:\/\/[a-zA-Z0-9._~:/?#[\]@!$&'()*+,;=%-]+/g;
  const urlSet = new Set();
  while ((m = urlRe.exec(source)) !== null && urlSet.size < maxResults) urlSet.add(m[0]);
  out.urls = [...urlSet];

  // 接口端点（/api/... 路径形字符串）
  const epRe = /["'`](\/(?:api|v[0-9]+|graphql|ws|socket|rest|rpc)\/[a-zA-Z0-9_/?=&.:{}$-]{2,120})["'`]/g;
  const epSet = new Set();
  while ((m = epRe.exec(source)) !== null && epSet.size < maxResults) epSet.add(m[1]);
  out.endpoints = [...epSet];

  // sourceMappingURL
  const smRe = /sourceMappingURL=([^\s*]+)/g;
  while ((m = smRe.exec(source)) !== null && out.sourceMaps.length < 20) out.sourceMaps.push(m[1]);

  // 动态执行
  const dynExecRe = /\b(eval|new Function|Function\(|setTimeout\s*\(\s*["'][^"']+|setInterval\s*\(\s*["'][^"']+)/g;
  while ((m = dynExecRe.exec(source)) !== null && out.dynamicExec.length < 50) {
    out.dynamicExec.push(source.slice(Math.max(0, m.index - 40), m.index + 60).replace(/\s+/g, " "));
  }

  // 敏感形字符串（密钥/端点占位）
  const susRe = /(api[_-]?key|secret|token|password|passwd|authorization|Bearer )\s*[:=]\s*["'][^"']{6,}["']/gi;
  while ((m = susRe.exec(source)) !== null && out.suspicious.length < 50) {
    out.suspicious.push({ at: m.index, text: source.slice(Math.max(0, m.index - 30), m.index + 80) });
  }

  // 疑似文件路径
  const pathRe = /["'`]((?:\.{0,2}\/)?[a-zA-Z0-9_@./-]*\/(?:[a-zA-Z0-9_.-]+\.(?:js|ts|jsx|tsx|mjs|css|png|jpg|svg|json)))["'`]/g;
  const pathSet = new Set();
  while ((m = pathRe.exec(source)) !== null && pathSet.size < maxResults) pathSet.add(m[1]);
  out.filePaths = [...pathSet];

  return out;
}

// 打包 JS 的"路由/页面"启发：懒加载 chunk 名 + 注释里的页面名
export function extractChunks(source) {
  const chunks = new Set();
  const re = /(?:__webpack_require__\.e|ensure|import\()\(\s*["'`]([^"'`]+\.(?:js|mjs|cjs)[^"'`]*)["'`]/g;
  let m;
  while ((m = re.exec(source)) !== null) chunks.add(m[1]);
  return [...chunks].slice(0, 200);
}
