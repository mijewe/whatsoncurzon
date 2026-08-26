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
import { DESKTOP_USER_AGENT, lookupRottenTomatoes } from './lib/rotten-tomatoes.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_PATH = path.join(__dirname, '..', 'docs', 'data.json');

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

// The date we first ever saw a given film in our own scrape history — a
// definitive "new to the cinema" signal for the site's "coming up this week"
// feature, as opposed to guessing from how many days it happens to be
// scheduled on. Persisted indefinitely once set, same pattern as the RT
// cache above. A film we've genuinely never seen before gets today's date.
async function loadPreviousFirstSeen() {
  try {
    const previous = JSON.parse(await readFile(OUT_PATH, 'utf8'));
    const entries = {};
    for (const [filmId, film] of Object.entries(previous.films || {})) {
      if (film.firstSeen) entries[filmId] = film.firstSeen;
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
  const previousFirstSeen = await loadPreviousFirstSeen();
  const scrapedTodayStr = londonDateString(new Date());
  const films = {};
  const releaseYearsByFilmId = {};
  const censorRatingIdByFilmId = {};
  const censorRatingsById = {};
  for (const site of sites) {
    const filmsResp = await apiGet(apiUrl, token, `/ocapi/v1/sites/${site.id}/films`);
    for (const rating of (filmsResp.relatedData && filmsResp.relatedData.censorRatings) || []) {
      censorRatingsById[rating.id] = rating.classification.text;
    }
    for (const f of filmsResp.films) {
      if (films[f.id]) continue;
      films[f.id] = {
        title: f.title.text,
        description: (f.shortSynopsis && f.shortSynopsis.text) || (f.synopsis && f.synopsis.text) || '',
        runtimeMinutes: f.runtimeInMinutes ?? null,
        firstSeen: previousFirstSeen[f.id] || scrapedTodayStr,
      };
      if (f.releaseDate) releaseYearsByFilmId[f.id] = f.releaseDate.slice(0, 4);
      if (f.censorRatingId) censorRatingIdByFilmId[f.id] = f.censorRatingId;
    }
  }
  // BBFC age rating (e.g. "12A", "15") — Curzon's API returns it as a
  // censorRatingId per film, resolved against a ratings table returned
  // alongside the film list (both already fetched above, no extra requests).
  for (const [filmId, film] of Object.entries(films)) {
    const ratingId = censorRatingIdByFilmId[filmId];
    film.ageRating = ratingId ? censorRatingsById[ratingId] || null : null;
  }

  console.log('Fetching Rotten Tomatoes scores/links...');
  const previousRottenTomatoes = await loadPreviousRottenTomatoes();
  for (const [filmId, film] of Object.entries(films)) {
    const { queryTitle, useYearHint } = parseFilmQueryTitle(film.title);
    // Curzon's own releaseDate is reliable for current releases, but reflects
    // the *re-release* screening date for strand-prefixed classics — so it's
    // only trustworthy as a release-year fallback when useYearHint is true.
    const curzonYearHint = releaseYearsByFilmId[filmId] ? Number(releaseYearsByFilmId[filmId]) : null;

    const { rottenTomatoes, releaseYear } = await lookupRottenTomatoes(
      queryTitle,
      useYearHint ? curzonYearHint : null,
      previousRottenTomatoes[filmId]
    );
    film.rottenTomatoes = rottenTomatoes;
    film.releaseYear = releaseYear;
    console.log(
      rottenTomatoes
        ? `  ${film.title}: ${releaseYear ?? '?'} critics ${rottenTomatoes.criticsScore ?? '?'}% / audience ${rottenTomatoes.audienceScore ?? '?'}% ${rottenTomatoes.url}`
        : `  ${film.title}: not found`
    );
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
