// Built from a private repository (agent-data-api jobs/crawler.ts + src/jobs). Do not edit.

// jobs/crawler.ts
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";

// src/jobs/ats.ts
var ATS_NAMES = ["greenhouse", "lever", "ashby", "workable", "smartrecruiters", "recruitee", "bamboohr", "personio", "teamtailor", "workday"];
var LOOKUP_ATS = ATS_NAMES.filter((a) => a !== "workday");
var UA = { "user-agent": "company-jobs-tracker (Apify actor)", accept: "application/json" };
async function request(url, init = {}) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(url, { ...init, headers: { ...UA, ...init.headers }, signal: AbortSignal.timeout(6e4) }).catch(() => null);
    if (res?.ok) return res;
    if (res && res.status !== 429 && res.status < 500) return null;
    await new Promise((r) => setTimeout(r, 1e3 * 2 ** attempt));
  }
  throw new Error(`Job board unavailable: ${url}`);
}
async function getJson(url, init) {
  const res = await request(url, init);
  return res ? res.json().catch(() => null) : null;
}
async function getText(url, accept) {
  const res = await request(url, { headers: { accept } });
  return res ? res.text() : null;
}
var ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
function decodeEntities(s) {
  return s.replace(/&(#x?[0-9a-f]+|\w+);/gi, (m, e) => {
    if (e[0] === "#") return String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}
function htmlToText(html) {
  if (!html) return null;
  const raw = html.includes("&lt;") ? decodeEntities(html) : html;
  const text = decodeEntities(
    raw.replace(/<(script|style)[\s\S]*?<\/\1>/gi, "").replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|li|h[1-6]|ul|ol|tr)>/gi, "\n").replace(/<li[^>]*>/gi, "- ").replace(/<[^>]+>/g, "")
  );
  return text.replace(/[ \t ]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim() || null;
}
var iso = (v) => {
  if (v === null || v === void 0 || v === "") return null;
  const d = new Date(typeof v === "string" && /^\d{4}-\d\d-\d\d /.test(v) ? v.replace(" UTC", "Z").replace(" ", "T") : v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};
var str = (v) => typeof v === "string" && v.trim() ? v.trim() : null;
var looksRemote = (s) => s ? /\bremote\b/i.test(s) : false;
function xmlAll(xml, name) {
  const re = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "g");
  return [...xml.matchAll(re)].map((m) => {
    const cdata = m[1].match(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/);
    return cdata ? cdata[1].trim() : decodeEntities(m[1]).trim();
  });
}
var xml1 = (xml, name) => str(xmlAll(xml, name)[0]);
async function eachDetail(jobs, fill) {
  for (let i = 0; i < jobs.length; i += 5) await Promise.all(jobs.slice(i, i + 5).map(fill));
}
async function greenhouse(board, withDescription) {
  const data = await getJson(`https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(board)}/jobs${withDescription ? "?content=true" : ""}`);
  if (!data) return null;
  return data.jobs.map((j) => {
    const location = str(j.location?.name);
    return {
      company: str(j.company_name) ?? board,
      ats: "greenhouse",
      board,
      jobId: String(j.id),
      title: str(j.title) ?? "",
      department: str(j.departments?.[0]?.name),
      team: null,
      employmentType: null,
      location,
      locations: location ? location.split(/\s*[;|]\s*/) : [],
      country: null,
      remote: looksRemote(location) || null,
      workplaceType: null,
      salary: null,
      postedAt: iso(j.first_published),
      updatedAt: iso(j.updated_at),
      url: j.absolute_url,
      applyUrl: j.absolute_url,
      ...withDescription ? { description: htmlToText(j.content) } : {}
    };
  });
}
async function lever(board, withDescription) {
  const data = await getJson(`https://api.lever.co/v0/postings/${encodeURIComponent(board)}?mode=json`);
  if (!data) return null;
  return data.map((j) => {
    const all = j.categories?.allLocations ?? (j.categories?.location ? [j.categories.location] : []);
    const s = j.salaryRange;
    const description = [j.openingPlain, j.descriptionBodyPlain ?? j.descriptionPlain, ...(j.lists ?? []).map((l) => `${l.text}
${htmlToText(l.content) ?? ""}`), j.additionalPlain].filter(Boolean).join("\n\n");
    return {
      company: board,
      ats: "lever",
      board,
      jobId: j.id,
      title: str(j.text) ?? "",
      department: str(j.categories?.department),
      team: str(j.categories?.team),
      employmentType: str(j.categories?.commitment),
      location: str(j.categories?.location),
      locations: all,
      country: str(j.country),
      remote: j.workplaceType ? j.workplaceType === "remote" : looksRemote(j.categories?.location) || null,
      workplaceType: str(j.workplaceType),
      salary: s ? { min: s.min ?? null, max: s.max ?? null, currency: s.currency ?? null, interval: s.interval ?? null, text: null } : null,
      postedAt: iso(j.createdAt),
      updatedAt: null,
      url: j.hostedUrl,
      applyUrl: str(j.applyUrl),
      ...withDescription ? { description: description.trim() || null } : {}
    };
  });
}
async function ashby(board, withDescription) {
  const data = await getJson(`https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(board)}?includeCompensation=true`);
  if (!data) return null;
  return data.jobs.filter((j) => j.isListed !== false).map((j) => {
    const comp = j.compensation;
    const salaryPart = comp?.summaryComponents?.find((c) => c.compensationType === "Salary");
    const a = j.address?.postalAddress;
    return {
      company: board,
      ats: "ashby",
      board,
      jobId: j.id,
      title: str(j.title) ?? "",
      department: str(j.department),
      team: str(j.team),
      employmentType: str(j.employmentType),
      location: str(j.location),
      locations: [j.location, ...(j.secondaryLocations ?? []).map((l) => l.location)].filter(Boolean),
      country: str(a?.addressCountry),
      // isRemote is also true for hybrid jobs (most of OpenAI's), so workplaceType wins when set.
      remote: j.workplaceType ? j.workplaceType === "Remote" : j.isRemote ?? null,
      workplaceType: str(j.workplaceType),
      salary: comp?.compensationTierSummary || salaryPart ? {
        min: salaryPart?.minValue ?? null,
        max: salaryPart?.maxValue ?? null,
        currency: salaryPart?.currencyCode ?? null,
        interval: salaryPart?.interval ?? null,
        text: str(comp?.scrapeableCompensationSalarySummary) ?? str(comp?.compensationTierSummary)
      } : null,
      postedAt: iso(j.publishedAt),
      updatedAt: null,
      url: j.jobUrl,
      applyUrl: str(j.applyUrl),
      ...withDescription ? { description: str(j.descriptionPlain) } : {}
    };
  });
}
async function workable(board, withDescription) {
  const data = await getJson(`https://apply.workable.com/api/v1/widget/accounts/${encodeURIComponent(board)}${withDescription ? "?details=true" : ""}`);
  if (!data) return null;
  return data.jobs.map((j) => {
    const locs = (j.locations ?? []).map((l) => [l.city, l.region, l.country].filter(Boolean).join(", "));
    const location = locs[0] ?? ([j.city, j.state, j.country].filter(Boolean).join(", ") || null);
    return {
      company: str(data.name) ?? board,
      ats: "workable",
      board,
      jobId: j.shortcode,
      title: str(j.title) ?? "",
      department: str(j.department),
      team: str(j.function),
      employmentType: str(j.employment_type),
      location,
      locations: locs.length ? locs : location ? [location] : [],
      country: str(j.country),
      remote: typeof j.telecommuting === "boolean" ? j.telecommuting : null,
      workplaceType: j.telecommuting ? "remote" : null,
      salary: null,
      postedAt: iso(j.published_on),
      updatedAt: null,
      url: j.url,
      applyUrl: str(j.application_url),
      ...withDescription ? { description: htmlToText(j.description) } : {}
    };
  });
}
async function smartrecruiters(board, withDescription, limit2) {
  const raw = [];
  for (let offset = 0; raw.length < limit2; offset += 100) {
    const page = await getJson(`https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(board)}/postings?limit=100&offset=${offset}`);
    if (!page) return null;
    raw.push(...page.content);
    if (page.content.length < 100 || raw.length >= page.totalFound) break;
  }
  if (raw.length === 0) return null;
  const jobs = raw.slice(0, limit2).map((j) => {
    const l = j.location ?? {};
    const location = str(l.fullLocation)?.replace(/,\s*,/g, ",") ?? null;
    return {
      company: str(j.company?.name) ?? board,
      ats: "smartrecruiters",
      board,
      jobId: String(j.id),
      title: str(j.name) ?? "",
      department: str(j.department?.label),
      team: str(j.function?.label),
      employmentType: str(j.typeOfEmployment?.label),
      location,
      locations: location ? [location] : [],
      country: l.country ? String(l.country).toUpperCase() : null,
      remote: typeof l.remote === "boolean" ? l.remote : null,
      workplaceType: l.remote ? "remote" : l.hybrid ? "hybrid" : "onsite",
      salary: null,
      postedAt: iso(j.releasedDate),
      updatedAt: null,
      url: `https://jobs.smartrecruiters.com/${board}/${j.id}`,
      applyUrl: `https://jobs.smartrecruiters.com/${board}/${j.id}`
    };
  });
  if (withDescription) {
    for (let i = 0; i < jobs.length; i += 5) {
      await Promise.all(
        jobs.slice(i, i + 5).map(async (job) => {
          const d = await getJson(`https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(board)}/postings/${job.jobId}`);
          const s = d?.jobAd?.sections ?? {};
          job.description = htmlToText([s.companyDescription, s.jobDescription, s.qualifications, s.additionalInformation].map((x) => x?.text).filter(Boolean).join("\n"));
          if (d?.postingUrl) job.url = d.postingUrl;
          if (d?.applyUrl) job.applyUrl = d.applyUrl;
        })
      );
    }
  }
  return jobs;
}
async function recruitee(board, withDescription) {
  const data = await getJson(`https://${encodeURIComponent(board)}.recruitee.com/api/offers/`);
  if (!data) return null;
  return data.offers.map((j) => {
    const locs = (j.locations ?? []).map((l) => [l.city, l.state, l.country].filter(Boolean).join(", "));
    const s = j.salary;
    return {
      company: str(j.company_name) ?? board,
      ats: "recruitee",
      board,
      jobId: String(j.id),
      title: str(j.title) ?? "",
      department: str(j.department),
      team: null,
      employmentType: str(j.employment_type_code),
      location: str(j.location),
      locations: locs.length ? locs : j.location ? [j.location] : [],
      country: str(j.country_code),
      remote: typeof j.remote === "boolean" ? j.remote : null,
      workplaceType: j.remote ? "remote" : j.hybrid ? "hybrid" : j.on_site ? "onsite" : null,
      salary: s && (s.min || s.max) ? { min: Number(s.min) || null, max: Number(s.max) || null, currency: s.currency ?? null, interval: s.period ?? null, text: null } : null,
      postedAt: iso(j.published_at),
      updatedAt: iso(j.updated_at),
      url: j.careers_url,
      applyUrl: str(j.careers_apply_url),
      ...withDescription ? { description: htmlToText([j.description, j.requirements].filter(Boolean).join("\n")) } : {}
    };
  });
}
async function bamboohr(board, withDescription) {
  const origin = `https://${encodeURIComponent(board)}.bamboohr.com`;
  const data = await getJson(`${origin}/careers/list`);
  if (!Array.isArray(data?.result)) return null;
  const workplace = { "0": "onsite", "1": "remote", "2": "hybrid" };
  const jobs = data.result.map((j) => {
    const l = j.atsLocation ?? j.location ?? {};
    const location = [l.city, l.state ?? l.province, l.country].filter(Boolean).join(", ") || null;
    const type = workplace[String(j.locationType)] ?? null;
    return {
      company: board,
      ats: "bamboohr",
      board,
      jobId: String(j.id),
      title: str(j.jobOpeningName) ?? "",
      department: str(j.departmentLabel),
      team: null,
      employmentType: str(j.employmentStatusLabel),
      location,
      locations: location ? [location] : [],
      country: str(l.country),
      remote: typeof j.isRemote === "boolean" ? j.isRemote : type ? type === "remote" : looksRemote(location) || null,
      workplaceType: type,
      salary: null,
      postedAt: null,
      updatedAt: null,
      url: `${origin}/careers/${j.id}`,
      applyUrl: `${origin}/careers/${j.id}`
    };
  });
  if (withDescription) {
    await eachDetail(jobs, async (job) => {
      const d = (await getJson(`${origin}/careers/${job.jobId}/detail`))?.result?.jobOpening;
      if (!d) return;
      job.postedAt = iso(d.datePosted);
      job.description = htmlToText(d.description);
      const pay = str(d.compensation);
      if (pay) job.salary = { min: null, max: null, currency: null, interval: null, text: pay };
    });
  }
  return jobs;
}
async function personio(board, withDescription) {
  const origin = `https://${encodeURIComponent(board)}.jobs.personio.de`;
  const xml = await getText(`${origin}/xml?language=en`, "application/xml");
  if (!xml?.includes("<workzag-jobs")) return null;
  const positions = xmlAll(xml, "position");
  if (positions.length === 0) return null;
  return positions.map((position) => {
    const p = position.replace(/<jobDescriptions>[\s\S]*?<\/jobDescriptions>/, "");
    const offices = [xml1(p, "office"), ...xmlAll(xml1(p, "additionalOffices") ?? "", "office")].filter((o) => !!o);
    const id = xml1(p, "id") ?? "";
    const descriptions = xmlAll(position, "jobDescription").map((d) => [xml1(d, "name"), htmlToText(xml1(d, "value"))].filter(Boolean).join("\n"));
    return {
      company: xml1(p, "subcompany") ?? board,
      ats: "personio",
      board,
      jobId: id,
      title: xml1(p, "name") ?? "",
      department: xml1(p, "department"),
      team: xml1(p, "recruitingCategory"),
      employmentType: [xml1(p, "employmentType"), xml1(p, "schedule")].filter(Boolean).join(", ") || null,
      location: offices[0] ?? null,
      locations: [...new Set(offices)],
      country: null,
      remote: offices.some(looksRemote) || null,
      workplaceType: null,
      salary: null,
      postedAt: iso(xml1(p, "createdAt")),
      updatedAt: null,
      url: `${origin}/job/${id}`,
      applyUrl: `${origin}/job/${id}#apply`,
      ...withDescription ? { description: descriptions.join("\n\n").trim() || null } : {}
    };
  });
}
async function teamtailor(board, withDescription) {
  const origin = `https://${encodeURIComponent(board)}.teamtailor.com`;
  const rss = await getText(`${origin}/jobs.rss`, "application/rss+xml, application/xml");
  if (!rss?.includes("<rss")) return null;
  const items = xmlAll(rss, "item");
  if (items.length === 0) return null;
  const workplace = { none: "onsite", hybrid: "hybrid", temporary: "remote", fully: "remote" };
  return items.map((it) => {
    const url = xml1(it, "link") ?? "";
    const locs = xmlAll(it, "tt:location").map((l) => [xml1(l, "tt:city"), xml1(l, "tt:country")].filter(Boolean).join(", ") || xml1(l, "tt:name")).filter((l) => !!l);
    const status2 = xml1(it, "remoteStatus")?.toLowerCase() ?? null;
    const type = status2 ? workplace[status2] ?? status2 : null;
    return {
      company: board,
      ats: "teamtailor",
      board,
      jobId: url.match(/\/jobs\/(\d+)/)?.[1] ?? xml1(it, "guid") ?? url,
      title: xml1(it, "title") ?? "",
      department: xml1(it, "tt:department"),
      team: xml1(it, "tt:role"),
      employmentType: null,
      location: locs[0] ?? null,
      locations: locs,
      country: str(xmlAll(it, "tt:country")[0]),
      remote: type ? type === "remote" : looksRemote(locs.join(" ")) || null,
      workplaceType: type,
      salary: null,
      postedAt: iso(xml1(it, "pubDate")),
      updatedAt: null,
      url,
      applyUrl: url ? `${url.replace(/\/$/, "")}/applications/new` : null,
      ...withDescription ? { description: htmlToText(xml1(it, "description")) } : {}
    };
  });
}
function workdayParts(board) {
  const m = board.match(/^([\w-]+)\.(wd\d+)\/([\w-]+)$/i);
  if (!m) throw new Error(`Workday board "${board}" isn't tenant.wdN/site; paste the careers URL instead.`);
  const [, tenant, wd, site] = m;
  const host = `https://${tenant}.${wd}.myworkdayjobs.com`;
  return { tenant, api: `${host}/wday/cxs/${tenant}/${site}`, site: `${host}/${site}` };
}
function workdayPosted(text) {
  if (!text) return null;
  const days = /today/i.test(text) ? 0 : /yesterday/i.test(text) ? 1 : text.match(/(\d+) days? ago/i) && !/\+/.test(text) ? Number(text.match(/(\d+)/)[1]) : null;
  if (days === null) return null;
  const d = new Date(Date.now() - days * 864e5);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())).toISOString();
}
async function workday(board, withDescription, limit2) {
  const { tenant, api, site } = workdayParts(board);
  const page = async (offset) => await getJson(`${api}/jobs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ appliedFacets: {}, limit: 20, offset, searchText: "" })
  });
  const first = await page(0);
  if (!first) return null;
  const raw = [...first.jobPostings ?? []];
  const total = first.total ?? Infinity;
  let more = raw.length === 20;
  for (let offset = 20; more && offset < Math.min(limit2, total); offset += 100) {
    const offsets = [0, 20, 40, 60, 80].map((d) => offset + d).filter((o) => o < Math.min(limit2, total));
    for (const p of await Promise.all(offsets.map(page))) {
      const postings = p?.jobPostings ?? [];
      raw.push(...postings);
      if (postings.length < 20) {
        more = false;
        break;
      }
    }
  }
  const paths = /* @__PURE__ */ new Map();
  const jobs = raw.slice(0, limit2).map((j) => {
    const path = j.externalPath ?? "";
    const where = str(j.locationsText);
    const location = where && !/^\d+ locations$/i.test(where) ? where : null;
    const type = str(j.remoteType);
    const job = {
      company: tenant,
      ats: "workday",
      board,
      jobId: str(j.bulletFields?.[0]) ?? path.split("/").pop() ?? path,
      title: str(j.title) ?? "",
      department: null,
      team: null,
      employmentType: str(j.timeType),
      location,
      locations: location ? [location] : [],
      country: null,
      remote: type ? /remote/i.test(type) : looksRemote(location) || null,
      workplaceType: type,
      salary: null,
      postedAt: workdayPosted(str(j.postedOn)),
      updatedAt: null,
      url: `${site}${path}`,
      applyUrl: `${site}${path}/apply`
    };
    paths.set(job, path);
    return job;
  });
  if (withDescription) {
    await eachDetail(jobs, async (job) => {
      const d = (await getJson(`${api}${paths.get(job)}`))?.jobPostingInfo;
      if (!d) return;
      const locs = [d.location, ...d.additionalLocations ?? []].filter((l) => typeof l === "string" && !!l);
      if (locs.length) {
        job.location = locs[0];
        job.locations = locs;
      }
      job.country = str(d.country?.descriptor);
      job.postedAt = iso(d.startDate) ?? job.postedAt;
      job.employmentType = str(d.timeType) ?? job.employmentType;
      job.description = htmlToText(d.jobDescription);
      if (str(d.externalUrl)) job.url = d.externalUrl;
      if (str(d.remoteType)) {
        job.workplaceType = d.remoteType;
        job.remote = /remote/i.test(d.remoteType);
      }
    });
  }
  return jobs;
}
async function fetchBoard(b, withDescription, limit2) {
  switch (b.ats) {
    case "greenhouse":
      return greenhouse(b.board, withDescription);
    case "lever":
      return lever(b.board, withDescription);
    case "ashby":
      return ashby(b.board, withDescription);
    case "workable":
      return workable(b.board, withDescription);
    case "smartrecruiters":
      return smartrecruiters(b.board, withDescription, limit2);
    case "recruitee":
      return recruitee(b.board, withDescription);
    case "bamboohr":
      return bamboohr(b.board, withDescription);
    case "personio":
      return personio(b.board, withDescription);
    case "teamtailor":
      return teamtailor(b.board, withDescription);
    case "workday":
      return workday(b.board, withDescription, limit2);
  }
}

// src/jobs/snapshot.ts
var PART_BYTES = 20 * 1024 * 1024;
function compactJob(j) {
  return {
    company: j.company,
    ats: j.ats,
    board: j.board,
    jobId: j.jobId,
    title: j.title,
    department: j.department,
    employmentType: j.employmentType,
    location: j.location ?? (j.locations.length ? j.locations.join("; ") : null),
    country: j.country,
    remote: j.remote,
    workplaceType: j.workplaceType,
    salaryMin: j.salary?.min ?? null,
    salaryMax: j.salary?.max ?? null,
    salaryCurrency: j.salary?.currency ?? null,
    salaryInterval: j.salary?.interval ?? null,
    postedAt: j.postedAt,
    url: j.url,
    applyUrl: j.applyUrl
  };
}
function partsOf(gz2, size = PART_BYTES) {
  const parts = [];
  for (let i = 0; i < gz2.length; i += size) parts.push(gz2.subarray(i, i + size));
  return parts.length ? parts : [new Uint8Array(0)];
}

// jobs/crawler.ts
var args = process.argv.slice(2);
var file = args.find((a) => !a.startsWith("--")) ?? "boards.json";
var limitAt = args.indexOf("--limit");
var limit = limitAt >= 0 ? Number(args[limitAt + 1]) : Infinity;
var upload = !args.includes("--no-upload");
var prune = args.includes("--prune");
var PER_ATS = 8;
var CRAWLED_ATS = ["greenhouse", "lever", "ashby", "workable", "smartrecruiters", "recruitee"];
var directory = JSON.parse(readFileSync(file, "utf8"));
var boards = directory.boards.filter((b) => CRAWLED_ATS.includes(b.ats)).slice(0, limit);
var started = Date.now();
var lines = [];
var status = {};
var counts = { live: 0, gone: 0, error: 0, jobs: 0 };
async function crawlAts(ats) {
  const queue = boards.filter((b) => b.ats === ats);
  const worker = async () => {
    for (let b = queue.shift(); b; b = queue.shift()) {
      try {
        const jobs = await fetchBoard({ ats: b.ats, board: b.slug }, false, 200);
        if (jobs === null) {
          status[`${ats}:${b.slug}`] = "gone";
          counts.gone++;
          continue;
        }
        status[`${ats}:${b.slug}`] = "live";
        counts.live++;
        for (const j of jobs) {
          lines.push(JSON.stringify(compactJob(j)));
          counts.jobs++;
        }
      } catch {
        status[`${ats}:${b.slug}`] = "error";
        counts.error++;
      }
    }
  };
  await Promise.all(Array.from({ length: PER_ATS }, worker));
  console.log(`crawl: ${ats} done after ${Math.round((Date.now() - started) / 1e3)} s (${counts.jobs} jobs so far)`);
}
await Promise.all(CRAWLED_ATS.map(crawlAts));
var crawledAt = (/* @__PURE__ */ new Date()).toISOString();
var gz = gzipSync(lines.join("\n"));
mkdirSync("out", { recursive: true });
writeFileSync("out/jobs.jsonl.gz", gz);
writeFileSync("out/status.json", JSON.stringify({ crawledAt, counts, status }));
console.log(`crawl: ${boards.length} boards (${counts.live} live, ${counts.gone} gone, ${counts.error} errors), ${counts.jobs} jobs, ${(gz.length / 1e6).toFixed(1)} MB gzipped, ${Math.round((Date.now() - started) / 1e3)} s`);
if (prune && counts.gone) {
  const kept = directory.boards.filter((b) => status[`${b.ats}:${b.slug}`] !== "gone");
  writeFileSync(file, JSON.stringify({ ...directory, boards: kept }));
  console.log(`prune: dropped ${directory.boards.length - kept.length} boards that no longer exist`);
}
if (upload) {
  const url = process.env.JOBS_UPLOAD_URL;
  const secret = process.env.JOBS_SECRET;
  if (!url || !secret) throw new Error("JOBS_UPLOAD_URL and JOBS_SECRET are required to upload (or pass --no-upload)");
  const date = crawledAt.slice(0, 10);
  const parts = partsOf(gz);
  const put = async (path, body, type) => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await fetch(`${url}/${path}`, { method: "PUT", headers: { authorization: `Bearer ${secret}`, "content-type": type }, body });
      if (res.ok) return;
      console.error(`upload ${path} -> HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      await new Promise((r) => setTimeout(r, 5e3 * (attempt + 1)));
    }
    throw new Error(`upload ${path} failed`);
  };
  for (const [i, part] of parts.entries()) await put(`${date}/part/${i}`, part, "application/gzip");
  const manifest = { date, crawledAt, parts: parts.length, bytes: gz.length, jobs: counts.jobs, boards: counts.live };
  await put(`${date}/manifest`, JSON.stringify(manifest), "application/json");
  console.log(`upload: ${parts.length} parts, manifest for ${date}`);
}
