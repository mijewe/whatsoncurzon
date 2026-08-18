# Curzon, but better

A single page that lists films and showtimes across your favourite London Curzon
cinemas for a chosen date — because Curzon's own site only shows one cinema at a time.

Live page: `docs/index.html`, reading `docs/data.json`.

## How it works

Curzon's own showtimes API (`digital-api.curzon.com`) doesn't send CORS headers, so
a page hosted on GitHub Pages can't call it directly from the browser. Instead:

- [`scripts/fetch-showtimes.mjs`](scripts/fetch-showtimes.mjs) runs headless Chromium
  once to load a curzon.com page and pull out the short-lived API token embedded in
  it (curzon.com sits behind a Cloudflare check that blocks plain HTTP requests, so
  this step needs a real browser). It then calls the API directly for the cinema
  list, film details, and showtimes for the next 10 days across the 10 London
  Curzon cinemas, and writes it all to `docs/data.json`.
- [`.github/workflows/refresh-data.yml`](.github/workflows/refresh-data.yml) runs
  that script every 6 hours on GitHub Actions and commits the updated
  `docs/data.json` — so the published page always reads fresh static data with no
  server of its own.
- `docs/index.html` is a plain static page: date picker, a cinema picker whose
  selection is saved to `localStorage`, and a render of `docs/data.json` grouped by
  cinema → film → times.
- Rotten Tomatoes scores and links come straight from RT's own `/search` page
  (Curzon's data has none, and there's no free RT API). Unlike OMDb-style
  aggregators, RT's own site has the score the moment RT publishes it — no lag
  for brand-new releases. RT's search is a loose relevance search, not an exact
  lookup, so a result only counts if its own title actually matches the film we
  searched for; anything that doesn't match closely enough is treated as "no RT
  page found" rather than risk showing a wrong film's score. Found scores are
  cached in `docs/data.json` and not re-checked; a film found on RT but without
  a score yet is re-checked every run until it gets one.

## Hosting on GitHub Pages

1. Push this repo to GitHub.
2. In the repo's Settings → Pages, set the source to the `main` branch, `/docs` folder.
3. The page will be live at `https://<you>.github.io/<repo>/`.

The scheduled workflow needs no setup beyond that — it uses the default
`GITHUB_TOKEN`, which already has permission to push to the repo (see
`permissions: contents: write` in the workflow file).

## Running the refresh locally

```bash
npm install
npx playwright install chromium
npm run refresh
```

This overwrites `docs/data.json`. Useful if you ever want fresher data than the
6-hourly schedule, or if the scheduled job starts failing (e.g. Curzon changes their
site) and you want to debug it locally.

## Adjusting the cinema list

`LONDON_SITE_IDS` in `scripts/fetch-showtimes.mjs` is the full set of cinemas the
site fetches data for; the page's cinema picker is just whatever's in that list.
Curzon's full circuit also includes Canterbury, Colchester, Knutsford and Oxford,
excluded here as not "London". Add or remove site IDs there (find them by loading a
`https://www.curzon.com/venues/<name>/` page and checking `vistaCinema.key` in the
embedded page config) and re-run the refresh.
