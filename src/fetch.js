// fetchPage：带浏览器头、重定向、gzip/brotli、大小/时间上限、HTTP(S) 代理的抓取。
// binary: true 时返回原始字节（bodyBuffer + latin1 bodyText），供图片/文件下载。
import http from "node:http";
import https from "node:https";
import net from "node:net";
import zlib from "node:zlib";
import { assertSafeUrl } from "./ssrf.js";

const DEFAULT_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
  "Accept-Encoding": "gzip, deflate, br",
  "Cache-Control": "no-cache",
  Pragma: "no-cache",
};

export async function fetchPage(rawUrl, opts = {}) {
  const {
    headers = {},
    timeoutMs = 20000,
    maxBytes = 8 * 1024 * 1024,
    maxRedirects = 8,
    allowPrivate = false,
    cookie = null,
    method = "GET",
    body = null,
    proxyUrl = null,
    binary = false,
  } = opts;

  const guard = await assertSafeUrl(rawUrl, { allowPrivate });
  if (!guard.ok) {
    const err = new Error(`blocked: ${guard.reason}`);
    err.code = "RE_BLOCKED";
    throw err;
  }
  return fetchInner(guard.url, {
    headers,
    timeoutMs,
    maxBytes,
    maxRedirects,
    allowPrivate,
    cookie,
    method,
    body,
    proxyUrl,
    binary,
    redirects: 0,
  });
}

function decodeBody(buffer, contentEncoding) {
  if (!contentEncoding) return buffer;
  const enc = contentEncoding.toLowerCase();
  try {
    if (enc.includes("gzip")) return zlib.gunzipSync(buffer);
    if (enc.includes("deflate")) return zlib.inflateSync(buffer);
    if (enc.includes("br")) return zlib.brotliDecompressSync(buffer);
  } catch {
    /* 解压失败按原样返回 */
  }
  return buffer;
}

function decodeText(buffer, contentType) {
  const c = (contentType || "").toLowerCase();
  const charsetMatch = c.match(/charset=([a-z0-9._-]+)/i);
  const charset = charsetMatch ? charsetMatch[1] : "utf-8";
  const candidates = [charset, "utf-8", "gbk", "gb18030", "big5"];
  for (const cs of candidates) {
    try {
      const decoder = new TextDecoder(cs, { fatal: true });
      return decoder.decode(buffer);
    } catch {
      /* try next */
    }
  }
  return buffer.toString("utf-8");
}

