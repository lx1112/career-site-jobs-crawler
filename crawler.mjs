// Built from a private repository (agent-data-api jobs/crawler.ts + src/jobs). Do not edit.

// jobs/crawler.ts
import { createHash } from "node:crypto";
import { appendFileSync, createReadStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { dirname, join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";

// src/jobs/ats.ts
var ATS_NAMES = ["greenhouse", "lever", "ashby", "workable", "smartrecruiters", "recruitee", "bamboohr", "personio", "teamtailor", "rippling", "gem", "breezy", "pinpoint", "workday"];
var LOOKUP_ATS = ATS_NAMES.filter((a) => a !== "workday");
var UA = { "user-agent": "company-jobs-tracker (Apify actor)", accept: "application/json" };
var timeoutMs = 6e4;
function setRequestTimeout(ms) {
  timeoutMs = ms;
}
async function request(url, init = {}) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(url, { ...init, headers: { ...UA, ...init.headers }, signal: AbortSignal.timeout(timeoutMs) }).catch(() => null);
    if (res?.ok) return res;
    if (res && res.status !== 429 && res.status < 500) return null;
    await new Promise((r) => setTimeout(r, 1e3 * 2 ** attempt));
  }
  throw new Error(`Job board unavailable: ${url}`);
}
async function getJson(url, init) {
  const res = await request(url, init);
  if (!res) return null;
  const text = await res.text().catch((e) => {
    throw new Error(`Job board read failed: ${url}: ${e.message}`);
  });
  return parseJsonOrNull(text);
}
function parseJsonOrNull(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
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
async function workday(board, withDescription, limit2, searchTexts = []) {
  const { tenant, api, site } = workdayParts(board);
  const page = async (offset, searchText) => await getJson(`${api}/jobs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ appliedFacets: {}, limit: 20, offset, searchText })
  });
  const list = async (searchText) => {
    const first = await page(0, searchText);
    if (!first) return null;
    const out = [...first.jobPostings ?? []];
    const total = Math.min(first.total ?? Infinity, WORKDAY_CAP);
    let more = out.length === 20;
    for (let offset = 20; more && offset < Math.min(limit2, total); offset += 100) {
      const offsets = [0, 20, 40, 60, 80].map((d) => offset + d).filter((o) => o < Math.min(limit2, total));
      for (const p of await Promise.all(offsets.map((o) => page(o, searchText)))) {
        const postings = p?.jobPostings ?? [];
        out.push(...postings);
        if (postings.length < 20) {
          more = false;
          break;
        }
      }
    }
    return out;
  };
  const lists = [];
  for (const t of searchTexts.length ? searchTexts : [""]) lists.push(await list(t));
  if (lists.every((l) => l === null)) return null;
  const seenPaths = /* @__PURE__ */ new Set();
  const raw = lists.flatMap((l) => l ?? []).filter((j) => {
    const key = j.externalPath ?? JSON.stringify(j);
    return !seenPaths.has(key) && seenPaths.add(key);
  });
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
async function rippling(board) {
  const data = await getJson(`https://api.rippling.com/platform/api/ats/v1/board/${encodeURIComponent(board)}/jobs`);
  if (!Array.isArray(data)) return null;
  return data.map((j) => {
    const where = str(j.workLocation?.label);
    return {
      company: board,
      ats: "rippling",
      board,
      jobId: String(j.uuid ?? j.url ?? ""),
      title: str(j.name) ?? "",
      department: str(j.department?.label),
      team: null,
      employmentType: null,
      location: where,
      locations: where ? [where] : [],
      country: null,
      remote: looksRemote(where) || null,
      workplaceType: null,
      salary: null,
      postedAt: null,
      updatedAt: null,
      url: str(j.url) ?? `https://ats.rippling.com/${board}/jobs`,
      applyUrl: str(j.url)
    };
  });
}
async function gem(board, withDescription) {
  const data = await getJson(`https://api.gem.com/job_board/v0/${encodeURIComponent(board)}/job_posts`);
  if (!Array.isArray(data)) return null;
  return data.map((j) => {
    const where = str(j.location?.name);
    const type = str(j.location_type);
    return {
      company: board,
      ats: "gem",
      board,
      jobId: String(j.id ?? j.absolute_url ?? ""),
      title: str(j.title) ?? "",
      department: str(j.departments?.[0]?.name),
      team: null,
      employmentType: str(j.employment_type),
      location: where,
      locations: [...new Set([where, ...(j.offices ?? []).map((o) => str(o.location?.name))].filter((l) => !!l))],
      country: null,
      remote: type ? type === "remote" : looksRemote(where) || null,
      workplaceType: type,
      salary: null,
      postedAt: iso(j.first_published_at ?? j.created_at),
      updatedAt: iso(j.updated_at),
      url: str(j.absolute_url) ?? `https://jobs.gem.com/${board}`,
      applyUrl: str(j.absolute_url),
      ...withDescription ? { description: str(j.content_plain) } : {}
    };
  });
}
async function breezy(board) {
  const data = await getJson(`https://${encodeURIComponent(board)}.breezy.hr/json`);
  if (!Array.isArray(data)) return null;
  return data.map((j) => {
    const locs = j.locations?.length ? j.locations : j.location ? [j.location] : [];
    const names = locs.map((l) => str(l.name)).filter((l) => !!l);
    const remote = locs.some((l) => l.is_remote === true) ? true : locs.length ? false : null;
    return {
      company: str(j.company?.name) ?? board,
      ats: "breezy",
      board,
      jobId: String(j.id ?? j.friendly_id ?? ""),
      title: str(j.name) ?? "",
      department: str(j.department),
      team: null,
      employmentType: str(j.type?.name),
      location: names[0] ?? null,
      locations: names,
      country: str(locs[0]?.country?.id),
      remote,
      workplaceType: remote === null ? null : remote ? "remote" : null,
      salary: str(j.salary) ? { min: null, max: null, currency: null, interval: null, text: str(j.salary) } : null,
      postedAt: iso(j.published_date),
      updatedAt: null,
      url: str(j.url) ?? `https://${board}.breezy.hr/`,
      applyUrl: str(j.url)
    };
  });
}
async function pinpoint(board, withDescription) {
  const data = await getJson(`https://${encodeURIComponent(board)}.pinpointhq.com/postings.json`);
  if (!data || !Array.isArray(data.data)) return null;
  return data.data.map((j) => {
    const where = str(j.location?.name) ?? ([j.location?.city, j.location?.province].filter(Boolean).join(", ") || null);
    const type = str(j.workplace_type);
    const pay = j.compensation_visible ? { min: j.compensation_minimum ?? null, max: j.compensation_maximum ?? null, currency: str(j.compensation_currency), interval: str(j.compensation_frequency), text: str(j.compensation) } : null;
    return {
      company: board,
      ats: "pinpoint",
      board,
      jobId: String(j.id ?? j.path ?? ""),
      title: str(j.title) ?? "",
      department: str(j.job?.department?.name),
      team: str(j.job?.division?.name),
      employmentType: str(j.employment_type_text) ?? str(j.employment_type),
      location: where,
      locations: where ? [where] : [],
      country: null,
      remote: type ? type === "remote" : looksRemote(where) || null,
      workplaceType: type,
      salary: pay,
      postedAt: null,
      updatedAt: null,
      url: str(j.url) ?? `https://${board}.pinpointhq.com/`,
      applyUrl: str(j.url),
      ...withDescription ? { description: htmlToText(j.description) } : {}
    };
  });
}
var WORKDAY_CAP = 2e3;
async function fetchBoard(b, withDescription, limit2, searchTexts = []) {
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
    case "rippling":
      return rippling(b.board);
    case "gem":
      return gem(b.board, withDescription);
    case "breezy":
      return breezy(b.board);
    case "pinpoint":
      return pinpoint(b.board, withDescription);
    case "workday":
      return workday(b.board, withDescription, limit2, searchTexts);
  }
}

// src/jobs/content.ts
var DESCRIBED_ATS = ["greenhouse", "lever", "ashby", "workable", "recruitee"];
var w = (re) => new RegExp(`(?<![A-Za-z0-9+#.])(?:${re})(?![A-Za-z0-9+#])`, "i");
var cs = (re) => new RegExp(`(?<![A-Za-z0-9+#.])(?:${re})(?![A-Za-z0-9+#])`);
var LANGS = "Python|Java|Rust|C\\+\\+|Kotlin|TypeScript|Ruby|Scala|JavaScript|PHP";
var SKILLS = [
  // languages
  ["python", w("python")],
  ["javascript", w("javascript")],
  ["typescript", w("typescript")],
  ["java", cs("Java")],
  ["csharp", w("c#|\\.net|dotnet")],
  ["cpp", w("c\\+\\+")],
  ["go", cs(`[Gg]olang|(?:${LANGS})(?:,| or| and|/) ?Go|Go(?:,|/| or| and) (?:${LANGS})`)],
  ["rust", cs("Rust")],
  ["ruby", w("ruby on rails|ruby")],
  ["php", w("php")],
  ["swift", cs("SwiftUI|Swift(?:,|/| and| or| \\d| programming| developers?| code)|Objective-C")],
  ["kotlin", w("kotlin")],
  ["scala", cs("Scala")],
  ["sql", w("sql")],
  ["elixir", w("elixir")],
  ["solidity", w("solidity")],
  // frontend and mobile
  ["react", cs("React(?:\\.js|JS)?|ReactJS|react\\.js|reactjs")],
  ["react-native", w("react native")],
  ["angular", w("angular(?:js)?")],
  ["vue", cs("Vue(?:\\.js|JS|js| ?[23])|VueJS|vue\\.js|vuejs")],
  ["nextjs", w("next\\.js|nextjs")],
  ["nodejs", w("node\\.js|nodejs")],
  ["flutter", w("flutter")],
  ["ios", cs("iOS")],
  ["android", w("android")],
  // backend, data stores, messaging
  ["django", w("django")],
  ["rails", w("rails")],
  ["spring", w("spring boot|spring framework")],
  ["graphql", w("graphql")],
  ["postgres", w("postgres(?:ql)?")],
  ["mysql", w("mysql")],
  ["mongodb", w("mongodb|mongo db")],
  ["redis", w("redis")],
  ["elasticsearch", w("elasticsearch|opensearch")],
  ["kafka", w("kafka")],
  ["rabbitmq", w("rabbitmq")],
  ["dynamodb", w("dynamodb")],
  // cloud and infrastructure
  ["aws", cs("AWS|Amazon Web Services")],
  ["gcp", cs("GCP|Google Cloud")],
  ["azure", w("azure")],
  ["kubernetes", w("kubernetes|k8s")],
  ["docker", w("docker")],
  ["terraform", w("terraform")],
  ["ansible", w("ansible")],
  ["linux", w("linux")],
  ["cloudflare", w("cloudflare")],
  ["datadog", w("datadog")],
  ["grafana", w("grafana")],
  ["jenkins", w("jenkins")],
  ["github-actions", w("github actions")],
  // data and analytics
  ["snowflake", w("snowflake")],
  ["databricks", w("databricks")],
  ["bigquery", w("bigquery")],
  ["redshift", w("redshift")],
  ["dbt", cs("dbt")],
  ["airflow", w("airflow")],
  ["spark", cs("Spark|PySpark")],
  ["tableau", w("tableau")],
  ["power-bi", w("power ?bi")],
  ["looker", w("looker")],
  ["excel", cs("(?:Microsoft|MS|[Aa]dvanced|in|with|and|using) Excel|Excel (?:skills|spreadsheets?|models?|modeling|formulas|and|or)")],
  ["pandas", w("pandas")],
  // machine learning
  ["machine-learning", w("machine learning")],
  ["llm", w("llms?|large language models?|generative ai|genai")],
  ["pytorch", w("pytorch")],
  ["tensorflow", w("tensorflow")],
  ["openai", w("openai")],
  ["anthropic", cs("Anthropic|Claude Code|Claude AI")],
  ["langchain", w("langchain")],
  ["hugging-face", w("hugging ?face")],
  ["computer-vision", w("computer vision")],
  ["nlp", cs("NLP")],
  // business systems
  ["salesforce", w("salesforce|sfdc")],
  ["hubspot", w("hubspot")],
  ["marketo", w("marketo")],
  ["outreach", cs("Outreach\\.io")],
  ["gong", cs("Gong")],
  ["zendesk", w("zendesk")],
  ["intercom", cs("Intercom")],
  ["sap", cs("SAP")],
  ["netsuite", w("netsuite")],
  ["workday", cs("Workday")],
  ["quickbooks", w("quickbooks")],
  ["oracle", cs("Oracle")],
  ["servicenow", w("servicenow")],
  ["jira", w("jira")],
  ["shopify", w("shopify")],
  ["stripe", cs("Stripe")],
  ["google-analytics", w("google analytics|ga4")],
  ["google-ads", w("google ads|adwords")],
  // design and product
  ["figma", w("figma")],
  ["adobe-creative", w("photoshop|illustrator|adobe creative|indesign")],
  ["autocad", w("autocad")],
  ["solidworks", w("solidworks")],
  // security, compliance, methods
  ["soc2", w("soc ?2")],
  ["hipaa", cs("HIPAA")],
  ["gdpr", cs("GDPR")],
  ["pci", cs("PCI(?:[ -]DSS)?")],
  ["iso27001", w("iso ?27001")],
  ["agile", w("agile|scrum")],
  ["ci-cd", w("ci/cd|continuous integration")],
  // crypto
  ["blockchain", w("blockchain|web3")],
  ["ethereum", w("ethereum")],
  ["solana", cs("Solana")],
  ["defi", cs("DeFi")]
];
function skillsIn(text) {
  const t = text.length > 2e4 ? text.slice(0, 2e4) : text;
  const out = [];
  for (const [name, re] of SKILLS) if (re.test(t)) out.push(name);
  return out;
}
var SENIORITY = [
  ["intern", /\b(intern(ship)?|working student|werkstudent|apprentice|trainee|co-?op)\b/i],
  ["executive", /\b(chief|c[efotmpr]o|vp|vice president|svp|evp|head of|general manager|president)\b/i],
  ["director", /\bdirector\b/i],
  ["manager", /\b(manager|supervisor|team lead)\b/i],
  ["principal", /\b(principal|staff|distinguished|fellow|architect)\b/i],
  ["senior", /\b(senior|sr\.?|lead|expert|iii|iv)\b/i],
  ["junior", /\b(junior|jr\.?|entry[- ]level|graduate|associate|assistant|i)\b/i]
];
function seniorityOf(title) {
  for (const [level, re] of SENIORITY) if (re.test(title)) return level;
  return "mid";
}
function yearsOf(text) {
  let min = null;
  for (const m of text.slice(0, 2e4).matchAll(/\b(\d{1,2})\s*(?:\+|\s*(?:-|–|to)\s*\d{1,2})?\s*(?:years?|yrs?)\b(?!\s*old)/gi)) {
    const n = Number(m[1]);
    if (n >= 1 && n <= 20 && (min === null || n < min)) min = n;
  }
  return min;
}
var CONTENT_BATCH = 500;
function contentFacts(title, description, own = []) {
  const mine = new Set(own.map((o) => o.toLowerCase().replace(/[^a-z0-9]/g, "")));
  const skills = skillsIn(`${title}
${description}`).filter((s) => !mine.has(s.replace(/[^a-z0-9]/g, "")));
  return { n: description.length, l: seniorityOf(title), y: yearsOf(description), sk: skills.join(",") };
}
var f = (name) => `j.value ->> '${name}'`;
var CONTENT_INSERT_SQL = `INSERT OR IGNORE INTO job_content (key, seen, hash, len, seniority, years, skills) SELECT ${f("k")}, ${f("s")}, ${f("h")}, ${f("n")}, ${f("l")}, ${f("y")}, ${f("sk")} FROM json_each(?1) j WHERE ${f("k")} IS NOT NULL`;
var NOT_A_COMPANY = /* @__PURE__ */ new Set([
  "gmail.com",
  "outlook.com",
  "hotmail.com",
  "yahoo.com",
  "icloud.com",
  "linkedin.com",
  "facebook.com",
  "twitter.com",
  "x.com",
  "instagram.com",
  "youtube.com",
  "youtu.be",
  "tiktok.com",
  "glassdoor.com",
  "indeed.com",
  "google.com",
  "goo.gl",
  "bit.ly",
  "zoom.us",
  "apple.com",
  "microsoft.com",
  "github.com",
  "medium.com",
  "notion.so",
  "notion.site",
  "calendly.com",
  "vimeo.com",
  "wikipedia.org",
  "w3.org",
  "schema.org",
  "amazonaws.com",
  "cloudfront.net",
  "website-files.com",
  "webflow.io",
  "squarespace.com",
  "wixsite.com",
  "greenhouse.io",
  "lever.co",
  "ashbyhq.com",
  "workable.com",
  "recruitee.com",
  "smartrecruiters.com",
  "myworkdayjobs.com",
  "bamboohr.com",
  "personio.com",
  "teamtailor.com",
  "eeoc.gov",
  "dol.gov",
  "e-verify.gov",
  "uscis.gov",
  "dhs.gov",
  "justice.gov",
  "ssa.gov",
  "gov.uk",
  "europa.eu",
  "typeform.com",
  "docusign.com",
  "adobe.com",
  "hirevue.com",
  "checkr.com",
  "sterlingcheck.com"
]);
var TWO_LEVEL = /\.(co|com|org|net|gov|ac|edu)\.[a-z]{2}$/;
function siteOf(host) {
  const h = host.toLowerCase().replace(/\.$/, "");
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(h)) return null;
  const labels = h.split(".");
  const site = labels.slice(TWO_LEVEL.test(h) ? -3 : -2).join(".");
  return NOT_A_COMPANY.has(site) ? null : site;
}
function sitesIn(text) {
  const out = /* @__PURE__ */ new Set();
  for (const m of text.slice(0, 3e4).matchAll(/(?:https?:\/\/|www\.|@)([a-z0-9][a-z0-9.-]{1,80}\.[a-z]{2,24})/gi)) {
    const site = siteOf(m[1]);
    if (site) out.add(site);
  }
  return [...out];
}
var AGENCY_PHRASE = /\b(our client|on behalf of (our|a|the) client|for (one of )?our clients?|client of ours|our clients are)\b/i;
var AGENCY_NAME = /\b(staffing|recruit(ment|ing|ers?)|talent (solutions|partners|group)|personnel|headhunt\w*|executive search|search (partners|group)|employment (agency|services)|workforce solutions)\b/i;
var AGENCY_SHARE = 0.15;
var AGENCY_MIN_DESCRIBED = 5;
var newTally = (company) => ({ company, jobs: 0, described: 0, agency: 0, sites: /* @__PURE__ */ new Map() });
function tally(t, description) {
  t.jobs++;
  if (!description) return;
  t.described++;
  if (AGENCY_PHRASE.test(description)) t.agency++;
  for (const s of sitesIn(description)) t.sites.set(s, (t.sites.get(s) ?? 0) + 1);
}
var squash = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
function identityOf(ats, board, t) {
  let best = null;
  const names = [squash(board), squash(t.company)].filter((n) => n.length >= 3);
  for (const [site, n] of t.sites) {
    const label = squash(site.split(".")[0]);
    const named = label.length >= 3 && names.some((x) => x.includes(label) || label.includes(x));
    const ok = named || n >= 2 && n >= 0.2 * t.described;
    if (!ok) continue;
    const score = n + (named ? t.described : 0);
    if (!best || score > best[1]) best = [site, score];
  }
  const domain = best?.[0] ?? null;
  const staffing = AGENCY_NAME.test(t.company) || t.described >= AGENCY_MIN_DESCRIBED && t.agency >= AGENCY_SHARE * t.described;
  return {
    a: ats,
    b: board,
    c: t.company.slice(0, 200),
    d: domain,
    ds: domain && t.described ? Math.round((t.sites.get(domain) ?? 0) / t.described * 100) / 100 : null,
    st: staffing ? 1 : 0,
    de: t.described,
    n: t.jobs
  };
}
var IDENTITY_BATCH = 500;
var IDENTITY_UPSERT_SQL = `INSERT INTO board_identity (ats, board, company, domain, domain_share, staffing, described, jobs, first_day, updated_day) SELECT ${f("a")}, ${f("b")}, ${f("c")}, ${f("d")}, ${f("ds")}, ${f("st")}, ${f("de")}, ${f("n")}, ?2, ?2 FROM json_each(?1) j WHERE ${f("a")} IS NOT NULL AND ${f("b")} IS NOT NULL ON CONFLICT(ats, board) DO UPDATE SET company = excluded.company, domain = coalesce(excluded.domain, domain), domain_share = CASE WHEN excluded.domain IS NULL THEN domain_share ELSE excluded.domain_share END, staffing = CASE WHEN excluded.staffing = 1 OR excluded.described < ${AGENCY_MIN_DESCRIBED} THEN max(staffing, excluded.staffing) ELSE 0 END, described = excluded.described, jobs = excluded.jobs, updated_day = excluded.updated_day`;

