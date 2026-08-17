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
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
    const page = await browser.newPage({
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    });
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
  for (const site of sites) {
    const filmsResp = await apiGet(apiUrl, token, `/ocapi/v1/sites/${site.id}/films`);
    for (const f of filmsResp.films) {
      if (films[f.id]) continue;
      films[f.id] = {
        title: f.title.text,
        description: (f.shortSynopsis && f.shortSynopsis.text) || (f.synopsis && f.synopsis.text) || '',
        runtimeMinutes: f.runtimeInMinutes ?? null,
      };
    }
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
