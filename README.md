# Career site jobs crawler

The daily crawler behind [Career Site Jobs Search](https://apify.com/lx112/career-site-jobs-search)
on Apify. It reads the public job boards that companies publish on their applicant tracking system
(Greenhouse, Lever, Ashby, Workable, SmartRecruiters and Recruitee), through each system's public
job-board API, and uploads one snapshot of all open jobs.

- `boards.json`: the directory of company boards, from [Common Crawl](https://commoncrawl.org)'s
  URL index (`directory.mjs`, monthly) and public lists on GitHub, merged by `merge-directory.mjs`.
  Each crawl drops boards that no longer exist.
- `crawler.mjs`: one request per board, a few boards per system at a time. Boards that no longer
  exist are skipped.
- `.github/workflows/`: the twice-daily crawl and the monthly directory refresh.

`crawler.mjs` is a bundled build; its source lives in a private repository. Job postings are the
companies' own public data.

Run it yourself without uploading:

```bash
node crawler.mjs boards.json --limit 100 --no-upload   # writes out/jobs.jsonl.gz and out/status.json
```

MIT licensed.
