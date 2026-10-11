const fs = require("fs");
const p = "E:/DEVELOPMENT/landing-page/index.html";
const lines = fs.readFileSync(p, "utf8").split(/\r?\n/);
const start = lines.findIndex((l) => l.includes("tt-track-legacy"));
const end = lines.findIndex((l) => l.includes("<!--/tt:track-->"));
if (start < 0 || end < 0) {
  console.error("markers", start, end);
  process.exit(1);
}
const next = lines
  .slice(0, start)
  .concat(["    <!--/tt:track-->"])
  .concat(lines.slice(end + 1));
fs.writeFileSync(p, next.join("\n"));
console.log("removed lines", start + 1, "to", end + 1, "new length", next.length);
