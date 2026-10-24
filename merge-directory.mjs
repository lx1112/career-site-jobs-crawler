// Merges directory sources into one boards.json (F4): any number of { boards: [{ ats, slug }] } files,
// deduplicated, keeping each board's first-listed order. The crawl later drops boards that are gone.
//   node jobs/merge-directory.mjs out.json in1.json [in2.json ...]
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const [out, ...inputs] = process.argv.slice(2);
const seen = new Set();
const boards = [];
const sources = {};
for (const file of inputs) {
  if (!existsSync(file)) continue;
  let added = 0;
  for (const { ats, slug } of JSON.parse(readFileSync(file, "utf8")).boards ?? []) {
    const key = `${ats}:${slug}`;
    if (seen.has(key)) continue;
    seen.add(key);
    boards.push({ ats, slug });
    added++;
  }
  sources[file] = added;
}
writeFileSync(out, JSON.stringify({ built: new Date().toISOString(), boards }));
console.log(`${boards.length} boards`, sources);
