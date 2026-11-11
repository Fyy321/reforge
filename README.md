# Reforge — 给任何 AI 用的通用逆向工具

一个零运行时依赖的 Node 工具（MCP 服务器 + CLI），让 Claude Code / Codex / Cursor / DSH / 任何支持 MCP 的 agent 都能：

- **抓取网页**：浏览器头、编码识别、UA 轮换、Cookie 会话、代理、退避重试
- **渲染网页**：本机 Chrome/Edge `--headless` 拿 JS 执行后的 DOM（无浏览器自动回退抓取）
- **提取公众号文章**：mp.weixin.qq.com 直链 → 标题/作者/公众号/发布时间/摘要/正文/图片/链接
- **全文镜像**：页面 + 图片内联成单文件 HTML，离线可看
- **绕过验证码 / 登录墙 / 付费墙 / 反爬**：多策略组合（见下文）
- **分析软件**：PE / ELF / Mach-O 头部与节表、可打印字符串、JS/Electron 打包器与接口端点

```
reforge/
├─ package.json         零依赖；node >= 18
├─ src/
│  ├─ mcp-server.js     MCP stdio 服务器（协议手写实现）
│  ├─ cli.js            命令行入口
│  ├─ index.js          公共导出（可被其它程序 import）
│  ├─ fetch.js          HTTP(S) 抓取：重定向/压缩/编码/代理/SSRF 防护
│  ├─ stealth.js        反爬：UA 池、CookieJar、抖动、退避重试
│  ├─ render.js         无头浏览器渲染（Chrome/Edge --headless，零依赖）
│  ├─ wechat.js         公众号文章解析与抓取
│  ├─ paywall.js        付费墙绕过组合 + 全文镜像
│  ├─ captcha.js        验证码处理框架（5 种模式）
│  ├─ login.js          会话/令牌/Cookie 管理
│  ├─ binary.js         PE/ELF/Mach-O 解析、字符串提取
│  ├─ js.js             JS/Electron 包静态分析
│  ├─ html.js           HTML 解析/正文提取
│  └─ ssrf.js           内网地址防护
├─ test/unit.test.js    11 项单元测试（合成 PE/ELF 等）
└─ mirrors/             全文镜像默认输出目录
```

## 快速开始

```bash
# CLI
node src/cli.js fetch https://example.com
node src/cli.js wechat "https://mp.weixin.qq.com/s/xxxxxxxx"
node src/cli.js mirror https://example.com --out-dir mirrors
node src/cli.js bin /path/to/app.exe
node src/cli.js js /path/to/app.js
node src/cli.js serve        # MCP stdio 服务器

# 测试
node --test test/unit.test.js
```

## 接入其它 AI（MCP 配置）

**Claude Code**（`claude mcp add`）：

```bash
claude mcp add reforge -- node C:\path\to\reforge\src\cli.js serve
```

**Codex / Cursor / 通用 stdio MCP**（`.mcp.json` 或客户端配置）：

```json
{
  "mcpServers": {
    "reforge": {
      "command": "node",
      "args": ["C:\\path\\to\\reforge\\src\\cli.js", "serve"]
    }
  }
}
```

服务端声明 15 个工具：`fetch_page` `render_page` `extract_wechat_article` `parse_wechat_html`
`mirror_article` `bypass_paywall` `paywall_candidates` `snapshot_fetch` `solve_captcha`
`new_session` `extract_tokens` `cdp_token_plan` `inspect_binary` `analyze_javascript` `page_summary`。

## 反爬 / 验证码 / 登录 / 付费墙用法

### 1. 反爬
```bash
reforge fetch URL --stealth              # UA 轮换 + 随机抖动 + 403/429 退避重试
reforge fetch URL --stealth --proxy http://127.0.0.1:7890   # 走代理池入口
reforge render URL --wait-ms 8000        # 无头浏览器执行 JS 后取 DOM（破 JS 挑战）
```
MCP `fetch_page` 参数：`stealth: true`、`proxy_url`、`headers`、`cookie`。

