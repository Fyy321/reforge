import fs from "node:fs";
const html = fs.readFileSync(process.argv[2], "utf-8");
const idx = html.indexOf("g_data");
console.log("g_data at:", idx);
if (idx !== -1) console.log(JSON.stringify(html.slice(idx, idx + 2500)));
