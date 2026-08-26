# Curzon, but better

A single page that lists films and showtimes across your favourite London Curzon
cinemas for a chosen date — because Curzon's own site only shows one cinema at a time.

Also includes `/thelight`, the same idea for The Light Cinema Sheffield.

Live pages: `docs/index.html` (Curzon, reads `docs/data.json`) and
`docs/thelight/index.html` (The Light Sheffield, reads `docs/thelight/data.json`).

## How it works

### Curzon

Curzon's own showtimes API (`digital-api.curzon.com`) doesn't send CORS headers, so
a page hosted on GitHub Pages can't call it directly from the browser. Instead:

- [`scripts/fetch-showtimes.mjs`](scripts/fetch-showtimes.mjs) runs headless Chromium
  once to load a curzon.com page and pull out the short-lived API token embedded in
  it (curzon.com sits behind a Cloudflare check that blocks plain HTTP requests, so
  this step needs a real browser). It then calls the API directly for the cinema
  list, film details, and showtimes for the next 10 days across the 10 London
  Curzon cinemas, and writes it all to `docs/data.json`.
- `docs/index.html` is a plain static page: date picker, a cinema picker whose
  selection is saved to `localStorage`, and a render of `docs/data.json` grouped by
  cinema → film → times.

### The Light Sheffield

A much simpler site: [`scripts/fetch-thelight.mjs`](scripts/fetch-thelight.mjs) needs
no browser at all. Its "miniguide" data feed
(`sheffield.thelight.co.uk/resource/services/miniguide/data.ashx`) is plain HTTP with
no bot-protection and returns the whole multi-day schedule — title, runtime, and every
session's date/time — in one response; each film's synopsis comes from the
`og:description` meta tag on its own page. There's no deep-linkable booking URL per
showtime (the site opens a JS seat-picker overlay, not a page), so every showtime links
to the film's own booking page instead.

The Light chain has 14 cinemas nationwide (not just Sheffield); this only covers
Sheffield since that's what was asked for, but `scripts/fetch-thelight.mjs` could be
extended to the others the same way Curzon's `LONDON_SITE_IDS` covers multiple sites.

### Shared

- Both scripts use [`scripts/lib/rotten-tomatoes.mjs`](scripts/lib/rotten-tomatoes.mjs)
  for Rotten Tomatoes scores and links, straight from RT's own `/search` page (neither
  site's data has review scores, and there's no free RT API). Unlike OMDb-style
  aggregators, RT's own site has the score the moment RT publishes it — no lag for
  brand-new releases. RT's search is a loose relevance search, not an exact lookup, so
  a result only counts if its own title actually matches the film we searched for;
  anything that doesn't match closely enough is treated as "no RT page found" rather
  than risk showing a wrong film's score. Found scores are cached in the site's
  `data.json` and not re-checked; a film found on RT but without a score yet is
  re-checked every run until it gets one.
- [`.github/workflows/refresh-data.yml`](.github/workflows/refresh-data.yml) runs both
  scripts every 6 hours on GitHub Actions and commits whichever `data.json` file(s)
  changed — so the published pages always read fresh static data with no server of
  their own. The two scrapers run independently: one site changing its layout and
  breaking its scraper doesn't block the other's data from refreshing.

## Hosting on GitHub Pages

1. Push this repo to GitHub.
2. In the repo's Settings → Pages, set the source to the `main` branch, `/docs` folder.
3. The pages will be live at `https://<you>.github.io/<repo>/` and
   `https://<you>.github.io/<repo>/thelight/`.

The scheduled workflow needs no setup beyond that — it uses the default
`GITHUB_TOKEN`, which already has permission to push to the repo (see
`permissions: contents: write` in the workflow file).

## Running the refresh locally

```bash
npm install
npx playwright install chromium
npm run refresh            # Curzon — overwrites docs/data.json
npm run refresh:thelight   # The Light Sheffield — overwrites docs/thelight/data.json
npm run refresh:all        # both
```

Useful if you ever want fresher data than the 6-hourly schedule, or if the scheduled
job starts failing (e.g. a site changes its layout) and you want to debug it locally.

## Adjusting the cinema list

`LONDON_SITE_IDS` in `scripts/fetch-showtimes.mjs` is the full set of Curzon cinemas
the site fetches data for; the page's cinema picker is just whatever's in that list.
Curzon's full circuit also includes Canterbury, Colchester, Knutsford and Oxford,
excluded here as not "London". Add or remove site IDs there (find them by loading a
`https://www.curzon.com/venues/<name>/` page and checking `vistaCinema.key` in the
embedded page config) and re-run the refresh.
