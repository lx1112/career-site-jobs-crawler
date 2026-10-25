// Merges directory sources into one boards.json (F4): any number of { boards: [{ ats, slug }] } files,
// deduplicated, keeping each board's first-listed order. The crawl later drops boards that are gone.
//   node jobs/merge-directory.mjs out.json in1.json [in2.json ...] [--exclude gone.json]
// --exclude leaves out boards a crawl found gone (the crawler's gone.json). Extra fields on a
// board (the crawler's `fails` count) are kept from the first file that lists it.
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const ex = args.indexOf("--exclude");
const excludeFile = ex >= 0 ? args.splice(ex, 2)[1] : null;
const [out, ...inputs] = args;
const seen = new Set();
let excluded = 0;
if (excludeFile && existsSync(excludeFile)) {
  for (const { ats, slug } of JSON.parse(readFileSync(excludeFile, "utf8")).boards ?? []) seen.add(`${ats}:${slug}`);
  excluded = seen.size;
}
const boards = [];
const sources = {};
for (const file of inputs) {
  if (!existsSync(file)) continue;
  let added = 0;
  for (const board of JSON.parse(readFileSync(file, "utf8")).boards ?? []) {
    const key = `${board.ats}:${board.slug}`;
    if (seen.has(key)) continue;
    seen.add(key);
    boards.push(board);
    added++;
  }
  sources[file] = added;
}
writeFileSync(out, JSON.stringify({ built: new Date().toISOString(), boards }));
console.log(`${boards.length} boards`, sources, excludeFile ? `${excluded} excluded as gone` : "");
