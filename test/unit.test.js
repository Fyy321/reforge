import { test } from "node:test";
import assert from "node:assert/strict";
import { isBlockedIp, assertSafeUrl } from "../src/ssrf.js";
import { extractTitle, extractLinks, extractMainText, parseMeta, stripTags } from "../src/html.js";
import { parseWechatHtml } from "../src/wechat.js";
import { detectBinary, parsePE, parseELF, extractStrings } from "../src/binary.js";
import { analyzeJavaScript } from "../src/js.js";
import { sessionReuse, tokenReplay, sliderTrajectory } from "../src/captcha.js";
import { paywallCandidateUrls, extractStructuredFulltext } from "../src/paywall.js";
import { createSession, sessionHeaders, extractTokensFromHtml } from "../src/login.js";

test("ssrf: blocks private/link-local/loopback", () => {
  assert.equal(isBlockedIp("127.0.0.1"), true);
  assert.equal(isBlockedIp("10.1.2.3"), true);
  assert.equal(isBlockedIp("172.16.5.5"), true);
  assert.equal(isBlockedIp("192.168.1.1"), true);
  assert.equal(isBlockedIp("169.254.169.254"), true);
  assert.equal(isBlockedIp("0.0.0.0"), true);
  assert.equal(isBlockedIp("::1"), true);
  assert.equal(isBlockedIp("1.1.1.1"), false);
  assert.equal(isBlockedIp("223.5.5.5"), false);
});

test("ssrf: assertSafeUrl rejects localhost by default, allows with flag", async () => {
  const r1 = await assertSafeUrl("http://127.0.0.1:8080/x");
  assert.equal(r1.ok, false);
  assert.equal(r1.reason, "private-address");
  const r2 = await assertSafeUrl("http://127.0.0.1:8080/x", { allowPrivate: true });
  assert.equal(r2.ok, true);
  const r3 = await assertSafeUrl("file:///etc/passwd");
  assert.equal(r3.ok, false);
});

test("html: title/meta/links/images/maintext", () => {
  const html = `<html><head><title>测试页</title><meta name="description" content="desc"><meta property="og:title" content="OG标题"></head>
  <body><article><p>这是一段足够长的正文内容，用于验证正文提取逻辑是否正常工作。${"x".repeat(200)}</p></article>
  <a href="/a">链接A</a><a href="https://example.com/b">链接B</a><img src="/img/1.png"><script>var x=1</script></body></html>`;
  assert.equal(extractTitle(html), "测试页");
  const meta = parseMeta(html);
  assert.equal(meta["og:title"], "OG标题");
  assert.equal(meta.description, "desc");
  const links = extractLinks(html, "https://example.com/");
  assert.equal(links[0].href, "https://example.com/a");
  const text = extractMainText(html);
  assert.ok(text.includes("验证正文提取逻辑"));
  assert.ok(!text.includes("var x=1"), "script 内容应被剥离");
});

test("wechat: parseWechatHtml extracts article fields", () => {
  const html = `<!DOCTYPE html><html><head>
  <meta property="og:title" content="公众号文章标题">
  <meta name="author" content="作者名">
  <meta name="description" content="文章摘要">
  <script>var msg_title='标题变量';var ct="1718000000";var user_name='gh_abc123';</script>
  </head><body>
  <div id="js_content"><p>这是公众号正文第一段。</p><p>${"第二段内容。".repeat(50)}</p><img data-src="https://mmbiz.qpic.cn/aaa"></div>
  </body></html>`;
  const r = parseWechatHtml(html, "https://mp.weixin.qq.com/s/abc");
  assert.equal(r.ok, true);
  assert.equal(r.title, "公众号文章标题");
  assert.equal(r.author, "作者名");
  assert.equal(r.digest, "文章摘要");
  assert.ok(r.contentText.includes("公众号正文第一段"));
  assert.ok(r.publishTime.startsWith("2024-06-10"));
  assert.ok(r.images[0].includes("mmbiz.qpic.cn"));
});

