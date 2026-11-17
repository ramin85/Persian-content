/**
 * Namakade (Negahestan) Movies & Series — Stremio-protocol addon (works with Nuvio)
 *
 * Zero dependencies, Node 18+.   node server.js  ->  http://localhost:7000/manifest.json
 *
 * It scrapes the public namakade.com pages: category lists -> a catalog index,
 * detail pages -> metadata + the direct .mp4 link, series pages -> episodes.
 *
 * Env vars (all optional):
 *   PORT          7000
 *   BASE_URL      https://namakade.com
 *   MOVIES_HOME   https://mobile.namakade.com/movies   (page used to discover movie categories)
 *   SERIES_HOME   https://namakade.com/best-serial     (page used to discover series categories)
 *   MAX_PAGES     30    max "?page=N" pages tried per category (stops as soon as no new titles appear)
 *   REFRESH_MIN   360   minutes between catalog re-crawls
 */
const http = require("http");

const PORT = Number(process.env.PORT || 7000);
const BASE = (process.env.BASE_URL || "https://namakade.com").replace(/\/+$/, "");
const MOVIES_HOME = process.env.MOVIES_HOME || "https://mobile.namakade.com/movies";
const SERIES_HOME = process.env.SERIES_HOME || BASE + "/best-serial";
const MAX_PAGES = Number(process.env.MAX_PAGES || 30);
const REFRESH_MS = Number(process.env.REFRESH_MIN || 360) * 60 * 1000;
const PAGE_SIZE = 100;
const UA =
  "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36";

// ------------------------------------------------------------------ helpers
const b64 = (s) => Buffer.from(s).toString("base64url");
const unb64 = (s) => Buffer.from(s, "base64url").toString();
const dec = (s) =>
  (s || "")
    .replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#0?39;/g, "'")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n));
