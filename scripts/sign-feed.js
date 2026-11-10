// 对 ranks-apple.json 生成 Ed25519 签名（与 Swift CryptoKit isValidSignature 直接兼容）。
// 用法: node scripts/sign-feed.js --file daily-ranks/ranks-apple.json --key update-keys.json [--out ranks-apple.sig]
// 服务端发布时把 .sig 文件与 JSON 一起放到静态托管；App 端用 fetchSignedRanks 验签。
import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";

const args = process.argv.slice(2);
const argVal = (name) => {
  const i = args.indexOf(name);
  return i !== -1 && args[i + 1] ? args[i + 1] : null;
};
const file = argVal("--file");
const keyFile = argVal("--key");
if (!file || !keyFile) {
  console.error("用法: sign-feed.js --file ranks-apple.json --key update-keys.json");
  process.exit(1);
}
const data = fs.readFileSync(file);
const keys = JSON.parse(fs.readFileSync(keyFile, "utf-8"));
const signature = crypto.sign(null, data, keys.privateKey);
const out = argVal("--out") || file + ".sig";
fs.writeFileSync(out, signature);
console.log(`已签名: ${file} → ${out} (${signature.length} bytes, Ed25519)`);
console.log(`公钥（App 端配置）:\n${keys.publicKey}`);