test("binary: PE 解析（合成最小 PE）", () => {
  const buf = buildMinimalPE();
  assert.equal(detectBinary(buf).type, "pe");
  const pe = parsePE(buf);
  assert.equal(pe.machine, "x64 (AMD64)");
  assert.equal(pe.numSections, 1);
  assert.equal(pe.sections[0].name, ".text");
  assert.equal(pe.isDll, false);
});

test("binary: ELF 解析（合成最小 ELF64）", () => {
  const buf = buildMinimalELF64();
  assert.equal(detectBinary(buf).type, "elf");
  const elf = parseELF(buf);
  assert.equal(elf.class, "ELF64");
  assert.equal(elf.machine, "x86-64 (AMD64)");
  assert.equal(elf.entry, "0x401000");
});

test("binary: extractStrings 提取 ASCII 与 UTF-8", () => {
  const buf = Buffer.concat([Buffer.from("hello_world\0"), Buffer.from("中文内容"), Buffer.from([0, 0, 0]), Buffer.from("ABC")]);
  const s = extractStrings(buf, { minLen: 3 });
  assert.ok(s.includes("hello_world"));
  assert.ok(s.includes("中文内容"));
  assert.ok(s.includes("ABC"));
});

test("js: 打包器与端点提取", () => {
  const source = `
  var __webpack_modules__ = {}; var __webpack_require__ = function(){};
  const x = require("lodash");
  import React from "react";
  const u = "https://cdn.example.com/app.js";
  fetch("/api/v1/user/list").then(r=>r.json());
  var cfg = { token: "sk-test-1234567890abcdef" };
  //# sourceMappingURL=app.js.map
  eval("console.log(1)");
  import("./lazy-123.js");
  `;
  const a = analyzeJavaScript(source);
  assert.ok(a.bundlers.includes("webpack5"));
  assert.ok(a.requires.includes("lodash"));
  assert.ok(a.imports.includes("react"));
  assert.ok(a.urls.includes("https://cdn.example.com/app.js"));
  assert.ok(a.endpoints.includes("/api/v1/user/list"));
  assert.ok(a.sourceMaps.includes("app.js.map"));
  assert.equal(a.dynamicExec.length >= 1, true);
  assert.equal(a.suspicious.length >= 1, true);
});

test("captcha: sessionReuse / tokenReplay / sliderTrajectory", () => {
  const s = sessionReuse({ cookie: "a=b", token: "tok123", headers: { "X-Custom": "1" } });
  assert.equal(s.strategy, "session-reuse");
  assert.equal(s.cookie, "a=b");
  assert.equal(s.headers.Authorization, "Bearer tok123");
  const t = tokenReplay("T-98765", { headerName: "X-Captcha-Token" });
  const applied = t.apply("https://x.test/p", {});
  assert.equal(applied.headers["X-Captcha-Token"], "T-98765");
  const traj = sliderTrajectory({ startX: 40, endX: 260 });
  assert.equal(traj.steps.length, 25);
  assert.equal(traj.steps[0].x, 40);
  assert.equal(traj.steps[24].x, 260);
});

test("paywall: candidates + structured fulltext", () => {
  const cs = paywallCandidateUrls("https://news.example.com/art/123?utm_source=tw");
  assert.ok(cs.some((c) => c.includes("/amp")));
  assert.ok(cs.some((c) => c.includes("print=1")));
  assert.ok(!cs[cs.length - 1].includes("utm_source"));
  const html = `<script type="application/ld+json">{"@context":"https://schema.org","articleBody":"这是完整正文内容。${"更多内容。".repeat(100)}"}</script>`;
  const st = extractStructuredFulltext(html);
  assert.ok(st.articleBody.includes("完整正文内容"));
});

test("login: session 与 token 提取", () => {
  const s = createSession({ cookie: "sid=abc; uid=1", domain: "x.test", tokens: { accessToken: "AT-1" }, headers: { Referer: "https://x.test/" } });
  const h = sessionHeaders(s, "https://x.test/page");
  assert.equal(h.Cookie, "sid=abc; uid=1");
  assert.equal(h.Authorization, "Bearer AT-1");
  const tokens = extractTokensFromHtml(`<meta name="csrf-token" content="CSRF12345678"> var c = {"token":"TK9876543210abcdef"};`);
  assert.equal(tokens.csrf, "CSRF12345678");
  assert.equal(tokens.token, "TK9876543210abcdef");
});