const strip = (h) => dec(h.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
const titleCase = (s) => s.replace(/[-_+]+/g, " ").replace(/\s+/g, " ").trim().toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
const pathOf = (href) => { try { return new URL(dec(href), "https://namakade.com/").pathname; } catch { return ""; } };
const abs = (u) => { try { return new URL(dec(u), BASE + "/").href.replace(/^http:\/\/media\./, "https://media."); } catch { return ""; } };

async function get(url, method = "GET") {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 20000);
  try {
    const r = await fetch(url, {
      method,
      headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml,*/*" },
      signal: ctl.signal,
      redirect: "follow",
    });
    if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
    if (method === "HEAD") return "";
    return await r.text();
  } finally {
    clearTimeout(t);
  }
}

async function pool(items, n, fn) {
  const q = [...items];
  await Promise.all(Array.from({ length: n }, async () => { while (q.length) { const x = q.shift(); try { await fn(x); } catch (e) { log("warn", e.message); } } }));
}

const logs = [];
function log(level, msg) {
  console.log(`[${level}] ${msg}`);
  logs.push(`${new Date().toISOString()} ${level} ${msg}`);
  if (logs.length > 60) logs.shift();
}

// ------------------------------------------------------------ HTML scraping
const MOVIE_RE = /^\/iran-1-movies\/([^/]+)\/([^/?#]+)\/?$/i;
const SERIES_RE = /^\/series\/([^/?#]+)\/?$/i;
const EP_RE = /^\/series\/([^/]+)\/episodes\/([^/?#]+)\/?$/i;

function posterFromFile(url) {
  const m = (url || "").match(/\/([^/?#]+?)(?:_(?:small|big)?thumb)?\.(?:jpe?g|png|webp)(?:\?.*)?$/i);
  return m ? m[1].replace(/_/g, " ").trim() : "";
}

function cleanTitle(text) {
  return text.replace(/\s+(Director|Genre|Views|Watch Now)\b.*$/i, "").replace(/^Watch Now$/i, "").trim();
}

/** Pull movie or series cards out of a listing page. */
function extractItems(html, kind) {
  const imgs = [];
  let m;
  const ire = /<img\b[^>]*>/gi;
  while ((m = ire.exec(html))) {
    const tag = m[0];
    const src = (tag.match(/\bdata-src\s*=\s*["']([^"']+)["']/i) || tag.match(/\bdata-original\s*=\s*["']([^"']+)["']/i) || tag.match(/\bsrc\s*=\s*["']([^"']+)["']/i) || [])[1];
    if (!src || !/\.(jpe?g|png|webp)/i.test(src)) continue;
    imgs.push({ i: m.index, src: abs(src), alt: dec((tag.match(/\balt\s*=\s*["']([^"']*)["']/i) || [])[1] || "") });
  }

  const out = new Map();
  const are = /<a\b[^>]*?\bhref\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let prevEnd = 0;
  while ((m = are.exec(html))) {
    const p = pathOf(m[1]);
    const mm = kind === "movie" ? p.match(MOVIE_RE) : p.match(SERIES_RE);
    if (!mm || (kind === "series" && /^(category|episodes)$/i.test(mm[1]))) continue;
    const start = m.index, end = start + m[0].length;
    const innerImg = imgs.find((x) => x.i >= start && x.i <= end);
    const before = [...imgs].reverse().find((x) => x.i < start && x.i >= prevEnd);
    const after = imgs.find((x) => x.i >= end && x.i < end + 600);
    const img = innerImg || before || after;
    prevEnd = end;

    const text = cleanTitle(strip(m[2]));
    const prev = out.get(p);
    const item = prev || { kind, path: p, title: "", poster: "", genres: [], director: "" };
    if (!item.poster && img) item.poster = img.src;
    const dir = strip(m[2]).match(/Director:\s*(.+?)(?:\s+Genre:|\s+Watch Now|$)/i);
    if (dir && !item.director) item.director = dir[1].trim();
    const cand = text || (img && img.alt) || "";
    if (cand && cand.length > item.title.length) item.title = cand;
    if (kind === "movie") item.genres = mm[1].split("-").filter(Boolean).map(titleCase);
    out.set(p, item);
  }
  for (const it of out.values()) {
    if (!it.title) it.title = posterFromFile(it.poster) || titleCase(decodeURIComponent(it.path.split("/").pop()));
  }
  return [...out.values()];
}

function findLinks(html, re) {
  const set = new Set();
  const are = /<a\b[^>]*?\bhref\s*=\s*["']([^"']+)["']/gi;
  let m;
  while ((m = are.exec(html))) { const p = pathOf(m[1]); const mm = p.match(re); if (mm) set.add(p); }
  return [...set];
}

function findVideoUrls(html) {
  const urls = new Set();
  const re = /(?:https?:)?\/\/[^"'\s<>\\)]+?\.(?:mp4|m3u8)(?:\?[^"'\s<>\\)]*)?|["'](\/[^"'\s<>\\]+?\.(?:mp4|m3u8)(?:\?[^"'\s<>\\]*)?)["']/gi;
  let m;
  while ((m = re.exec(html))) {
    const u = abs(m[1] || m[0]);
    if (u && !/thumb/i.test(u)) urls.add(u);
  }
  return [...urls];
}

function pageTitle(html) {
  const og = (html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i) || [])[1];
  const t = og || (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || "";
  return dec(t).replace(/\s*[|\-–]\s*(Negahestan|Namakade).*$/i, "").replace(/\s+/g, " ").trim();
}

function pagePoster(html) {
  const og = (html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i) || [])[1];
  if (og) return abs(og);
  const big = (html.match(/["']([^"']+_bigthumb\.(?:jpe?g|png|webp))["']/i) || [])[1];
  return big ? abs(big) : "";
}

function pageDescription(html, title) {
  const d = dec((html.match(/<meta[^>]+(?:name|property)=["'](?:og:)?description["'][^>]+content=["']([^"']*)["']/i) || [])[1] || "").trim();
  return d && !/negahestan\.com\s*$/i.test(d) && d.toLowerCase() !== title.toLowerCase() ? d : "";
}

// -------------------------------------------------------------- the index
const index = { movies: [], series: [], movieGenres: [], seriesGenres: [], ready: false, at: 0 };
let crawling = null;

async function crawlList(startPath, kind, genre, into) {
  const seen = new Set();
  for (let page = 1; page <= MAX_PAGES; page++) {
    const url = BASE + startPath + (page > 1 ? (startPath.includes("?") ? "&" : "?") + "page=" + page : "");
    let html;
    try { html = await get(url); } catch (e) { if (page === 1) throw e; break; }
    const items = extractItems(html, kind);
    let fresh = 0;
    for (const it of items) {
      if (!seen.has(it.path)) { seen.add(it.path); fresh++; }
      merge(into, it, genre);
    }
    if (!fresh) break;
  }
}

function merge(map, it, genre) {
  const cur = map.get(it.path);
  if (!cur) { map.set(it.path, { ...it, genres: [...new Set([...(it.genres || []), ...(genre ? [genre] : [])])] }); return; }
  if (!cur.poster && it.poster) cur.poster = it.poster;
  if (it.title.length > cur.title.length) cur.title = it.title;
  for (const g of [...(it.genres || []), ...(genre ? [genre] : [])]) if (!cur.genres.includes(g)) cur.genres.push(g);
}

async function crawlAll() {
  const t0 = Date.now();
  const movies = new Map(), series = new Map();
  try {
    // Movies: home page + every category it links to
    const mh = await get(MOVIES_HOME);
    for (const it of extractItems(mh, "movie")) merge(movies, it);
    const mcats = findLinks(mh, /^\/iran-1-movies\/[^/?#]+\/?$/i);
    log("info", `movie categories: ${mcats.length}`);
    await pool(mcats, 4, (p) => crawlList(p, "movie", titleCase(decodeURIComponent(p.split("/").filter(Boolean).pop())), movies));
  } catch (e) { log("error", "movies crawl: " + e.message); }
  try {
    // Series: home page + every category it links to
    const sh = await get(SERIES_HOME);
    for (const it of extractItems(sh, "series")) merge(series, it);
    const scats = findLinks(sh, /^\/series\/category\/[^/?#]+\/?$/i);
    log("info", `series categories: ${scats.length}`);
    await pool(scats, 4, (p) => crawlList(p, "series", titleCase(decodeURIComponent(p.split("/").filter(Boolean).pop())), series));
  } catch (e) { log("error", "series crawl: " + e.message); }

  if (movies.size || series.size) {
    index.movies = [...movies.values()].map((x) => ({ ...x, id: "nk_m_" + b64(x.path) }));
    index.series = [...series.values()].map((x) => ({ ...x, id: "nk_s_" + b64(x.path) }));
    index.movieGenres = [...new Set(index.movies.flatMap((x) => x.genres))].sort();
    index.seriesGenres = [...new Set(index.series.flatMap((x) => x.genres))].sort();
    index.ready = true;
    index.at = Date.now();
  }
  log("info", `crawl done in ${((Date.now() - t0) / 1000).toFixed(1)}s: ${movies.size} movies, ${series.size} series`);
}

function startCrawl() {
  if (!crawling) crawling = crawlAll().finally(() => (crawling = null));
  return crawling;
}
async function ensureIndex() {
  if (!index.ready) {
    await Promise.race([startCrawl(), new Promise((r) => setTimeout(r, 25000))]);
  } else if (Date.now() - index.at > REFRESH_MS) startCrawl();
}

// -------------------------------------------------------- detail resolvers
const cache = new Map(); // key -> {v, t}
async function cached(key, ttl, fn) {
  const c = cache.get(key);
  if (c && Date.now() - c.t < ttl) return c.v;
  const v = await fn();
  cache.set(key, { v, t: Date.now() });
  if (cache.size > 800) cache.delete(cache.keys().next().value);
  return v;
}

async function movieDetail(path) {
  return cached("m:" + path, 3600e3, async () => {
    const html = await get(BASE + path);
    const title = pageTitle(html);
    return { title, poster: pagePoster(html), description: pageDescription(html, title), videos: findVideoUrls(html) };
  });
}

async function seriesDetail(path) {
  return cached("s:" + path, 3600e3, async () => {
    const html = await get(BASE + path);
    const title = pageTitle(html).replace(/\s+\d+$/, "");
    // Walk season markers and episode links in document order
    const toks = [];
    let m;
    const sre = /SEASON\s*:?\s*(\d+)/gi;
    while ((m = sre.exec(html))) toks.push({ i: m.index, season: +m[1] });
    const are = /<a\b[^>]*?\bhref\s*=\s*["']([^"']+)["']/gi;
    while ((m = are.exec(html))) { const p = pathOf(m[1]); if (EP_RE.test(p)) toks.push({ i: m.index, path: p }); }
    toks.sort((a, b) => a.i - b.i);
    let season = 1;
    const bySeason = new Map();
    const seen = new Set();
    for (const t of toks) {
      if (t.season) { season = t.season; continue; }
      if (seen.has(t.path)) continue;
      seen.add(t.path);
      if (!bySeason.has(season)) bySeason.set(season, []);
      bySeason.get(season).push({ path: t.path });
    }
    const episodes = [];
    for (const [s, list] of [...bySeason].sort((a, b) => a[0] - b[0])) {
      list.forEach((e, k) => episodes.push({ season: s, episode: k + 1, path: e.path, mp4: "" }));
    }

    // The static page often lists only episode 1 (the rest load via JS). If so, derive the
    // remaining episodes from the file naming pattern  ..._E01R.mp4 -> _E02R.mp4 and probe them.
    for (const s of [...new Set(episodes.map((e) => e.season))]) {
      const eps = episodes.filter((e) => e.season === s);
      if (eps.length !== 1) continue;
      try {
        const ep1 = eps[0];
        const urls = findVideoUrls(await get(BASE + ep1.path));
        ep1.mp4 = urls[0] || "";
        const pm = ep1.mp4.match(/^(.*?)(\d+)(R?\.mp4)(\?.*)?$/i);
        if (!pm) continue;
        const width = pm[2].length;
        let misses = 0;
        for (let n = Number(pm[2]) + 1; n < Number(pm[2]) + 150 && misses < 2; n++) {
          const u = pm[1] + String(n).padStart(width, "0") + pm[3] + (pm[4] || "");
          let ok = false;
          try { await get(u, "HEAD"); ok = true; } catch { ok = false; }
          if (ok) { misses = 0; episodes.push({ season: s, episode: n - Number(pm[2]) + 1, path: "", mp4: u }); } else misses++;
        }
      } catch (e) { log("warn", "episode probe: " + e.message); }
    }
    episodes.sort((a, b) => a.season - b.season || a.episode - b.episode);
    return { title, poster: pagePoster(html), description: pageDescription(html, title), episodes };
  });
}

// ---------------------------------------------------------------- protocol
function manifest() {
  const genreExtra = (opts) => [
    { name: "genre", options: opts, isRequired: false },
    { name: "search", isRequired: false },
    { name: "skip", isRequired: false },
  ];
  return {
    id: "community.namakade.vod",
    version: "1.0.0",
    name: "Namakade Movies & Series",
    description: "Persian movies and TV series from Namakade / Negahestan.",
    resources: ["catalog", "meta", "stream"],
    types: ["movie", "series"],
    idPrefixes: ["nk_"],
    catalogs: [
      { type: "movie", id: "nk-movies", name: "Namakade Movies", extra: genreExtra(index.movieGenres) },
      { type: "series", id: "nk-series", name: "Namakade Series", extra: genreExtra(index.seriesGenres) },
    ],
  };
}

const preview = (x, type) => ({
  id: x.id, type, name: x.title, poster: x.poster || undefined, posterShape: "poster",
  genres: x.genres.length ? x.genres : undefined,
  description: x.director ? `Director: ${x.director}` : undefined,
});

function parseExtra(seg) {
  const e = {};
  for (const part of (seg || "").split("&")) { const i = part.indexOf("="); if (i > 0) e[decodeURIComponent(part.slice(0, i))] = decodeURIComponent(part.slice(i + 1).replace(/\+/g, " ")); }
  return e;
}

function route(pathname) {
  const parts = pathname.replace(/\.json$/, "").split("/").filter(Boolean).map(decodeURIComponent);
  const [k, type, id, extra] = parts;
  if (k === "manifest") return { kind: "manifest" };
  if (k === "catalog" && id) return { kind: "catalog", type, id, extra: parseExtra(extra) };
  if ((k === "meta" || k === "stream") && id) return { kind: k, type, id: parts.slice(2).join("/") };
  return null;
}

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "GET, OPTIONS" };
function send(res, code, body, type = "application/json; charset=utf-8", extra = {}) {
  res.writeHead(code, { ...CORS, "Content-Type": type, ...extra });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
}

async function handle(req, res) {
  if (req.method === "OPTIONS") return send(res, 204, "");
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

  if (url.pathname === "/health")
    return send(res, 200, { ok: true, ready: index.ready, movies: index.movies.length, series: index.series.length, logs });
  if (url.pathname === "/") {
    const base = `${req.headers["x-forwarded-proto"] || "http"}://${req.headers.host}`;
    return send(res, 200, `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Namakade Addon</title>
<body style="font-family:system-ui;background:#111;color:#eee;max-width:560px;margin:10vh auto;padding:0 20px">
<h1>🎬 Namakade Movies &amp; Series</h1><p>${index.movies.length} movies · ${index.series.length} series</p>
<p>In Nuvio: Settings → Addons → paste:</p>
<code style="background:#222;padding:8px;display:block;word-break:break-all">${base}/manifest.json</code>
<p><a style="color:#9d8cff" href="/health">/health</a> (crawl status &amp; log)</p>`, "text/html; charset=utf-8");
  }

  const r = route(url.pathname);
  if (!r) return send(res, 404, { error: "Not found" });
  if (r.kind === "manifest") { ensureIndex().catch(() => {}); return send(res, 200, manifest()); }

  if (r.kind === "catalog") {
    await ensureIndex();
    const list0 = r.id === "nk-movies" ? index.movies : r.id === "nk-series" ? index.series : [];
    const type = r.id === "nk-movies" ? "movie" : "series";
    const ex = { ...Object.fromEntries(url.searchParams), ...r.extra };
    let list = list0;
    if (ex.genre) list = list.filter((x) => x.genres.includes(ex.genre));
    if (ex.search) { const q = ex.search.toLowerCase(); list = list.filter((x) => x.title.toLowerCase().includes(q)); }
    const skip = Math.max(0, parseInt(ex.skip || "0", 10) || 0);
    return send(res, 200, { metas: list.slice(skip, skip + PAGE_SIZE).map((x) => preview(x, type)) }, undefined, { "Cache-Control": "max-age=300" });
  }

  if (!r.id.startsWith("nk_")) return send(res, 200, r.kind === "meta" ? { meta: null } : { streams: [] });

  try {
    if (r.type === "movie") {
      const path = unb64(r.id.slice(5));
      const base = index.movies.find((x) => x.id === r.id);
      const d = await movieDetail(path);
      if (r.kind === "meta")
        return send(res, 200, { meta: { id: r.id, type: "movie", name: d.title || base?.title || "Movie", poster: d.poster || base?.poster, background: d.poster || base?.poster, description: d.description || undefined, genres: base?.genres } });
      return send(res, 200, { streams: d.videos.map((u, i) => ({ url: u, name: "Namakade", title: `${d.title || base?.title || "Movie"}${d.videos.length > 1 ? ` (#${i + 1})` : ""}`, behaviorHints: { notWebReady: true, proxyHeaders: { request: { Referer: BASE + "/" } } } })) }, undefined, { "Cache-Control": "max-age=300" });
    }
    if (r.type === "series") {
      const [sid, season, episode] = r.id.split(":");
      const path = unb64(sid.slice(5));
      const base = index.series.find((x) => x.id === sid);
      const d = await seriesDetail(path);
      if (r.kind === "meta") {
        return send(res, 200, { meta: { id: sid, type: "series", name: d.title || base?.title || "Series", poster: d.poster || base?.poster, background: d.poster || base?.poster, description: d.description || undefined, genres: base?.genres,
          videos: d.episodes.map((e) => ({ id: `${sid}:${e.season}:${e.episode}`, title: `Episode ${e.episode}`, season: e.season, episode: e.episode, released: new Date(Date.UTC(2000, 0, 1) + (e.season * 1000 + e.episode) * 864e5).toISOString() })) } });
      }
      const ep = d.episodes.find((e) => e.season === +season && e.episode === +episode);
      if (!ep) return send(res, 200, { streams: [] });
      let urls = ep.mp4 ? [ep.mp4] : [];
      if (!urls.length && ep.path) urls = findVideoUrls(await get(BASE + ep.path));
      return send(res, 200, { streams: urls.map((u) => ({ url: u, name: "Namakade", title: `${d.title || base?.title || "Episode"} S${season}E${episode}`, behaviorHints: { notWebReady: true, proxyHeaders: { request: { Referer: BASE + "/" } } } })) }, undefined, { "Cache-Control": "max-age=300" });
    }
  } catch (e) {
    log("error", `${r.kind} ${r.id}: ${e.message}`);
  }
  return send(res, 200, r.kind === "meta" ? { meta: null } : { streams: [] });
}

const server = http.createServer((req, res) => handle(req, res).catch((e) => { log("error", e.message); send(res, 500, { error: "internal" }); }));

if (require.main === module) {
  server.listen(PORT, () => console.log(`Addon running: http://localhost:${PORT}/manifest.json`));
  startCrawl();
}
module.exports = { extractItems, findVideoUrls, findLinks, pageTitle };