// src/jobs/lifecycle.ts
var EPOCH = Date.UTC(2026, 0, 1);
var f2 = (name) => `json_extract(j.value, '$.${name}')`;
var LIFECYCLE_OPEN_SQL = `INSERT INTO job_lifecycle (key, ats, board, title_norm, first_seen, posted_at, pay_currency, pay_first_min, pay_first_max, pay_last_min, pay_last_max) SELECT ${f2("k")}, ${f2("a")}, ${f2("b")}, ${f2("t")}, ${f2("s")}, ${f2("p")}, ${f2("c")}, ${f2("mn")}, ${f2("mx")}, ${f2("mn")}, ${f2("mx")} FROM json_each(?1) j WHERE true ON CONFLICT(key) DO UPDATE SET reopened = reopened + (closed_at IS NOT NULL), closed_at = NULL, pay_currency = coalesce(excluded.pay_currency, pay_currency), pay_last_min = excluded.pay_last_min, pay_last_max = excluded.pay_last_max`;

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
var jobKey = (j) => `${j.ats}:${j.board}:${j.jobId}`;
var historyId = (crawledAt2) => crawledAt2.slice(0, 16).replace(":", "");
function diffSnapshots(previous, current, status2) {
  const board = (j) => `${j.ats}:${j.board}`;
  const before = /* @__PURE__ */ new Map();
  const prevBoards = /* @__PURE__ */ new Map();
  for (const j of previous) {
    before.set(jobKey(j), j);
    prevBoards.set(board(j), (prevBoards.get(board(j)) ?? 0) + 1);
  }
  const counts2 = {};
  const nowKeys = /* @__PURE__ */ new Set();
  for (const j of current) {
    nowKeys.add(jobKey(j));
    counts2[board(j)] = (counts2[board(j)] ?? 0) + 1;
  }
  const events = [];
  let opened = 0;
  let closed = 0;
  let boardsAdded = 0;
  const added = /* @__PURE__ */ new Set();
  for (const j of current) {
    const b = board(j);
    if (!prevBoards.has(b)) {
      if (!added.has(b)) {
        added.add(b);
        boardsAdded++;
        events.push({ e: "board-added", ats: j.ats, board: j.board, company: j.company, jobs: counts2[b] });
      }
      continue;
    }
    if (!before.has(jobKey(j))) {
      events.push({ e: "open", ...j });
      opened++;
    }
  }
  let boardsGone = 0;
  const skipped = /* @__PURE__ */ new Set();
  for (const [b, n] of prevBoards) {
    const st = status2[b];
    if (st === "gone") {
      const [ats, ...rest] = b.split(":");
      events.push({ e: "board-gone", ats, board: rest.join(":"), jobs: n });
      boardsGone++;
    } else if (st !== "live") skipped.add(b);
  }
  for (const [k, j] of before) {
    if (nowKeys.has(k) || status2[board(j)] !== "live") continue;
    events.push({ e: "close", ats: j.ats, board: j.board, jobId: j.jobId, title: j.title, postedAt: j.postedAt });
    closed++;
  }
  return { events, opened, closed, boardsAdded, boardsGone, boardsSkipped: skipped.size, counts: counts2 };
}