// ---- 合成二进制构造 ----

function buildMinimalPE() {
  const numSections = 1;
  const optSize = 0xf0; // PE32+ 可选头大小（对齐即可）
  const sectionRaw = 0x200;
  const sizeOfImage = 0x1000;
  const sizeOfHeaders = 0x200;
  const buf = Buffer.alloc(0x400, 0);
  buf.writeUInt8(0x4d, 0); buf.writeUInt8(0x5a, 1); // MZ
  buf.writeUInt32LE(0x80, 0x3c); // e_lfanew
  const pe = 0x80;
  buf.write("PE\u0000\u0000", pe, "latin1");
  buf.writeUInt16LE(0x8664, pe + 4); // machine x64
  buf.writeUInt16LE(numSections, pe + 6);
  buf.writeUInt32LE(0x5f000000, pe + 8); // timestamp
  buf.writeUInt16LE(optSize, pe + 20); // SizeOfOptionalHeader (COFF+16)
  buf.writeUInt16LE(0x0022, pe + 22); // characteristics (COFF+18)
  const opt = pe + 24; // 可选头 = COFF(pe+4) + 20
  buf.writeUInt16LE(0x20b, opt); // Magic: PE32+
  buf.writeUInt32LE(0x1000, opt + 16); // entry RVA
  buf.writeBigUInt64LE(0x140000000n, opt + 24); // image base
  buf.writeUInt16LE(3, opt + 68); // subsystem console
  buf.writeUInt16LE(0x8140, opt + 70); // dll characteristics
  const sec = opt + optSize;
  buf.write(".text\0\0\0", sec, "latin1");
  buf.writeUInt32LE(0x200, sec + 8); // virtual size
  buf.writeUInt32LE(0x1000, sec + 12); // RVA
  buf.writeUInt32LE(sectionRaw, sec + 16); // raw size
  buf.writeUInt32LE(0x200, sec + 20); // raw ptr
  buf.writeUInt32LE(0x60000020, sec + 36); // code|executable|readable
  // data directory 大小补零即可
  return buf;
}

function buildMinimalELF64() {
  const buf = Buffer.alloc(0x200, 0);
  buf.write("\u007fELF", 0, "latin1");
  buf[4] = 2; // 64-bit
  buf[5] = 1; // little endian
  buf[6] = 1; // version
  buf.writeUInt16LE(2, 16); // ET_EXEC
  buf.writeUInt16LE(62, 18); // x86-64
  buf.writeUInt32LE(1, 20); // version
  buf.writeBigUInt64LE(0x401000n, 24); // entry
  buf.writeBigUInt64LE(64n, 32); // phoff
  buf.writeBigUInt64LE(0n, 40); // shoff
  buf.writeUInt16LE(64, 52); // ehsize
  buf.writeUInt16LE(56, 54); // phentsize
  buf.writeUInt16LE(1, 56); // phnum
  buf.writeUInt16LE(64, 58); // shentsize
  buf.writeUInt16LE(0, 60); // shnum
  buf.writeUInt16LE(0, 62); // shstrndx
  // 一个 PT_LOAD 段
  const ph = 64;
  buf.writeUInt32LE(1, ph); // PT_LOAD
  buf.writeUInt32LE(5, ph + 4); // flags R+X
  buf.writeBigUInt64LE(0n, ph + 8); // offset
  buf.writeBigUInt64LE(0x400000n, ph + 16); // vaddr
  buf.writeBigUInt64LE(0x400000n, ph + 24); // paddr
  buf.writeBigUInt64LE(0x200n, ph + 32); // filesz
  buf.writeBigUInt64LE(0x200n, ph + 40); // memsz
  buf.writeBigUInt64LE(0x1000n, ph + 48); // align
  return buf;
}
