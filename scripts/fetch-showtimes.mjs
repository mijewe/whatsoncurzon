// Scrapes Curzon's own (undocumented) booking API to build a static data.json
// that the site's index.html reads at page-load time.
//
// Why a scrape step at all: Curzon's booking API (digital-api.curzon.com) requires
// a short-lived bearer token that's only ever handed out embedded in the server-
// rendered HTML of a normal curzon.com page, and that page sits behind a Cloudflare
// challenge that blocks plain HTTP requests (curl, node fetch) — only a real/headless
// browser gets through. So we drive a real headless Chromium once to mint a token,
// then make plain HTTPS calls with node's built-in fetch for everything else.
// The API itself also doesn't send CORS headers for cross-origin browser requests,
// so none of this can happen client-side from the published GitHub Pages site either.
import { chromium } from 'playwright';
import { writeFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_PATH = path.join(__dirname, '..', 'docs', 'data.json');
const DESKTOP_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Curated to London-area Curzon cinemas only. Full circuit also includes
// Canterbury (CAN2), Colchester (COL1), Knutsford (KNU1) and Oxford (OXF1),
// deliberately excluded here since they're not relevant to "cinemas in London".
const LONDON_SITE_IDS = [
  'ALD1', // Aldgate
  'BLO1', // Bloomsbury
  'CAM1', // Camden
  'HOX1', // Hoxton
  'KIN1', // Kingston
  'MAY1', // Mayfair
  'RIC1', // Richmond
  'SOH1', // Soho
  'VIC1', // Victoria
  'WIM1', // Wimbledon
];

const DAYS_AHEAD = 10; // Curzon only publishes ~a week of full schedule at a time.
const TOKEN_SOURCE_URL = 'https://www.curzon.com/venues/soho/';

function londonDateString(date) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/London',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

function upcomingLondonDates(count) {
  const todayStr = londonDateString(new Date());
  const anchor = new Date(`${todayStr}T12:00:00Z`); // midday UTC avoids DST-boundary date flips
  return Array.from({ length: count }, (_, i) => {
    const d = new Date(anchor);
    d.setUTCDate(d.getUTCDate() + i);
    return londonDateString(d);
  });
}

async function fetchAuthToken() {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ userAgent: DESKTOP_USER_AGENT });
    const resp = await page.goto(TOKEN_SOURCE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    if (!resp || !resp.ok()) {
      throw new Error(`Failed to load ${TOKEN_SOURCE_URL}: HTTP ${resp && resp.status()}`);
    }
    const html = await page.content();
    const apiUrlMatch = html.match(/"apiUrl":"([^"]+)"/);
    const tokenMatch = html.match(/"authToken":"([^"]+)"/);
    if (!apiUrlMatch || !tokenMatch) {
      throw new Error('Could not find apiUrl/authToken in page HTML — Curzon may have changed their site.');
    }
    return { apiUrl: apiUrlMatch[1], token: tokenMatch[1] };
  } finally {
    await browser.close();
  }
}

async function apiGet(apiUrl, token, urlPath) {
  const res = await fetch(`${apiUrl}${urlPath}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`GET ${urlPath} -> HTTP ${res.status} ${body.slice(0, 300)}`);
  }
  return res.json();
}

function siteIdsQuery(siteIds) {
  return siteIds.map((id) => `siteIds=${encodeURIComponent(id)}`).join('&');
}

// Rotten Tomatoes scores: Curzon's own data has none, and there's no free RT API
// (discontinued years ago). OMDb (a free third-party aggregator) is the usual
// workaround, but for a cinema listing site — mostly brand-new releases — OMDb's
// mirror consistently lags RT's own site by days/weeks, so new films just show
// nothing. RT's own /search page, however, isn't behind any bot-protection and
// server-renders the film's URL directly into the HTML (as a
// <search-page-media-row> custom element) — so we scrape that to find the film,
// then fetch its own page for the Tomatometer (critics) and Popcornmeter
// (audience) scores, both embedded as JSON.
//
// We cache the found url against the previous run's output regardless of
// whether a score was available yet, so a film with no score *yet* skips
// straight to re-fetching its already-known page next run rather than
// re-running the (fuzzier, riskier) search again.
async function loadPreviousRottenTomatoes() {
  try {
    const previous = JSON.parse(await readFile(OUT_PATH, 'utf8'));
    const entries = {};
    for (const [filmId, film] of Object.entries(previous.films || {})) {
      if (film.rottenTomatoes) entries[filmId] = film.rottenTomatoes;
    }
    return entries;
  } catch {
    return {};
  }
}

// Curzon prefixes repertory/season screenings with a strand name ("Curzon Film 50:
// Parasite", "EXHIBITION ON SCREEN: Monet"). The real film title is what follows.
const STRAND_PREFIXES = [
  'Curzon Film 50',
  'DocHouse',
  'EXHIBITION ON SCREEN',
  'National Theatre Live',
  'Kids Club',
  'Ukrainian Film Fest',
  'Sudanese Cinema',
];

function parseFilmQueryTitle(title) {
  const match = title.match(/^([^:]+):\s*(.+)$/);
  if (match && STRAND_PREFIXES.includes(match[1].trim())) {
    // Curzon's releaseDate here is the re-release screening date, not the
    // original film's year, so don't use it to filter RT's search results.
    return { queryTitle: match[2].trim(), useYearHint: false };
  }
  return { queryTitle: title, useYearHint: true };
}

function extractRottenTomatoesMovieResults(html) {
  const blockMatch = html.match(/<search-page-result[^>]*type="movie"[\s\S]*?<\/search-page-result>/);
  if (!blockMatch) return [];
  const rows = [...blockMatch[0].matchAll(/<search-page-media-row([^>]*)>([\s\S]*?)<\/search-page-media-row>/g)];
  return rows.map(([, attrs, inner]) => {
    const attr = (name) => attrs.match(new RegExp(`${name}="([^"]*)"`))?.[1] ?? null;
    const hrefMatch = inner.match(/href="(https:\/\/www\.rottentomatoes\.com\/m\/[^"]+)"/);
    const titleMatch = inner.match(/data-qa="info-name"[^>]*>\s*([^<]+?)\s*</);
    return {
      title: titleMatch ? titleMatch[1].trim() : null,
      releaseYear: attr('release-year'),
      url: hrefMatch ? hrefMatch[1] : null,
    };
  });
}