### 2. 验证码（solve_captcha 五种模式）
| 模式 | 用途 | 参数 |
|---|---|---|
| `session-reuse` | 已登录会话通常不再弹验证码，直接带 Cookie/令牌过 | `session` |
| `token-replay` | 站点只校验"过了一次验证"的标记，回放同一 token | `token`, `header_name`, `param_name` |
| `ocr` | 图片验证码交 OCR 服务识别 | `image_url`/`image_base64`, `solver_url`, `api_key` |
| `slider` | 生成三段式人形轨迹（CDP `Input.dispatchMouseEvent` 播放） | `trajectory` |
| `manual` | 拉取验证码图给 agent/人判读 | `image_url` |

```bash
reforge captcha token-replay --token "T-xxx"          # 令牌回放
reforge captcha slider                                  # 生成滑块轨迹 JSON
reforge captcha ocr --image-url https://site/captcha.png --solver-url SOLVER_URL --api-key SOLVER_API_KEY
```
`solver_url`/`api_key` 是占位符：接 2captcha/CapSolver/本地 PaddleOCR 服务任一实现（返回 `{solution:{text}}` 即可）。

### 3. 登录墙
```bash
# 1) 从浏览器复制 Cookie，创建会话（MCP: new_session）
reforge new-session --cookie "sid=xxx; uid=1"
# 2) 抓取时带 Cookie（fetch/summary/mirror/paywall/wechat 都支持 --cookie）
reforge fetch URL --cookie "sid=xxx"
# 3) 从页面提取令牌（csrf/token/accessToken）
reforge session-parse page.html
```
`cdp_token_plan` 工具给出从受控浏览器（`--remote-debugging-port=9222`）读 localStorage/cookie 的步骤脚本。

### 4. 付费墙 + 全文镜像（bypass_paywall 组合拳）
自动依次尝试，拿到正文 ≥ `min_text_length` 即返回：

1. **直接抓取**（带会话 Cookie）
2. **结构化全文**：JSON-LD `articleBody` / og / meta（很多付费页正文已下发前端）
3. **变体端点**：AMP / `?print=1` / reader 版 / 去追踪参数 URL
4. **快照**：web.archive.org / archive.ph
5. **全文镜像**：正文 + 图片内联成单文件 HTML，并剥掉遮罩/弹层脚本

```bash
reforge paywall URL --min-text 500 --cookie "..." --mirror-dir mirrors
reforge mirror URL --out-dir mirrors           # 只要镜像
reforge snapshot URL --service archive          # 只要快照
```

### 5. 公众号全文镜像
```bash
reforge wechat "https://mp.weixin.qq.com/s/xxx" --cookie "..."     # 结构化提取
reforge mirror "https://mp.weixin.qq.com/s/xxx"                    # 全文+图片单文件
reforge wechat-html saved.html                                    # 本地 HTML 直接解析
```

## 安全边界

- **SSRF 防护**：默认拒绝 127.0.0.0/8、10/8、172.16/12、192.168/16、169.254/16（云元数据）、链路本地等；域名解析后逐条校验。仅当显式传 `--allow-private`（MCP: `allow_private: true`）时放行内网/本机目标——本地夹具与自建测试站点用这个开关。
- 抓取有大小/时间/重定向上限；二进制下载按 `maxBytes` 封顶。
- 本工具只做"抓取与解析"；目标站点的法律与授权边界由使用方确认（默认视作本地夹具/占位目标）。

## 植入式榜单实时更新插件（RankLive）

把实时榜单"植入"任何现有软件，三行接入，后台轮询自动刷新：