// src/jobs/search-index.ts
var SYNC_BATCH = 500;
var EPOCH2 = Date.UTC(2026, 0, 1);
function rowId(seenAt2, n) {
  if (n < 0 || n >= 1e6) throw new Error("sequence out of range");
  return Math.floor((seenAt2 - EPOCH2) / 6e4) * 1e6 + n;
}
var PER_YEAR = { year: 1, month: 12, week: 52, day: 260, hour: 2080, once: null };
function salaryInterval(raw) {
  const s = (raw ?? "").toLowerCase();
  if (!s) return null;
  if (/time|one/.test(s)) return "once";
  if (/hour/.test(s)) return "hour";
  if (/day/.test(s)) return "day";
  if (/week/.test(s)) return "week";
  if (/month/.test(s)) return "month";
  if (/year|annual/.test(s)) return "year";
  return null;
}
var MAJOR = /* @__PURE__ */ new Set(["USD", "EUR", "GBP", "CAD", "AUD", "NZD", "CHF", "SGD"]);
function correctedInterval(interval, min, max, currency) {
  const top = Math.max(min ?? 0, max ?? 0);
  if (!currency || !MAJOR.has(currency.toUpperCase())) return interval;
  if (interval === "month" && top >= 2e4) return "year";
  if (interval === "hour" && top >= 1e3) return "year";
  return interval;
}
var isRemote = (j) => j.remote === true || /remote/i.test(`${j.location ?? ""} ${j.workplaceType ?? ""}`);
function indexRow(j, id) {
  const interval = correctedInterval(salaryInterval(j.salaryInterval), j.salaryMin, j.salaryMax, j.salaryCurrency);
  const perYear = interval ? PER_YEAR[interval] : null;
  const yearly = (v) => v != null && perYear ? Math.round(v * perYear) : null;
  const tags = [isRemote(j) ? "remote" : "", j.ats, j.employmentType?.toLowerCase().replace(/[^a-z]/g, "") ?? "", j.salaryMin || j.salaryMax ? "salary" : ""];
  return {
    id,
    key: jobKey(j),
    title: j.title,
    company: j.company,
    place: [j.location, j.country].filter(Boolean).join(" | "),
    tags: tags.filter(Boolean).join(" "),
    ats: j.ats,
    board: j.board,
    department: j.department,
    employment_type: j.employmentType,
    location: j.location,
    country: j.country,
    remote: isRemote(j) ? 1 : 0,
    salary_min: j.salaryMin,
    salary_max: j.salaryMax,
    salary_currency: j.salaryCurrency?.toUpperCase() ?? null,
    salary_interval: interval,
    salary_year_min: yearly(j.salaryMin),
    salary_year_max: yearly(j.salaryMax),
    posted_at: j.postedAt,
    url: j.url
  };
}
var INDEX_COLUMNS = [
  "title",
  "company",
  "place",
  "tags",
  "key",
  "ats",
  "board",
  "department",
  "employment_type",
  "location",
  "country",
  "remote",
  "salary_min",
  "salary_max",
  "salary_currency",
  "salary_interval",
  "salary_year_min",
  "salary_year_max",
  "posted_at",
  "url"
];
var INSERT_JOBS_SQL = `INSERT INTO jobs (rowid, ${INDEX_COLUMNS.join(", ")}) SELECT r.value ->> 'id', ` + INDEX_COLUMNS.map((c) => `r.value ->> '${c}'`).join(", ") + " FROM json_each(?1) r WHERE NOT EXISTS (SELECT 1 FROM job_ids i WHERE i.key = r.value ->> 'key')";
var MAX_PLACES = 10;
function mergeByKey(jobs) {
  const byKey = /* @__PURE__ */ new Map();
  for (const j of jobs) {
    const k = jobKey(j);
    const e = byKey.get(k);
    if (!e) {
      byKey.set(k, { job: { ...j }, locations: j.location ? [j.location] : [], countries: j.country ? [j.country] : [] });
      continue;
    }
    if (j.location && !e.locations.includes(j.location)) e.locations.push(j.location);
    if (j.country && !e.countries.includes(j.country)) e.countries.push(j.country);
    if (j.remote === true) e.job.remote = true;
    if (!e.job.workplaceType && j.workplaceType) e.job.workplaceType = j.workplaceType;
  }
  const list = (xs) => xs.length ? xs.slice(0, MAX_PLACES).join("; ") + (xs.length > MAX_PLACES ? `; +${xs.length - MAX_PLACES} more` : "") : null;
  return [...byKey.values()].map(({ job, locations, countries }) => ({ ...job, location: list(locations), country: list(countries) }));
}
function indexDiff(previous, current, status2) {
  const before = /* @__PURE__ */ new Set();
  const beforeBoard = /* @__PURE__ */ new Map();
  for (const j of previous) {
    const k = jobKey(j);
    before.add(k);
    beforeBoard.set(k, `${j.ats}:${j.board}`);
  }
  const now = new Set(current.map(jobKey));
  const open = mergeByKey(current.filter((j) => !before.has(jobKey(j))));
  const settled = (k) => ["live", "gone"].includes(status2[beforeBoard.get(k)]);
  const close = [...before].filter((k) => !now.has(k) && settled(k));
  return { open, close };
}

