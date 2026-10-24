// Builds the directory of company job boards (F4, notes/f4-plan.md) from Common Crawl's URL index:
// every URL crawled under an ATS's board host gives a company slug. Writes jobs/data/boards-cc.json.
//   node jobs/directory.mjs [crawls=3]
import { mkdirSync, writeFileSync } from "node:fs";

const SOURCES = [
  { ats: "greenhouse", pattern: "boards.greenhouse.io/*", slug: (p) => p[0] },
  { ats: "greenhouse", pattern: "job-boards.greenhouse.io/*", slug: (p) => p[0] },
  { ats: "lever", pattern: "jobs.lever.co/*", slug: (p) => p[0] },
  { ats: "ashby", pattern: "jobs.ashbyhq.com/*", slug: (p) => p[0] },
  { ats: "workable", pattern: "apply.workable.com/*", slug: (p) => p[0] },
  { ats: "smartrecruiters", pattern: "jobs.smartrecruiters.com/*", slug: (p) => p[0] },
  { ats: "recruitee", pattern: "*.recruitee.com", slug: (_p, host) => host.split(".")[0] },
];
const SKIP = new Set(["", "embed", "api", "v1", "jobs", "assets", "static", "favicon.ico", "robots.txt", "sitemap.xml", "careers", "j", "o", "oauth", "login", "search", "c", "www", "app", "cdn", "help", "support"]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(url, tries = 6) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { headers: { "user-agent": "onchaincheck-jobs-directory/1.0 (+https://onchaincheck.dev)" }, signal: AbortSignal.timeout(90_000) });
      if (res.ok) return await res.text();
      if (res.status === 404) return "";
    } catch {}
    await sleep(5_000 * 2 ** i);
  }
  throw new Error(`gave up: ${url}`);
}

const nCrawls = Number(process.argv[2] ?? 3);
const crawls = JSON.parse(await get("https://index.commoncrawl.org/collinfo.json")).slice(0, nCrawls).map((c) => c.id);
const boards = new Map(); // "ats:slug" -> hits
for (const crawl of crawls) {
  for (const src of SOURCES) {
    const base = `https://index.commoncrawl.org/${crawl}-index?url=${encodeURIComponent(src.pattern)}&output=json&fl=url`;
    let pages = 1;
    try {
      pages = JSON.parse(await get(`${base}&showNumPages=true`)).pages ?? 1;
    } catch (e) {
      console.error(`${crawl} ${src.pattern}: page count failed, trying page 0 only`);
    }
    let found = 0;
    for (let page = 0; page < pages; page++) {
      let text = "";
      try {
        text = await get(`${base}&page=${page}`);
      } catch (e) {
        console.error(`${crawl} ${src.pattern} page ${page}: ${e.message}`);
        continue;
      }
      for (const line of text.split("\n")) {
        if (!line) continue;
        let u;
        try {
          u = new URL(JSON.parse(line).url);
        } catch {
          continue;
        }
        const parts = u.pathname.split("/").filter(Boolean);
        const slug = (src.slug(parts, u.hostname) ?? "").toLowerCase();
        if (!slug || SKIP.has(slug) || !/^[a-z0-9][a-z0-9._-]{0,80}$/.test(slug)) continue;
        const key = `${src.ats}:${slug}`;
        if (!boards.has(key)) found++;
        boards.set(key, (boards.get(key) ?? 0) + 1);
      }
      await sleep(1_000);
    }
    console.log(`${crawl} ${src.pattern}: ${pages} pages, ${found} new boards (total ${boards.size})`);
  }
}
mkdirSync("jobs/data", { recursive: true });
const list = [...boards.entries()].map(([k, hits]) => ({ ats: k.split(":")[0], slug: k.slice(k.indexOf(":") + 1), hits })).sort((a, b) => b.hits - a.hits);
writeFileSync("jobs/data/boards-cc.json", JSON.stringify({ crawls, built: new Date().toISOString(), boards: list }));
const by = {};
for (const b of list) by[b.ats] = (by[b.ats] ?? 0) + 1;
console.log("boards by ATS:", by);