function connectViaProxy(proxyUrlObj, targetHost, targetPort, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(
      Number(proxyUrlObj.port || 80),
      proxyUrlObj.hostname,
      () => {
        socket.write(`CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\nHost: ${targetHost}:${targetPort}\r\n\r\n`);
      }
    );
    let headerBuf = Buffer.alloc(0);
    let connected = false;
    const timer = setTimeout(() => {
      if (!connected) {
        socket.destroy();
        reject(new Error("proxy CONNECT timeout"));
      }
    }, timeoutMs || 20000);
    socket.on("data", (d) => {
      headerBuf = Buffer.concat([headerBuf, d]);
      const idx = headerBuf.indexOf("\r\n\r\n");
      if (idx !== -1 && !connected) {
        const head = headerBuf.subarray(0, idx).toString();
        if (/^HTTP\/1\.[01] 200/i.test(head)) {
          connected = true;
          clearTimeout(timer);
          socket.removeAllListeners("data");
          const rest = headerBuf.subarray(idx + 4);
          resolve({ socket, rest });
        } else {
          clearTimeout(timer);
          socket.destroy();
          reject(new Error(`proxy CONNECT failed: ${head.split("\r\n")[0]}`));
        }
      }
    });
    socket.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

function fetchInner(urlObj, opts) {
  return new Promise((resolve, reject) => {
    const isHttps = urlObj.protocol === "https:";
    const mod = isHttps ? https : http;
    const sendHeaders = {
      ...DEFAULT_HEADERS,
      ...(opts.cookie ? { Cookie: opts.cookie } : {}),
      ...opts.headers,
      Host: urlObj.host,
      Connection: "close",
    };
    const doRequest = (agentOpts) => {
      const req = mod.request(
        {
          ...agentOpts,
          method: opts.method || "GET",
          headers: sendHeaders,
        },
        (res) => {
          const status = res.statusCode || 0;
          const location = res.headers.location;
          if (
            [301, 302, 303, 307, 308].includes(status) &&
            location &&
            opts.redirects < (opts.maxRedirects ?? 8)
          ) {
            res.resume();
            const next = new URL(location, urlObj);
            assertSafeUrl(next.href, { allowPrivate: opts.allowPrivate })
              .then((g) => {
                if (!g.ok) {
                  const err = new Error(`blocked redirect: ${g.reason}`);
                  err.code = "RE_BLOCKED";
                  throw err;
                }
                return fetchInner(g.url, { ...opts, redirects: opts.redirects + 1 });
              })
              .then(resolve, reject);
            return;
          }
          const chunks = [];
          let total = 0;
          let truncated = false;
          res.on("data", (chunk) => {
            if (truncated) return; // 已超上限：只排空，不存储
            if (total + chunk.length > opts.maxBytes) {
              const remain = opts.maxBytes - total;
              if (remain > 0) chunks.push(chunk.subarray(0, remain));
              truncated = true;
              total = opts.maxBytes;
              return;
            }
            chunks.push(chunk);
            total += chunk.length;
          });
          res.on("end", () => {
            const raw = Buffer.concat(chunks);
            const decoded = decodeBody(raw, res.headers["content-encoding"]);
            if (opts.binary) {
              resolve({
                status,
                headers: res.headers,
                finalUrl: urlObj.href,
                byteLength: decoded.length,
                truncated,
                bodyBuffer: decoded,
                bodyText: decoded.toString("binary"),
              });
              return;
            }
            const text = decodeText(decoded, res.headers["content-type"]);
            resolve({
              status,
              headers: res.headers,
              finalUrl: urlObj.href,
              byteLength: decoded.length,
              truncated,
              bodyText: text,
            });
          });
          res.on("error", reject);
        }
      );
      req.setTimeout(opts.timeoutMs || 20000, () => {
        req.destroy(new Error("fetch timeout"));
      });
      req.on("error", reject);
      if (opts.body) req.write(opts.body);
      req.end();
    };

    if (opts.proxyUrl) {
      let proxyObj;
      try {
        proxyObj = new URL(opts.proxyUrl);
      } catch {
        reject(new Error("invalid proxyUrl"));
        return;
      }
      if (isHttps) {
        const port = Number(urlObj.port || 443);
        connectViaProxy(proxyObj, urlObj.hostname, port, opts.timeoutMs).then(
          ({ socket, rest }) => {
            const agent = new https.Agent({ socket });
            const req = mod.request(
              {
                host: urlObj.hostname,
                port,
                path: urlObj.pathname + urlObj.search,
                method: opts.method || "GET",
                headers: sendHeaders,
                agent,
              },
              (res) => handleProxyResponse(res, socket, rest)
            );
            wireRequest(req);
          },
          reject
        );
        return;
      }
      // http 代理：直接发绝对 URL
      doRequest({
        host: proxyObj.hostname,
        port: Number(proxyObj.port || 80),
        path: urlObj.href,
      });
      return;
    }
    doRequest({ host: urlObj.hostname, port: Number(urlObj.port || (isHttps ? 443 : 80)), path: urlObj.pathname + urlObj.search });

    function wireRequest(req) {
      req.setTimeout(opts.timeoutMs || 20000, () => req.destroy(new Error("fetch timeout")));
      req.on("error", reject);
      if (opts.body) req.write(opts.body);
      req.end();
    }

    function handleProxyResponse(res, socket, rest) {
      const status = res.statusCode || 0;
      if ([301, 302, 303, 307, 308].includes(status) && res.headers.location && opts.redirects < (opts.maxRedirects ?? 8)) {
        res.resume();
        socket.destroy();
        const next = new URL(res.headers.location, urlObj);
        assertSafeUrl(next.href, { allowPrivate: opts.allowPrivate })
          .then((g) => {
            if (!g.ok) {
              const err = new Error(`blocked redirect: ${g.reason}`);
              err.code = "RE_BLOCKED";
              throw err;
            }
            return fetchInner(g.url, { ...opts, redirects: opts.redirects + 1 });
          })
          .then(resolve, reject);
        return;
      }
      const chunks = rest.length ? [rest] : [];
      let total = rest.length;
      let truncated = false;
      res.on("data", (chunk) => {
        if (total + chunk.length > opts.maxBytes) {
          const remain = opts.maxBytes - total;
          if (remain > 0) chunks.push(chunk.subarray(0, remain));
          truncated = true;
          total = opts.maxBytes;
          res.destroy();
          return;
        }
        chunks.push(chunk);
        total += chunk.length;
      });
      res.on("end", () => {
        const raw = Buffer.concat(chunks);
        const decoded = decodeBody(raw, res.headers["content-encoding"]);
        if (opts.binary) {
          resolve({ status, headers: res.headers, finalUrl: urlObj.href, byteLength: decoded.length, truncated, bodyBuffer: decoded, bodyText: decoded.toString("binary") });
          return;
        }
        resolve({ status, headers: res.headers, finalUrl: urlObj.href, byteLength: decoded.length, truncated, bodyText: decodeText(decoded, res.headers["content-type"]) });
      });
      res.on("error", reject);
    }
  });
}
