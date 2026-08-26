// Rotten Tomatoes scores/links, shared by every per-cinema scraper.
//
// There's no free RT API (discontinued years ago), and OMDb (the usual free
// workaround) consistently lags RT's own site by days/weeks for brand-new
// releases — exactly what a cinema listing is mostly showing. RT's own
// /search page, however, isn't behind any bot-protection and server-renders
// the film's URL directly into the HTML (as a <search-page-media-row> custom
// element), so we scrape that to find the film, then fetch its own page for
// the Tomatometer (critics) and Popcornmeter (audience) scores, both
// embedded as JSON.
export const DESKTOP_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

export function decodeHtmlEntities(text) {
  return text
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(code))
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function normalizeTitle(title) {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// Cinemas sometimes append a cosmetic qualifier RT won't have in its title,
// e.g. "The Sacrifice (4K Restoration)" or "Plane Film + Q&A".
function stripQualifierSuffix(title) {
  return title.replace(/\s*[(+].*$/, '').trim();
}

// RT's search is a loose, Google-style relevance search, not an exact-title
// lookup — for anything obscure (shorts, arthouse, foreign titles under a
// different English name) its top "movie" hit is often a wrong film that just
// shares a word or phrase ("Planet Israel" -> "Kingdom of the Planet of the
// Apes", "Gaza's Twins, Come Back to Me" -> "Come Back to Me"). So this
// requires an exact match (after stripping the qualifier suffix above).
function titleReasonablyMatches(resultTitle, queryTitle) {
  if (!resultTitle) return false;
  return normalizeTitle(resultTitle) === normalizeTitle(stripQualifierSuffix(queryTitle));
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
      title: titleMatch ? decodeHtmlEntities(titleMatch[1].trim()) : null,
      releaseYear: attr('release-year'),
      url: hrefMatch ? hrefMatch[1] : null,
    };
  });
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

// Looks up a film's RT score/link, reusing a cached result from a previous
// run when possible: a found score is cached indefinitely (against `cached`,
// the previous run's rottenTomatoes value for this film); a known url with no
// score *yet* skips straight to re-fetching that page rather than re-running
// the (fuzzier, riskier) search; nothing cached means a full search.
//
// `title`/`yearHint` are whatever the caller has already cleaned up (e.g.
// with a chain-specific strand-prefix strip) — this module has no opinion on
// that. Returns { rottenTomatoes, releaseYear }.
export async function lookupRottenTomatoes(title, yearHint, cached) {
  if (cached && cached.criticsScore != null) {
    return { rottenTomatoes: cached, releaseYear: cached.releaseYear ?? yearHint ?? null };
  }

  let url = cached && cached.url;
  let releaseYear = cached && cached.releaseYear;
  if (!url) {
    const found = await findRottenTomatoesUrl(title, yearHint);
    url = found && found.url;
    releaseYear = found && found.releaseYear;
    await delay(250);
  }

  if (!url) {
    return { rottenTomatoes: null, releaseYear: yearHint ?? null };
  }

  const scores = await fetchRottenTomatoesScores(url);
  const rottenTomatoes = { url, releaseYear, ...scores };
  await delay(250);
  return { rottenTomatoes, releaseYear: releaseYear ?? yearHint ?? null };
}
