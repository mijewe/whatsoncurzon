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

async function main() {
  console.log('Fetching miniguide data...');
  const data = parseMiniguide(await fetchText(MINIGUIDE_URL));
  console.log(`Got ${data.Schedule.length} films/events.`);

  const previousRottenTomatoes = await loadPreviousRottenTomatoes();

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
