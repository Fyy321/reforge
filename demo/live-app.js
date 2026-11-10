// 演示宿主软件：把 RankLive 植入现有程序。
// 运行: node demo/live-app.js   （每 20 秒刷新三个榜，Ctrl+C 退出）
import { RankLive } from "../src/rank-live.js";

// ===== 这里开始是你现有软件的代码 =====
console.log("宿主软件启动中…（模拟）");
// ====================================

// 植入：三行接入
const live = new RankLive({
  kinds: ["yuepiao", "hotsales", "recom"],
  intervalMs: 20000,          // 后台每 20 秒全量刷新
  storeDir: new URL("./live-data", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"),
  logger: (m) => console.log(m),
  onDiff: (diff) => {
    for (const [kind, events] of Object.entries(diff.kinds)) {
      for (const e of events.slice(0, 10)) {
        console.log(`  [变化] ${kind}: ${e.type === "new" ? "新上榜" : e.type === "out" ? "掉榜" : e.type === "up" ? "↑" : "↓"} ${e.title} ${e.from ?? ""} → ${e.to ?? ""}`);
      }
    }
  },
  onUpdate: (snap) => {
    const y = snap.kinds.yuepiao;
    console.log(`[榜单更新 ${snap.updatedAt}] 月票榜 Top3: ${y.books.slice(0, 3).map((b) => `${b.rank}.${b.title} ${b.total}`).join("  ")}`);
  },
});

await live.start();

// 宿主随时拉取最新数据（内存快照或磁盘文件）
setTimeout(() => {
  const snap = live.snapshot();
  console.log("宿主 pull 快照：", snap.kinds.yuepiao.books[0]);
}, 30000);