// src/jobs/profile.ts
var ACTIVITY_BATCH = 2e3;

// src/jobs/hiring-trend.ts
var RULES = [
  ["people", /\b(recruit\w*|talent|sourcer|human resources|hr|hrbp|people (ops|operations|partner|team)|payroll)\b/i],
  ["legal", /\b(legal|counsel|attorney|lawyer|paralegal|compliance|privacy officer)\b/i],
  ["finance", /\b(financ\w*|accountant|accounting|controller|tax|treasury|audit\w*|fp&a|bookkeep\w*|billing|payable|receivable|actuar\w*)\b/i],
  ["sales", /\b(sales|account executive|business development|bdr|sdr|account manager|solutions? (engineer|consultant|architect)|pre-?sales|partnerships?|revenue|commercial)\b/i],
  ["marketing", /\b(marketing|brand|growth|content|seo|communications|pr|social media|copywriter|demand gen\w*|community|events?)\b/i],
  ["customer", /\b(customer|support|success|service desk|help ?desk|onboarding|implementation|client services?)\b/i],
  ["design", /\b(design\w*|ux|ui|creative|illustrat\w*|art director|animator)\b/i],
  ["data", /\b(data|machine learning|ml|ai|analytics|scientist|research(er)?|analyst|statistic\w*)\b/i],
  ["product", /\b(product (manager|owner|lead|director|management|operations)|head of product|program manager|technical program)\b/i],
  ["engineering", /\b(engineer\w*|developer|software|devops|sre|infrastructure|security|architect|qa|test\w*|firmware|hardware|it|sysadmin|network|technical|programmer|cto)\b/i],
  ["healthcare", /\b(nurse|nursing|rn|lpn|physician|clinical|clinician|therap\w*|medical|pharmac\w*|dental|health\w*|caregiver|patient)\b/i],
  ["operations", /\b(operations|ops|logistics|supply chain|warehouse|procurement|purchasing|facilit\w*|office|admin\w*|assistant|coordinator|project manager|driver|technician|manufactur\w*|production|store|retail|crew|associate)\b/i]
];
var FUNCTIONS = [...RULES.map(([f3]) => f3), "other"];
function titleFunction(title) {
  for (const [f3, re] of RULES) if (re.test(title)) return f3;
  return "other";
}
function placeOf(location) {
  const first = (location ?? "").split(/;|\|/)[0].trim();
  if (!first || /^\+\d+ more$/.test(first) || /^(n\/?a|none|tbd|tba|various|multiple locations?|flexible|-+)$/i.test(first)) return null;
  if (/\b(remote|anywhere|distributed|work from home|wfh)\b/i.test(first)) return "Remote";
  const city = first.split(",")[0].replace(/\s*\(.*\)\s*$/, "").trim();
  return city ? city.slice(0, 40) : null;
}
var remoteJob = (j) => j.remote === true || /remote/i.test(`${j.location ?? ""} ${j.workplaceType ?? ""}`);
var MIX_PLACES = 8;
function activityWithMix(events, closed = () => void 0) {
  const by = /* @__PURE__ */ new Map();
  for (const e of events) {
    if (e.e !== "open" && e.e !== "close") continue;
    const k = `${e.ats}:${e.board}`;
    let b = by.get(k);
    if (!b) by.set(k, b = { ats: e.ats, board: e.board, opened: /* @__PURE__ */ new Map(), closed: /* @__PURE__ */ new Map() });
    if (e.e === "open") {
      if (!b.opened.has(e.jobId)) b.opened.set(e.jobId, e);
    } else if (!b.closed.has(e.jobId)) b.closed.set(e.jobId, e);
  }
  return [...by.values()].map((b) => {
    const mix = { f: {}, l: {}, r: [0, 0] };
    const add = (title, d, i) => {
      const f3 = titleFunction(title);
      (mix.f[f3] ??= [0, 0])[i]++;
      if (!d) return;
      const p = placeOf(d.location);
      if (p) (mix.l[p] ??= [0, 0])[i]++;
      if (remoteJob(d)) mix.r[i]++;
    };
    for (const e of b.opened.values()) add(e.title, e, 0);
    for (const e of b.closed.values()) add(e.title, closed(`${b.ats}:${b.board}:${e.jobId}`), 1);
    const places = Object.entries(mix.l).sort((x, y) => y[1][0] + y[1][1] - (x[1][0] + x[1][1]) || x[0].localeCompare(y[0]));
    mix.l = Object.fromEntries(places.slice(0, MIX_PLACES));
    return { ats: b.ats, board: b.board, opened: b.opened.size, closed: b.closed.size, mix };
  });
}