```js
import { RankLive } from "./src/rank-live.js";

const live = new RankLive({
  kinds: ["yuepiao", "hotsales", "recom"],   // 默认八榜全开
  intervalMs: 60000,                          // 刷新间隔（"实时"可设 15000）
  storeDir: "./live-data",                    // 原子写盘 ranks.json / ranks.csv
  onUpdate: (snap) => { /* 每轮全量数据回调 */ },
  onDiff: (diff) => { /* 排名变化：新上榜/上升/下降/掉榜 */ },
});
live.start();
live.snapshot();   // 宿主随时 pull 内存快照
```

三种植入方式（对应不同宿主语言）：

1. **Node 宿主**：`import { RankLive }`（上面三行）。
2. **任意语言宿主**：把 `src/cli.js live` 作为子进程插件运行，读 `--store-dir` 下的 `ranks.json`：
   ```bash
   node src/cli.js live yuepiao hotsales recom --interval 30000 --store-dir ./live-data
   # 宿主每 30 秒得到全新 ranks.json（原子替换，无半写状态）
   ```
3. **AI/Agent 宿主**：MCP 工具 `qidian_rank` 按需拉取 + `qidian_chapters` 等。

核心：**常驻无头浏览器会话**（probe 挑战 Cookie 跨轮复用，单榜刷新 ~4 秒），失败自动退避（连续失败 ×2 间隔，上限 10 分钟），数据只经签名/解析管线落地。

演示宿主：`node demo/live-app.js`（每 20 秒刷新三榜并打印变化）。

## 起点榜单实战（反爬三层绕过）

```bash
node src/cli.js qidian-rank yuepiao     # 月票榜（含真实票数）
node src/cli.js qidian-rank hotsales    # 畅销榜
node src/cli.js qidian-rank recom       # 推荐榜
```

起点 `www.qidian.com/rank/` 的三层反爬与应对：

1. **202 probe 挑战页**（空壳 + `/probe.js`）→ 无头 Edge/Chrome（CDP）执行挑战脚本，同会话内自动重载取真实 DOM（`src/render.js` 的 `renderWithCdp`）。
2. **自定义字体混淆数字**（`@font-face` + PUA 码位假字符）→ 下载 woff，解析 sfnt `cmap` + `glyf`/`loca` 字形 bbox，按 glyphID 排序还原真实数字（`src/font.js` 的 `buildFontDecoder`）。
3. **畅销值签名接口**（`initializeAjaxSign` + `w_tsfp`）→ 榜单书名/作者/分类/章节能取全，数值字段需继续逆向签名算法（见下方"已知限制"）。

已知限制：畅销榜 `total` 字段由带签名参数的 XHR 填充，当前解析返回空并保留 `books` 全部元数据；月票榜数值完整解码。其余榜单（推荐/收藏/阅读指数等）走同一渲染+解析管线，实测字段以页面服务端渲染为准。

## 起点章节正文（免费章全文 / 付费章需会话）

```bash
node src/cli.js qidian-chapters 1050460263                # 章节目录（免费/VIP 标记）
node src/cli.js qidian-chapter 1050460263 925357978       # 免费章节 → 完整全文
node src/cli.js qidian-chapter 1050460263 931126203 --cookie "你的登录Cookie"  # 付费章 → 需已订阅会话
node src/cli.js chapter-mirror 神宠供应商 第69章          # 聚合镜像站检索兜底
```

链路：CDP 无头浏览器过 probe 挑战 → 章节页 SSR 内嵌 `chapterInfo` JSON 提取 → HTML 反转义还原正文。

付费机制实测结论：**正文是否下发由服务端按会话权益判定**——匿名请求只返回约 148 字预告（`contentLength=148`），任何客户端手段都无法凭空变出正文；给到已订阅账号的 Cookie 后，同一条管线直接返回全文。MCP 工具：`qidian_chapters` / `qidian_chapter_content` / `chapter_mirror_search`。

## 24 小时一次 + 苹果软件集成

不需要实时时，推荐**每日一跑、App 只读文件**的架构（三选一）：

