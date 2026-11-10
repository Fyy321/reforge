# 给另一个 AI 的实装任务提示词（直接复制本文件内容发给它）

---

## 任务

把榜单数据功能接入我的苹果 App 源码工程。

## 你要做的

1. 从 GitHub 仓库 `Fyy321/reforge` 读取两个文件：
   - `apple/RankFetcher.swift` —— 客户端数据模块（唯一需要复制的代码文件）
   - `APP-INTEGRATION.md` —— 接入说明（数据格式、缓存代码、界面示例）
2. 把 `RankFetcher.swift` 复制进我的 Xcode 工程，按 `APP-INTEGRATION.md` 接入。

## 数据源（已上线，真实可用）

```
https://fyy321.github.io/reforge/ranks-apple.json
```

数据每天由服务器自动更新一次，包含 11 个起点榜单（月票榜、畅销榜、推荐榜、收藏榜、阅读指数榜、留存榜、潜力榜、书友榜、更新榜、VIP收藏榜、未签约新书榜），每个榜单 20 本书，字段：rank（排名）、title（书名）、author（作者）、category（分类）、total（数值如"36071月票"）、intro（简介全文）、cover（官方 CDN 封面直链 webp）、status、latestChapter、updateTime。

## 硬性要求

- 零第三方依赖：只用 Foundation / SwiftUI / CryptoKit / URLSession
- 拉取时机：App 启动和回到前台时各拉一次，成功后写本地缓存；网络失败时读缓存兜底
- 封面用 `AsyncImage` 直接加载 CDN 直链，不要下载到本地
- `RankBook` 字段均为可选类型，UI 容错空值
- 支持 macOS 13+ 与 iOS 15+ 两个目标
- 完成后告诉我：改动了哪几个文件、每个界面的入口在哪、有没有编译警告

## 禁止

- 不要引入任何第三方包（不需要 Alamofire、Kingfisher 等）
- 不要改动数据源网址或数据结构
- 不要实现爬虫逻辑（数据由服务端负责）

---