function normalizeTitle(title) {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// Curzon sometimes appends a cosmetic qualifier Rotten Tomatoes won't have in
// its title, e.g. "The Sacrifice (4K Restoration)" or "Plane Film + Q&A".
function stripQualifierSuffix(title) {
  return title.replace(/\s*[(+].*$/, '').trim();
}

// RT's search is a loose, Google-style relevance search, not an exact-title
// lookup — for anything obscure (shorts, arthouse, foreign titles under a
// different English name) its top "movie" hit is often a wrong film that just
// shares a word or phrase ("Planet Israel" -> "Kingdom of the Planet of the
// Apes", "Gaza's Twins, Come Back to Me" -> "Come Back to Me"). A same-or-
// prefix substring check lets through exactly that kind of false positive, so
// this requires an exact match (after stripping the qualifier suffix above).
function titleReasonablyMatches(resultTitle, queryTitle) {
  if (!resultTitle) return false;
  return normalizeTitle(resultTitle) === normalizeTitle(stripQualifierSuffix(queryTitle));
}

async function findRottenTomatoesUrl(title, expectedYear) {
  const res = await fetch(`https://www.rottentomatoes.com/search?search=${encodeURIComponent(title)}`, {
    headers: { 'User-Agent': DESKTOP_USER_AGENT },
  });
  if (!res.ok) return null;
  const results = extractRottenTomatoesMovieResults(await res.text()).filter((r) =>
    titleReasonablyMatches(r.title, title)
  );
  if (results.length === 0) return null;
  const best = (expectedYear && results.find((r) => r.releaseYear === String(expectedYear))) || results[0];
  return best.url ? { url: best.url, releaseYear: best.releaseYear ? Number(best.releaseYear) : null } : null;
}

// The Tomatometer (critics) and Popcornmeter (audience) scores aren't on the
// search page — only on the film's own page, each embedded as a flat JSON
// object like `"criticsScore":{...,"score":"90",...}`.
function extractScoreFromPage(html, key) {
  const blockMatch = html.match(new RegExp(`"${key}":\\{[^}]*\\}`));
  if (!blockMatch) return null;
  const scoreMatch = blockMatch[0].match(/"score":"(\d+)"/);
  return scoreMatch ? Number(scoreMatch[1]) : null;
}

async function fetchRottenTomatoesScores(url) {
  const res = await fetch(url, { headers: { 'User-Agent': DESKTOP_USER_AGENT } });
  if (!res.ok) return { criticsScore: null, audienceScore: null };
  const html = await res.text();
  return {
    criticsScore: extractScoreFromPage(html, 'criticsScore'),
    audienceScore: extractScoreFromPage(html, 'audienceScore'),
  };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  console.log('Fetching auth token via headless browser...');
  const { apiUrl, token } = await fetchAuthToken();
  console.log('Got token, length', token.length);

  console.log('Fetching site list...');
  const sitesResp = await apiGet(apiUrl, token, '/ocapi/v1/sites');
  const sites = sitesResp.sites
    .filter((s) => LONDON_SITE_IDS.includes(s.id))
    .map((s) => ({
      id: s.id,
      name: s.name.text,
      address: [s.contactDetails.address.line1, s.contactDetails.address.line2, s.contactDetails.address.city]
        .filter(Boolean)
        .join(' '),
      latitude: s.location.latitude,
      longitude: s.location.longitude,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const missing = LONDON_SITE_IDS.filter((id) => !sites.some((s) => s.id === id));
  if (missing.length) {
    throw new Error(`Expected site IDs not found in API response: ${missing.join(', ')}`);
  }

  console.log('Fetching film metadata for each site...');
  const films = {};
  const releaseYearsByFilmId = {};
  for (const site of sites) {
    const filmsResp = await apiGet(apiUrl, token, `/ocapi/v1/sites/${site.id}/films`);
    for (const f of filmsResp.films) {
      if (films[f.id]) continue;
      films[f.id] = {
        title: f.title.text,
        description: (f.shortSynopsis && f.shortSynopsis.text) || (f.synopsis && f.synopsis.text) || '',
        runtimeMinutes: f.runtimeInMinutes ?? null,
      };
      if (f.releaseDate) releaseYearsByFilmId[f.id] = f.releaseDate.slice(0, 4);
    }
  }

  console.log('Fetching Rotten Tomatoes scores/links...');
  const previousRottenTomatoes = await loadPreviousRottenTomatoes();
  for (const [filmId, film] of Object.entries(films)) {
    const { queryTitle, useYearHint } = parseFilmQueryTitle(film.title);
    // Curzon's own releaseDate is reliable for current releases, but reflects
    // the *re-release* screening date for strand-prefixed classics — so it's
    // only trustworthy as a release-year fallback when useYearHint is true.
    const curzonYearHint = releaseYearsByFilmId[filmId] ? Number(releaseYearsByFilmId[filmId]) : null;

    const cached = previousRottenTomatoes[filmId];
    if (cached && cached.criticsScore != null) {
      film.rottenTomatoes = cached;
      film.releaseYear = cached.releaseYear ?? (useYearHint ? curzonYearHint : null);
      continue;
    }

    let url = cached && cached.url;
    let releaseYear = cached && cached.releaseYear;
    if (!url) {
      const found = await findRottenTomatoesUrl(queryTitle, useYearHint ? curzonYearHint : null);
      url = found && found.url;
      releaseYear = found && found.releaseYear;
      await delay(250);
    }

    if (!url) {
      film.rottenTomatoes = null;
      film.releaseYear = useYearHint ? curzonYearHint : null;
      console.log(`  ${film.title}: not found`);
      continue;
    }

    const scores = await fetchRottenTomatoesScores(url);
    film.rottenTomatoes = { url, releaseYear, ...scores };
    film.releaseYear = releaseYear ?? (useYearHint ? curzonYearHint : null);
    console.log(
      `  ${film.title}: ${film.releaseYear ?? '?'} critics ${scores.criticsScore ?? '?'}% / audience ${scores.audienceScore ?? '?'}% ${url}`
    );
    await delay(250);
  }

  console.log(`Fetching showtimes for ${DAYS_AHEAD} days across ${sites.length} sites...`);
  const days = upcomingLondonDates(DAYS_AHEAD);
  const siteIds = sites.map((s) => s.id);
  const showtimesByDate = {};
  for (const date of days) {
    const resp = await apiGet(apiUrl, token, `/ocapi/v1/showtimes/by-business-date/${date}?${siteIdsQuery(siteIds)}`);
    const bySite = {};
    for (const st of resp.showtimes) {
      if (!bySite[st.siteId]) bySite[st.siteId] = [];
      bySite[st.siteId].push({
        id: st.id,
        filmId: st.filmId,
        // schedule.startsAt is the advertised showtime (what Curzon shows customers,
        // includes trailers/ads); schedule.filmStartsAt is when the film itself
        // actually starts, ~20-25min later. We want the former.
        startsAt: st.schedule.startsAt,
        endsAt: st.schedule.endsAt,
        isSoldOut: Boolean(st.isSoldOut),
      });
    }
    for (const list of Object.values(bySite)) {
      list.sort((a, b) => a.startsAt.localeCompare(b.startsAt));
    }
    showtimesByDate[date] = bySite;
    console.log(`  ${date}: ${resp.showtimes.length} showtimes`);
  }

  const output = {
    generatedAt: new Date().toISOString(),
    days,
    sites,
    films,
    showtimesByDate,
  };

  await mkdir(path.dirname(OUT_PATH), { recursive: true });
  await writeFile(OUT_PATH, JSON.stringify(output));
  console.log(`Wrote ${OUT_PATH}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