// src/jobs/prune.ts
var SYSTEM_DOWN_SHARE = 0.5;
var SYSTEM_DOWN_MIN_BOARDS = 5;
function systemDown(errors, crawled) {
  return crawled >= SYSTEM_DOWN_MIN_BOARDS && errors >= crawled * SYSTEM_DOWN_SHARE;
}
var BREAKER_AFTER = 20;
var BREAKER_SHARE = 0.9;
function breakerOpen(tried, errors, live) {
  return tried >= BREAKER_AFTER && live === 0 && errors >= tried * BREAKER_SHARE;
}

// jobs/crawler.ts
var args = process.argv.slice(2);
var file = args.find((a) => !a.startsWith("--")) ?? "boards.json";
var limitAt = args.indexOf("--limit");
var limit = limitAt >= 0 ? Number(args[limitAt + 1]) : Infinity;
var upload = !args.includes("--no-upload");
var prune = args.includes("--prune");
var PER_ATS = { workable: 2, workday: 4 };
var WORKERS = 8;
var PACE_MS = { workable: 700 };
var COOLDOWN_MS = 3e4;
var RETRY_PAUSE_MS = 6e4;
var FAIL_LIMIT = 3;
var FAIL_LIMIT_BY_ATS = { workday: 10 };
var CRAWLED_ATS = ["greenhouse", "lever", "ashby", "workable", "smartrecruiters", "recruitee", "workday"];
var LIMIT = { smartrecruiters: 200, workday: 2e3 };
setRequestTimeout(2e4);
var withContent = process.env.JOBS_CONTENT !== "0";
var facts = /* @__PURE__ */ new Map();
var tallies = /* @__PURE__ */ new Map();
var TEXT_FILE = "out/text-all.jsonl";
var textBuffer = [];
var flushText = () => {
  if (textBuffer.length) appendFileSync(TEXT_FILE, textBuffer.join("\n") + "\n");
  textBuffer = [];
};
function recordContent(boardKey, jobs) {
  if (!jobs.length) return;
  const t = newTally(jobs[0].company);
  for (const j of jobs) {
    tally(t, j.description);
    if (!j.description) continue;
    const k = jobKey(compactJob(j));
    facts.set(k, { h: createHash("sha256").update(j.description).digest("hex").slice(0, 16), ...contentFacts(j.title, j.description, [j.company, j.board]) });
    textBuffer.push(JSON.stringify({ k, t: j.description }));
  }
  tallies.set(boardKey, t);
  if (textBuffer.length >= 2e3) flushText();
}
var directory = JSON.parse(readFileSync(file, "utf8"));
var boards = directory.boards.filter((b) => CRAWLED_ATS.includes(b.ats)).slice(0, limit);
var started = Date.now();
mkdirSync("out", { recursive: true });
rmSync(TEXT_FILE, { force: true });
var lines = [];
var status = {};
var counts = { live: 0, gone: 0, error: 0, jobs: 0 };
var sleep = (ms) => new Promise((r) => setTimeout(r, ms));
var nextStart = {};
async function pace(ats, slower) {
  const gap = PACE_MS[ats];
  if (!gap) return;
  const at = Math.max(Date.now(), nextStart[ats] ?? 0);
  nextStart[ats] = at + gap * slower;
  await sleep(at - Date.now());
}
async function crawlAts(ats, queue, workers, slower) {
  const pass = { tried: 0, errors: 0, live: 0, open: false };
  const worker = async () => {
    for (let b = queue.shift(); b; b = queue.shift()) {
      const key = `${ats}:${b.slug}`;
      if (pass.open || breakerOpen(pass.tried, pass.errors, pass.live)) {
        if (!pass.open) console.log(`crawl: ${ats} errored on ${pass.errors} of the first ${pass.tried} boards; the other ${queue.length + 1} are marked errored without a request`);
        pass.open = true;
        status[key] = "error";
        continue;
      }
      pass.tried++;
      await pace(ats, slower);
      try {
        const jobs = await fetchBoard({ ats: b.ats, board: b.slug }, withContent && DESCRIBED_ATS.includes(ats), LIMIT[ats] ?? 200);
        if (jobs === null) {
          status[key] = "gone";
          counts.gone++;
          continue;
        }
        status[key] = "live";
        pass.live++;
        counts.live++;
        for (const j of jobs) {
          lines.push(JSON.stringify(compactJob(j)));
          counts.jobs++;
        }
        try {
          recordContent(key, jobs);
        } catch (e) {
          console.error(`content: ${key}: ${e.message}`);
        }
      } catch {
        status[key] = "error";
        pass.errors++;
        if (PACE_MS[ats]) nextStart[ats] = Math.max(nextStart[ats] ?? 0, Date.now() + COOLDOWN_MS);
      }
    }
  };
  await Promise.all(Array.from({ length: workers }, worker));
}
await Promise.all(
  CRAWLED_ATS.map(async (ats) => {
    await crawlAts(ats, boards.filter((b) => b.ats === ats), PER_ATS[ats] ?? WORKERS, 1);
    console.log(`crawl: ${ats} done after ${Math.round((Date.now() - started) / 1e3)} s (${counts.jobs} jobs so far)`);
  })
);
var failed = boards.filter((b) => status[`${b.ats}:${b.slug}`] === "error");
if (failed.length) {
  console.log(`retry: ${failed.length} boards errored; second pass after ${RETRY_PAUSE_MS / 1e3} s`);
  await sleep(RETRY_PAUSE_MS);
  const crawled = (ats) => boards.filter((b) => b.ats === ats).length;
  const retried = CRAWLED_ATS.filter((ats) => !systemDown(failed.filter((b) => b.ats === ats).length, crawled(ats)));
  for (const ats of CRAWLED_ATS) if (!retried.includes(ats)) console.log(`retry: ${ats} skipped (most of its boards errored)`);
  await Promise.all(retried.map((ats) => crawlAts(ats, failed.filter((b) => b.ats === ats), 2, 2)));
}
counts.error = boards.filter((b) => status[`${b.ats}:${b.slug}`] === "error").length;
var errorsByAts = {};
for (const b of boards) if (status[`${b.ats}:${b.slug}`] === "error") errorsByAts[b.ats] = (errorsByAts[b.ats] ?? 0) + 1;
flushText();
var crawledAt = (/* @__PURE__ */ new Date()).toISOString();
var gz = gzipSync(lines.join("\n"));
mkdirSync("out", { recursive: true });
writeFileSync("out/jobs.jsonl.gz", gz);
writeFileSync("out/status.json", JSON.stringify({ crawledAt, counts, status }));
console.log(`content: ${facts.size} postings with a description on ${tallies.size} boards`);
console.log(`crawl: ${boards.length} boards (${counts.live} live, ${counts.gone} gone, ${counts.error} errors ${JSON.stringify(errorsByAts)}), ${counts.jobs} jobs, ${(gz.length / 1e6).toFixed(1)} MB gzipped, ${Math.round((Date.now() - started) / 1e3)} s`);
if (prune) {
  const crawledByAts = {};
  for (const b of boards) crawledByAts[b.ats] = (crawledByAts[b.ats] ?? 0) + 1;
  const down = new Set(Object.keys(errorsByAts).filter((a) => systemDown(errorsByAts[a], crawledByAts[a] ?? 0)));
  for (const a of down) console.log(`prune: ${a} errored on ${errorsByAts[a]} of ${crawledByAts[a]} boards; its fail counts left unchanged (system-wide failure)`);
  const dropped = [];
  const kept = [];
  for (const b of directory.boards) {
    const st = status[`${b.ats}:${b.slug}`];
    const fails = st === "error" ? (b.fails ?? 0) + (down.has(b.ats) ? 0 : 1) : st === "live" ? 0 : b.fails ?? 0;
    if (st === "gone" || fails >= (FAIL_LIMIT_BY_ATS[b.ats] ?? FAIL_LIMIT)) dropped.push({ ats: b.ats, slug: b.slug });
    else kept.push(fails ? { ats: b.ats, slug: b.slug, fails } : { ats: b.ats, slug: b.slug });
  }
  writeFileSync(file, JSON.stringify({ ...directory, boards: kept }));
  const goneFile = join(dirname(file), "gone.json");
  const gone = existsSync(goneFile) ? JSON.parse(readFileSync(goneFile, "utf8")).boards : [];
  const known = new Set(gone.map((b) => `${b.ats}:${b.slug}`));
  for (const b of dropped) if (!known.has(`${b.ats}:${b.slug}`)) gone.push(b);
  writeFileSync(goneFile, JSON.stringify({ boards: gone }));
  console.log(`prune: dropped ${dropped.length} boards (gone, or failed ${FAIL_LIMIT} crawls in a row); gone.json has ${gone.length}`);
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
  try {
    const auth = { authorization: `Bearer ${secret}` };
    const prev = await fetch(`${url}/latest`, { headers: auth });
    if (prev.ok) {
      const pm = await prev.json();
      const chunks = [];
      for (let i = 0; i < pm.parts; i++) {
        const r = await fetch(`${url}/${pm.date}/part/${i}`, { headers: auth });
        if (!r.ok) throw new Error(`previous part ${i}: HTTP ${r.status}`);
        chunks.push(Buffer.from(await r.arrayBuffer()));
      }
      const previous = gunzipSync(Buffer.concat(chunks)).toString("utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
      const current = lines.map((l) => JSON.parse(l));
      const d = diffSnapshots(previous, current, status);
      const id = historyId(crawledAt);
      const summary = { id, previous: pm.crawledAt, crawledAt, opened: d.opened, closed: d.closed, boardsAdded: d.boardsAdded, boardsGone: d.boardsGone, boardsSkipped: d.boardsSkipped, counts: d.counts };
      await put(`history/${id}/events`, gzipSync(d.events.map((e) => JSON.stringify(e)).join("\n")), "application/gzip");
      await put(`history/${id}/summary`, JSON.stringify(summary), "application/json");
      console.log(`history: ${id} vs ${pm.crawledAt}: ${d.opened} opened, ${d.closed} closed, ${d.boardsAdded} boards added, ${d.boardsGone} gone, ${d.boardsSkipped} skipped`);
      try {
        const before = new Map(previous.map((j) => [jobKey(j), j]));
        const rows = activityWithMix(d.events, (k) => before.get(k));
        for (let b = 0; b * ACTIVITY_BATCH < rows.length; b++) {
          const body = { crawl: id, day: crawledAt.slice(0, 10), rows: rows.slice(b * ACTIVITY_BATCH, (b + 1) * ACTIVITY_BATCH) };
          const res = await fetch(`${url}/activity`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify(body) });
          if (!res.ok) throw new Error(`batch ${b}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
        }
        console.log(`activity: ${rows.length} boards`);
      } catch (e) {
        console.error(`activity: sync failed (run npm run jobs-activity-backfill): ${e.message}`);
      }
      try {
        const x = indexDiff(previous, current, status);
        const seenAt2 = Date.parse(crawledAt);
        const open = x.open.map((j, i) => indexRow(j, rowId(seenAt2, i)));
        const batches = Math.max(Math.ceil(open.length / SYNC_BATCH), Math.ceil(x.close.length / SYNC_BATCH), 1);
        let written = 0;
        for (let b = 0; b < batches; b++) {
          const body = { open: open.slice(b * SYNC_BATCH, (b + 1) * SYNC_BATCH), close: x.close.slice(b * SYNC_BATCH, (b + 1) * SYNC_BATCH), ...b === batches - 1 ? { synced: crawledAt } : {} };
          const res = await fetch(`${url}/index`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify(body) });
          if (!res.ok) throw new Error(`batch ${b}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
          written += (await res.json()).written;
        }
        console.log(`index: ${x.open.length} added, ${x.close.length} removed in ${batches} batches, ${written} rows written`);
        try {
          const seen = Math.floor(seenAt2 / 1e3);
          const fresh = new Set(x.open.map(jobKey));
          const rows = [];
          for (const k of fresh) {
            const c = facts.get(k);
            if (c) rows.push({ k, s: seen, ...c });
          }
          let stored = 0;
          for (let b = 0; b * CONTENT_BATCH < rows.length; b++) {
            const res = await fetch(`${url}/content`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ rows: rows.slice(b * CONTENT_BATCH, (b + 1) * CONTENT_BATCH) }) });
            if (!res.ok) throw new Error(`content batch ${b}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
            stored += (await res.json()).written;
          }
          console.log(`content: ${rows.length} of ${fresh.size} new postings have a description; ${stored} rows written`);
          if (rows.length && existsSync(TEXT_FILE)) {
            const PART_CHARS = 4e7;
            let part = [];
            let chars = 0;
            let parts2 = 0;
            const send = async () => {
              if (!part.length) return;
              await put(`text/${id}/part/${parts2++}`, gzipSync(part.join("\n")), "application/gzip");
              part = [];
              chars = 0;
            };
            for await (const line of createInterface({ input: createReadStream(TEXT_FILE), crlfDelay: Infinity })) {
              const at = line.indexOf('","t":');
              if (at < 6 || !fresh.has(JSON.parse(line.slice(5, at + 1)))) continue;
              part.push(line);
              chars += line.length;
              if (chars >= PART_CHARS) await send();
            }
            await send();
            console.log(`text: ${parts2} parts for ${id}`);
          }
        } catch (e) {
          console.error(`content: sync failed (this crawl's new postings keep no content): ${e.message}`);
        }
      } catch (e) {
        console.error(`index: sync failed (run npm run jobs-index-load to rebuild): ${e.message}`);
      }
    } else console.log(`history: no previous snapshot (HTTP ${prev.status}); skipped`);
  } catch (e) {
    console.error(`history: skipped: ${e.message}`);
  }
  try {
    const rows = [...tallies].map(([key, t]) => identityOf(key.slice(0, key.indexOf(":")), key.slice(key.indexOf(":") + 1), t));
    for (let b = 0; b * IDENTITY_BATCH < rows.length; b++) {
      const res = await fetch(`${url}/identity`, { method: "POST", headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" }, body: JSON.stringify({ day: date, rows: rows.slice(b * IDENTITY_BATCH, (b + 1) * IDENTITY_BATCH) }) });
      if (!res.ok) throw new Error(`batch ${b}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    }
    console.log(`identity: ${rows.length} boards, ${rows.filter((r) => r.d).length} with a domain, ${rows.filter((r) => r.st).length} staffing`);
  } catch (e) {
    console.error(`identity: sync failed: ${e.message}`);
  }
  for (const [i, part] of parts.entries()) await put(`${date}/part/${i}`, part, "application/gzip");
  const manifest = { date, crawledAt, parts: parts.length, bytes: gz.length, jobs: counts.jobs, boards: counts.live };
  await put(`${date}/manifest`, JSON.stringify(manifest), "application/json");
  console.log(`upload: ${parts.length} parts, manifest for ${date}`);
}
rmSync(TEXT_FILE, { force: true });
