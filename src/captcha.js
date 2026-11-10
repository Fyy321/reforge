// 验证码处理框架（本地夹具/占位目标）。
// 策略：会话复用、令牌重放、OCR 服务插件、滑块脚本（CDP）、人工接管。
// 所有外部服务端点/密钥均为占位符，由部署方填写。

import { fetchPage } from "./fetch.js";

/**
 * 策略一：会话复用 —— 用已验证过的 Cookie/会话直接绕过验证码检查。
 * 很多站点对已登录会话不再弹验证码。
 */
export function sessionReuse(session) {
  const { cookie, token, headers } = session || {};
  const out = { strategy: "session-reuse", headers: {} };
  if (cookie) out.cookie = cookie;
  if (token) out.headers.Authorization = `Bearer ${token}`;
  for (const [k, v] of Object.entries(headers || {})) out.headers[k] = v;
  return out;
}

/**
 * 策略二：令牌重放 —— 站点只校验"过了一次验证码"的标记（如 geetest/slider token），
 * 复用同一 token 多次通过校验。从浏览器存储里提取 token 后放入池子。
 */
export function tokenReplay(token, { headerName = "X-Captcha-Token", paramName = null } = {}) {
  return {
    strategy: "token-replay",
    headerName,
    paramName,
    token,
    apply(url, headers) {
      if (paramName) {
        const u = new URL(url);
        u.searchParams.set(paramName, token);
        return { url: u.href, headers };
      }
      headers[headerName] = token;
      return { url, headers };
    },
  };
}

/**
 * 策略三：OCR 服务插件（外部服务，需 API key）。
 * SOLVER_URL / SOLVER_API_KEY 为占位符；标准实现对接
 * 2captcha / CapSolver / 本地 PaddleOCR 服务均可按同一接口接入。
 */
export async function ocrCaptcha(imageBase64, { solverUrl = "SOLVER_URL", apiKey = "SOLVER_API_KEY", type = "image" } = {}) {
  const body = JSON.stringify({
    clientKey: apiKey,
    task: { type, body: imageBase64 },
  });
  const resp = await fetch(solverUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
  if (!resp.ok) throw new Error(`ocr solver http ${resp.status}`);
  const data = await resp.json();
  return { strategy: "ocr-service", text: data.solution?.text || data.text || "" };
}

/**
 * 策略四：滑块验证码自动化脚本（需要 CDP/浏览器）。
 * 生成三段式拖动轨迹（先快后慢+回抖），交给执行端用 Input.dispatchMouseEvent 播放。
 */
export function sliderTrajectory({ startX = 40, endX = 260, startY = 300, durationMs = 1800 } = {}) {
  const steps = [];
  const n = 24;
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    // ease-out + 微抖动
    const eased = 1 - Math.pow(1 - t, 2.2);
    // 抖动在两端收敛为 0，保证起点/终点精确
    const wobble = i > n * 0.8 ? Math.sin(t * 40) * 2 * (t * (1 - t) * 4) : 0;
    const x = Math.round(startX + (endX - startX) * eased + wobble);
    const y = Math.round(startY + Math.sin(t * Math.PI) * 3);
    steps.push({ x, y, t: Math.round((durationMs / n) * i) });
  }
  return {
    strategy: "slider-cdp",
    script: "Input.dispatchMouseEvent",
    steps,
    mouseDownAt: steps[0],
    mouseUpAt: steps[steps.length - 1],
  };
}

/**
 * 策略五：人工接管 —— 下载验证码图片，返回给调用方（agent/人），由人输入答案。
 */
export async function fetchCaptchaImage(imageUrl, { allowPrivate = false, session = {} } = {}) {
  const page = await fetchPage(imageUrl, {
    allowPrivate,
    headers: session.headers || {},
    cookie: session.cookie || undefined,
    maxBytes: 512 * 1024,
  });
  const base64 = Buffer.from(page.bodyText, "binary").toString("base64");
  return { strategy: "manual", imageBase64: base64, contentType: page.headers["content-type"] || "image/png" };
}

/**
 * 完整流程 solveCaptcha：
 *  - mode=session-reuse: 用会话直接过
 *  - mode=token-replay: 回放已知 token
 *  - mode=ocr: 调 OCR 服务识别图片验证码
 *  - mode=slider: 生成滑块轨迹脚本
 *  - mode=manual: 拉取验证码图片给人/agent 判读
 */
export async function solveCaptcha(params = {}) {
  const { mode = "session-reuse" } = params;
  switch (mode) {
    case "session-reuse":
      return sessionReuse(params.session);
    case "token-replay":
      return tokenReplay(params.token, { headerName: params.headerName, paramName: params.paramName });
    case "ocr":
      return ocrCaptcha(params.imageBase64 || await fetchCaptchaImage(params.imageUrl, params).then((r) => r.imageBase64), {
        solverUrl: params.solverUrl,
        apiKey: params.apiKey,
        type: params.ocrType || "image",
      });
    case "slider":
      return sliderTrajectory(params.trajectory || {});
    case "manual":
      return fetchCaptchaImage(params.imageUrl, params);
    default:
      throw new Error(`unknown captcha mode: ${mode}`);
  }
}
