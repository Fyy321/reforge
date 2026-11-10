# 榜单数据接入说明（给负责接入你软件源码的 AI/工程师）

## 一句话任务

把本仓库 `apple/RankFetcher.swift` 这一个文件复制进你的苹果 App 工程，然后按下方两段代码接入：每天从数据源网址拉取一次 11 个起点榜单（书名/作者/简介/封面/排名/数值），用 SwiftUI 展示。

## 客户端所需（仅此而已）

- **唯一要复制的文件**：`apple/RankFetcher.swift`（零第三方依赖，Swift Codable + URLSession + CryptoKit）
- **数据源网址**：`https://<GitHub用户名>.github.io/<仓库名>/ranks-apple.json`
  （找不到的话先随便填，接入后由主人提供真实地址）

## 数据格式（ranks-apple.json，与 Swift 模型一一对应）

```json
{
  "generatedAt": "2026-11-10T16:35:56Z",
  "ranks": [
    {
      "kind": "yuepiao", "name": "月票榜", "ok": true,
      "books": [
        {
          "rank": 1, "bid": "1050460263",
          "title": "神宠供应商", "author": "轻泉流响",
          "category": "轻小说", "total": "36071月票",
          "status": "连载",
          "latestChapter": "最新更新 第216章…", "updateTime": "2026-11-10 12:05",
          "intro": "海洋纪元，人类与变异海兽共存……（简介全文）",
          "cover": "https://bookcover.yuewen.com/qdbimg/349573/1050460263/180.webp"
        }
      ]
    }
  ]
}
```

## 接入代码（Swift）

### 1) 拉取 + 缓存

```swift
import Foundation

final class RankService: ObservableObject {
    @Published var ranks: [RankList] = []
    @Published var errorText: String?
    private let fetcher: RankFetcher
    private let cacheURL: URL

    init() {
        // TODO: 替换为真实数据源网址
        self.fetcher = RankFetcher(feedURL: URL(string: "https://<用户名>.github.io/<仓库名>/ranks-apple.json")!)
        let dir = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
        self.cacheURL = dir.appendingPathComponent("ranks-cache.json")
    }

    /// App 启动或回到前台时调用一次（数据每天由服务器更新一次，无需轮询）
    func refresh() async {
        do {
            let feed = try await fetcher.fetchRanks()
            ranks = feed.ranks
            try? fetcher.cache(feed, to: cacheURL)
        } catch {
            // 网络失败回退缓存
            if let cached = try? fetcher.loadCached(from: cacheURL) {
                ranks = cached.ranks
            } else {
                errorText = error.localizedDescription
            }
        }
    }
}
```

### 2) SwiftUI 展示（书名/作者/简介/封面）

```swift
import SwiftUI

struct RankView: View {
    @StateObject private var service = RankService()
    let kind: String          // 如 "yuepiao"
    let title: String         // 如 "月票榜"

    var body: some View {
        let list = service.ranks.first { $0.kind == kind }
        List(list?.books ?? []) { book in
            HStack(alignment: .top, spacing: 12) {
                Text("\(book.rank)").font(.title3).bold()
                    .frame(width: 28)
                AsyncImage(url: URL(string: book.cover ?? "")) { img in
                    img.resizable().aspectRatio(contentMode: .fill)
                } placeholder: {
                    Color.gray.opacity(0.2)
                }
                .frame(width: 56, height: 74).clipShape(RoundedRectangle(cornerRadius: 6))
                VStack(alignment: .leading, spacing: 4) {
                    Text(book.title).font(.headline).lineLimit(1)
                    Text("\(book.author ?? "") · \(book.category ?? "")")
                        .font(.caption).foregroundColor(.secondary)
                    Text(book.intro ?? "").font(.caption)
                        .lineLimit(2).foregroundColor(.secondary)
                    Text(book.total ?? "").font(.caption2).bold()
                }
            }
        }
        .navigationTitle(title)
        .task { await service.refresh() }
    }
}

// 使用: RankView(kind: "yuepiao", title: "月票榜")
```

## 注意

- 数据每天 04:30（北京）更新一次，客户端**不需要也不应该**高频轮询；启动/回前台时 `refresh()` 一次即可。
- `cover` 是官方 CDN 直链（webp），`AsyncImage` 自带缓存，不需要下载到本地。
- 可选用 `fetchSignedRanks()` + 公钥做防篡改验签（公钥由主人在 GitHub workflow 日志中提供）。
- `RankBook` 字段均为可选类型，UI 层请容错空值。