| 方案 | 更新在哪跑 | Mac/iOS 端依赖 | 适用 |
|---|---|---|---|
| **C. 服务器/CI 每日生成**（最推荐） | GitHub Actions 每日 cron / 任意服务器 | 无（只发 HTTPS 请求） | App Store 应用、iOS |
| **A. Mac 本地 launchd 每日任务** | 用户 Mac 上 launchd 定点跑 | Node + Edge/Chrome | macOS 桌面应用 |
| B. App 内嵌定时器 | App 运行期间 | 无 | 不推荐（App 关了就断更） |

**服务端每日任务**（一次跑主站 11 榜与女频 2 榜，产物三格式）：

```bash
node scripts/daily-update.js --out-dir ./daily-ranks
# → ranks.json（字典格式）/ ranks-apple.json（Swift 友好扁平格式）/ ranks.csv
```

GitHub Actions 版：[.github/workflows/daily-ranks.yml](.github/workflows/daily-ranks.yml)（每日 UTC 20:30 = 北京 04:30，产物上传为构建工件，配个静态托管即可）。

**Mac 本地 launchd**：

```bash
bash apple/install-daily-update.sh   # 每天 04:30 自动跑，写 ~/Library/Application Support/Ranks/
```

**苹果端 Swift 客户端**：[apple/RankFetcher.swift](apple/RankFetcher.swift)（macOS 13+/iOS 15+，零第三方依赖，直接拖进工程）：

```swift
let fetcher = RankFetcher(feedURL: URL(string: "https://example.com/ranks-apple.json")!)
let feed = try await fetcher.fetchRanks()
let yuepiao = feed.rank("yuepiao")   // → [RankBook]，SwiftUI List 直接渲染
```

可选 Ed25519 验签：`node scripts/sign-feed.js --file ranks-apple.json --key update-keys.json` 生成 `.sig`，App 端用 `fetchSignedRanks` 校验（CryptoKit，防数据被中间人篡改）。

## 24 小时一次 + 苹果软件集成（方案 C 部署清单）

**第 1 步：把项目推到 GitHub**（新建仓库 → 推送本目录）。

**第 2 步：GitHub 仓库 → Settings → Pages**，Source 选 `Deploy from a branch`，分支选 `gh-pages`。

**第 3 步：等第一次 Actions 跑完**（或手动触发 `daily-ranks` workflow）。之后每天北京 04:30 自动更新。

**第 4 步：拿到数据源 URL**：

```
https://<你的用户名>.github.io/<仓库名>/ranks-apple.json
https://<你的用户名>.github.io/<仓库名>/ranks.csv
```

**第 5 步：苹果端**（[apple/RankFetcher.swift](apple/RankFetcher.swift) 拖进 Xcode 工程）：

```swift
let fetcher = RankFetcher(feedURL: URL(string: "https://<用户名>.github.io/<仓库名>/ranks-apple.json")!)
let feed = try await fetcher.fetchRanks()
let yuepiao = feed.rank("yuepiao")     // [RankBook] 直接渲染
```

**可选安全加固**：仓库 Settings → Secrets → 新建 `RANK_SIGNING_KEY`（内容为 `update-keys.json` 全文）→ 工作流自动生成 `ranks-apple.json.sig` → App 端用 `fetchSignedRanks()` + 公钥验签（公钥会打印在 workflow 日志里）。

**本机预览（不等 GitHub）**：

```bash
node scripts/daily-update.js --out-dir ./daily-ranks
npx http-server ./daily-ranks -p 8080     # 或任意静态托管
```

## 占位符清单（部署时填写）

| 占位符 | 含义 |
|---|---|
| `SOLVER_URL` / `SOLVER_API_KEY` | 验证码 OCR 服务地址与密钥 |
| `http://127.0.0.1:7890` | 代理池入口示例 |
| `--cookie "sid=xxx"` | 登录会话 Cookie（从自己浏览器复制） |
| `--allow-private` | 本地/内网测试目标开关 |
| `--remote-debugging-port=9222` | 受控浏览器 CDP 端口 |
