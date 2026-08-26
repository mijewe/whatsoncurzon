// Scrapes The Light Cinema Sheffield's own "miniguide" data feed to build a
// static data.json for docs/thelight/index.html — same idea as
// fetch-showtimes.mjs, but for a completely different site/booking system.
//
// Unlike Curzon, none of this needs a headless browser: the miniguide
// endpoint and the film pages are all plain HTTP with no bot-protection, and
// the whole multi-day schedule comes back in one response.
import { writeFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DESKTOP_USER_AGENT, decodeHtmlEntities, lookupRottenTomatoes } from './lib/rotten-tomatoes.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_PATH = path.join(__dirname, '..', 'docs', 'thelight', 'data.json');

const BASE_URL = 'https://sheffield.thelight.co.uk';
const MINIGUIDE_URL = `${BASE_URL}/resource/services/miniguide/data.ashx`;
const VENUE = {
  name: 'Sheffield',
  address: 'The Moor, Sheffield, S1 4PF',
};
const ADVERTS_MINUTES = 20; // pre-show trailers/ads, since the feed has no true end time

async function fetchText(url) {
  const res = await fetch(url, { headers: { 'User-Agent': DESKTOP_USER_AGENT } });
  if (!res.ok) throw new Error(`GET ${url} -> HTTP ${res.status}`);
  return res.text();
}

// The endpoint returns `'use strict';\nvar __gfminiguidedata = {...};\nif(...)`,
// not bare JSON.
function parseMiniguide(text) {
  const match = text.match(/__gfminiguidedata\s*=\s*(\{.*\});\s*\nif\(window\.gfdx\)/s);
  if (!match) throw new Error('Could not find __gfminiguidedata in response — The Light may have changed their site.');
  return JSON.parse(match[1]);
}

function parseRuntimeToMinutes(text) {
  if (!text) return null;
  const h = text.match(/(\d+)h/);
  const m = text.match(/(\d+)m/);
  if (!h && !m) return null;
  return (h ? Number(h[1]) * 60 : 0) + (m ? Number(m[1]) : 0);
}

// Sessions carry a date key like "20260826" and a time like "09.30" in local
// (Europe/London) time — build a proper offset-aware ISO string so the
// front-end's existing date parsing works unchanged.
function londonUtcOffset(dateKey) {
  const [y, m, d] = [dateKey.slice(0, 4), dateKey.slice(4, 6), dateKey.slice(6, 8)];
  const noonUtc = new Date(`${y}-${m}-${d}T12:00:00Z`);
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/London', timeZoneName: 'shortOffset' }).formatToParts(
    noonUtc
  );
  const tzName = parts.find((p) => p.type === 'timeZoneName').value; // "GMT" or "GMT+1"
  const hours = Number(tzName.replace('GMT', '') || 0);
  return `${hours >= 0 ? '+' : '-'}${String(Math.abs(hours)).padStart(2, '0')}:00`;
}

function toIso(dateKey, hhmm) {
  const [y, m, d] = [dateKey.slice(0, 4), dateKey.slice(4, 6), dateKey.slice(6, 8)];
  const [hh, mi] = hhmm.split('.');
  return `${y}-${m}-${d}T${hh}:${mi}:00${londonUtcOffset(dateKey)}`;
}

function addMinutesIso(iso, minutes) {
  const d = new Date(iso);
  d.setUTCMinutes(d.getUTCMinutes() + minutes);
  return d.toISOString();
}

function dateKeyToIsoDate(dateKey) {
  return `${dateKey.slice(0, 4)}-${dateKey.slice(4, 6)}-${dateKey.slice(6, 8)}`;
}

async function fetchFilmDescription(relativeUrl) {
  if (!relativeUrl) return '';
  try {
    const html = await fetchText(`${BASE_URL}${relativeUrl}`);
    const match = html.match(/<meta property="og:description" content="([^"]*)"/);
    return match ? decodeHtmlEntities(match[1]) : '';
  } catch {
    return '';
  }
}

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

function londonDateString(date) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/London',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
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

// "Might be leaving soon": the miniguide feed never publishes an end date for
// a film, and "no showtimes further out" on its own is meaningless — The
// Light publishes its schedule consistently ~12-14 days ahead for every film,
// continuing or not, so the only real signal is a *trend*. Track the furthest
// date we've ever seen each film scheduled on (maxScheduledDate, persisted
// and monotonically non-decreasing, like a high-water mark) and when we first
// saw it at that value (maxScheduledDateFirstSeenAt). A continuing film's
// mark keeps creeping forward as the window rolls; a film that's actually
// ending stops getting rebooked, so its mark stays fixed while "today" keeps
// advancing toward it. Flagged only once that gap has shrunk to
// LEAVING_SOON_DAYS_LEFT AND the mark has been stuck for at least
// LEAVING_SOON_MIN_STUCK_DAYS — thresholds set higher than Curzon's since The
// Light's longer, steadier publishing window makes a stuck mark a stronger
// (but slower-to-confirm) signal. The grace period exists so this doesn't
// fire off a single day's data blip.
//
// One-off screenings (a single anniversary/special showing, e.g. "Trainspotting
// (30th Anniversary)") would otherwise get misread as "leaving soon" the moment
// they appear, since their one and only date is always imminent. They need no
// trend at all to detect — a film that has *never*, in any scrape, been
// scheduled on more than one date is structurally a one-off, not a shrinking
// run, so it's tracked with the same high-water-mark pattern (maxScheduledDatesCount)
// and reported as its own tag instead of feeding into the leaving-soon trend.
const LEAVING_SOON_DAYS_LEFT = 5;
const LEAVING_SOON_MIN_STUCK_DAYS = 3;

