// RankFetcher.swift — 苹果端（macOS 13+ / iOS 15+）榜单数据客户端。
// 直接拖进你的 App 工程即可使用，无第三方依赖。
//
// 两种模式：
//   A. 远程模式（推荐）：数据由服务器/CI 每天生成，App 只下载 ranks-apple.json
//   B. 本地模式：launchd 每天在本机生成文件，App 读文件
//
// 用法:
//   let fetcher = RankFetcher(feedURL: URL(string: "https://example.com/ranks-apple.json")!)
//   let ranks = try await fetcher.fetchRanks()          // 网络拉取
//   fetcher.localFileURL = URL(fileURLWithPath: "…/ranks-apple.json")
//   let local = try fetcher.loadLocalRanks()            // 本地文件
//   fetcher.cache(to: …) / try fetcher.loadCached()     // 离线缓存
//   fetcher.publicKeyPEM = "-----BEGIN PUBLIC KEY-----…" // 可选 Ed25519 验签

import Foundation
import CryptoKit

// MARK: - 数据模型（与 ranks-apple.json 严格对应）

public struct RankBook: Codable, Hashable, Sendable {
    public let rank: Int
    public let bid: String?
    public let title: String
    public let author: String?
    public let category: String?
    public let total: String?
    public let status: String?
    public let latestChapter: String?
    public let updateTime: String?
    public let intro: String?
    public let cover: String?
}

public struct RankList: Codable, Hashable, Sendable {
    public let kind: String
    public let name: String
    public let ok: Bool
    public let source: String?
    public let totalsNote: String?
    public let books: [RankBook]
}

public struct RanksFeed: Codable, Sendable {
    public let generatedAt: String
    public let ranks: [RankList]

    public func rank(_ kind: String) -> RankList? {
        ranks.first { $0.kind == kind }
    }
}

// MARK: - 拉取器

public final class RankFetcher: @unchecked Sendable {
    public var feedURL: URL?
    public var localFileURL: URL?
    /// 可选：Ed25519 公钥 PEM，用于校验"签名版"数据（防数据被篡改）
    public var publicKeyPEM: String?

    private let session: URLSession
    private let decoder: JSONDecoder
    private let encoder: JSONEncoder

    public init(feedURL: URL? = nil, localFileURL: URL? = nil, publicKeyPEM: String? = nil) {
        self.feedURL = feedURL
        self.localFileURL = localFileURL
        self.publicKeyPEM = publicKeyPEM
        let cfg = URLSessionConfiguration.default
        cfg.requestCachePolicy = .reloadIgnoringLocalCacheData
        cfg.timeoutIntervalForRequest = 60
        self.session = URLSession(configuration: cfg)
        self.decoder = JSONDecoder()
        self.encoder = JSONEncoder()
    }

    /// 远程拉取（App 每次启动/前台时调用一次即可，24 小时内数据不变）
    public func fetchRanks() async throws -> RanksFeed {
        guard let url = feedURL else { throw RankError.noFeedURL }
        var request = URLRequest(url: url)
        request.setValue("reforge-rank-client/1.0", forHTTPHeaderField: "User-Agent")
        request.cachePolicy = .reloadIgnoringLocalCacheData
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            throw RankError.badStatus
        }
        return try parse(data)
    }

    /// 本地文件（launchd 每日任务产物）
    public func loadLocalRanks() throws -> RanksFeed {
        guard let url = localFileURL, FileManager.default.fileExists(atPath: url.path) else {
            throw RankError.noLocalFile
        }
        let data = try Data(contentsOf: url)
        return try parse(data)
    }

    /// 缓存到磁盘（离线兜底）
    public func cache(_ feed: RanksFeed, to url: URL) throws {
        let data = try encoder.encode(feed)
        try data.write(to: url, options: .atomic)
    }

    public func loadCached(from url: URL) throws -> RanksFeed {
        return try decoder.decode(RanksFeed.self, from: Data(contentsOf: url))
    }

    // MARK: 解析 + 可选验签

    private func parse(_ data: Data) throws -> RanksFeed {
        return try decoder.decode(RanksFeed.self, from: data)
    }

    /// 签名版格式：签名由服务端对 canonical JSON 计算后附在 HTTP 头
    /// `X-Ranks-Signature: base64`（或独立 ranks-apple.sig 文件）
    public func fetchSignedRanks(signatureURL: URL? = nil, signatureHeader: String = "X-Ranks-Signature") async throws -> RanksFeed {
        guard let url = feedURL else { throw RankError.noFeedURL }
        var request = URLRequest(url: url)
        let (data, response) = try await session.data(for: request)
        guard let pem = publicKeyPEM else { throw RankError.noPublicKey }
        var sigData: Data? = nil
        if let http = response as? HTTPURLResponse, let b64 = http.value(forHTTPHeaderField: signatureHeader) {
            sigData = Data(base64Encoded: b64)
        } else if let sURL = signatureURL {
            let (sig, _) = try await session.data(from: sURL)
            sigData = sig
        }
        guard let sig = sigData else { throw RankError.noSignature }
        try verifyEd25519(data, signature: sig, publicKeyPEM: pem)
        return try decoder.decode(RanksFeed.self, from: data)
    }

    private func verifyEd25519(_ data: Data, signature: Data, publicKeyPEM: String) throws {
        guard let pk = try? Curve25519.Signing.PublicKey(pemRepresentation: publicKeyPEM) else {
            throw RankError.badPublicKey
        }
        guard pk.isValidSignature(signature, for: data) else {
            throw RankError.badSignature
        }
    }
}

public enum RankError: Error, LocalizedError {
    case noFeedURL, noLocalFile, noPublicKey, noSignature, badPublicKey, badSignature, badStatus
    public var errorDescription: String? {
        switch self {
        case .noFeedURL: return "未配置榜单数据地址"
        case .noLocalFile: return "本地榜单文件不存在"
        case .noPublicKey: return "未配置验签公钥"
        case .noSignature: return "数据缺少签名"
        case .badPublicKey: return "公钥格式无效"
        case .badSignature: return "签名校验失败（数据可能被篡改）"
        case .badStatus: return "服务器响应异常"
        }
    }
}

// MARK: - SwiftUI 使用示例（放在你 App 的 View 里即可）

// struct RankView: View {
//     @State private var yuepiao: RankList?
//     @State private var errorText: String?
//
//     var body: some View {
//         List(yuepiao?.books ?? []) { book in
//             HStack {
//                 Text("\(book.rank)").bold()
//                 VStack(alignment: .leading) {
//                     Text(book.title)
//                     Text("\(book.author ?? "") · \(book.category ?? "")").font(.caption)
//                 }
//                 Spacer()
//                 Text(book.total ?? "").font(.caption)
//             }
//         }
//         .task {
//             do {
//                 let fetcher = RankFetcher(feedURL: URL(string: "https://example.com/ranks-apple.json")!)
//                 yuepiao = try await fetcher.fetchRanks().rank("yuepiao")
//             } catch { errorText = error.localizedDescription }
//         }
//     }
// }