function daysBetween(aIso, bIso) {
  return Math.round((new Date(`${bIso}T00:00:00Z`) - new Date(`${aIso}T00:00:00Z`)) / 86400000);
}

async function loadPreviousLeavingSoonTracking() {
  try {
    const previous = JSON.parse(await readFile(OUT_PATH, 'utf8'));
    const entries = {};
    for (const [filmId, film] of Object.entries(previous.films || {})) {
      if (film.maxScheduledDate) {
        entries[filmId] = {
          maxScheduledDate: film.maxScheduledDate,
          maxScheduledDateFirstSeenAt: film.maxScheduledDateFirstSeenAt,
          maxScheduledDatesCount: film.maxScheduledDatesCount || 1,
        };
      }
    }
    return entries;
  } catch {
    return {};
  }
}

async function main() {
  console.log('Fetching miniguide data...');
  const data = parseMiniguide(await fetchText(MINIGUIDE_URL));
  console.log(`Got ${data.Schedule.length} films/events.`);

  const previousRottenTomatoes = await loadPreviousRottenTomatoes();
  const previousFirstSeen = await loadPreviousFirstSeen();
  const previousLeavingSoonTracking = await loadPreviousLeavingSoonTracking();
  const scrapedTodayStr = londonDateString(new Date());

  const films = {};
  const showtimesByDate = {};
  const daysSet = new Set();

  for (const item of data.Schedule) {
    const filmId = item.MovieId || String(item.ID);

    if (!films[filmId]) {
      const title = decodeHtmlEntities(item.Title);
      console.log(`Fetching description for ${title}...`);
      const description = await fetchFilmDescription(item.Url);
      const runtimeMinutes = parseRuntimeToMinutes(item.Runtime);

      const { rottenTomatoes, releaseYear } = await lookupRottenTomatoes(title, null, previousRottenTomatoes[filmId]);
      console.log(
        rottenTomatoes
          ? `  RT: ${releaseYear ?? '?'} critics ${rottenTomatoes.criticsScore ?? '?'}% / audience ${rottenTomatoes.audienceScore ?? '?'}% ${rottenTomatoes.url}`
          : '  RT: not found'
      );

      films[filmId] = {
        title,
        description,
        runtimeMinutes,
        url: item.Url ? `${BASE_URL}${item.Url}` : null,
        rottenTomatoes,
        releaseYear,
        ageRating: item.Cert || null,
        firstSeen: previousFirstSeen[filmId] || scrapedTodayStr,
      };
    }

    const film = films[filmId];
    for (const dateEntry of item.Dates) {
      const isoDate = dateKeyToIsoDate(dateEntry.Key);
      daysSet.add(isoDate);
      if (!showtimesByDate[isoDate]) showtimesByDate[isoDate] = [];
      for (const session of dateEntry.Sessions) {
        const startsAt = toIso(dateEntry.Key, session.Display);
        // The miniguide feed has no actual end time (checked: sessions only
        // ever carry BOID/Display/Format, nothing end-time-shaped) — the
        // displayed start is the advertised (pre-trailers) time, same as
        // Curzon's, so estimate the end as start + ~20min of adverts/trailers
        // + the film's own runtime.
        const endsAt =
          film.runtimeMinutes != null ? addMinutesIso(startsAt, film.runtimeMinutes + ADVERTS_MINUTES) : startsAt;
        showtimesByDate[isoDate].push({
          id: session.BOID,
          filmId,
          startsAt,
          endsAt,
          format: session.FormatDisplay || null,
        });
      }
    }
  }

  for (const list of Object.values(showtimesByDate)) {
    list.sort((a, b) => a.startsAt.localeCompare(b.startsAt));
  }

  console.log('Updating leaving-soon tracking...');
  const observedMaxByFilmId = {};
  const observedDatesByFilmId = {};
  for (const [isoDate, list] of Object.entries(showtimesByDate)) {
    for (const st of list) {
      if (!observedMaxByFilmId[st.filmId] || isoDate > observedMaxByFilmId[st.filmId]) {
        observedMaxByFilmId[st.filmId] = isoDate;
      }
      if (!observedDatesByFilmId[st.filmId]) observedDatesByFilmId[st.filmId] = new Set();
      observedDatesByFilmId[st.filmId].add(isoDate);
    }
  }
  for (const [filmId, film] of Object.entries(films)) {
    const observedMax = observedMaxByFilmId[filmId];
    if (!observedMax) continue;
    const previous = previousLeavingSoonTracking[filmId];
    if (previous && previous.maxScheduledDate >= observedMax) {
      film.maxScheduledDate = previous.maxScheduledDate;
      film.maxScheduledDateFirstSeenAt = previous.maxScheduledDateFirstSeenAt;
    } else {
      film.maxScheduledDate = observedMax;
      film.maxScheduledDateFirstSeenAt = scrapedTodayStr;
    }

    const observedDatesCount = observedDatesByFilmId[filmId].size;
    film.maxScheduledDatesCount = Math.max(observedDatesCount, previous ? previous.maxScheduledDatesCount : 1);
    film.oneOffScreening = film.maxScheduledDatesCount <= 1;

    const daysLeft = daysBetween(scrapedTodayStr, film.maxScheduledDate);
    const daysStuck = daysBetween(film.maxScheduledDateFirstSeenAt, scrapedTodayStr);
    const showsToday = Boolean(showtimesByDate[scrapedTodayStr]?.some((st) => st.filmId === filmId));
    film.leavingSoon =
      !film.oneOffScreening &&
      showsToday &&
      daysLeft >= 0 &&
      daysLeft <= LEAVING_SOON_DAYS_LEFT &&
      daysStuck >= LEAVING_SOON_MIN_STUCK_DAYS;
  }

  const output = {
    generatedAt: new Date().toISOString(),
    days: [...daysSet].sort(),
    venue: VENUE,
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
