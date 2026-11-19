#!/usr/bin/env node
// Football Slip data script.
//
//   node scripts/update.mjs new [--week N] [--season YYYY]
//       Build (or refresh) a week file: schedule, no-margin win probabilities, picks, notes,
//       suggested parlays and Kalshi prices. Also fills in final scores for the week before.
//       Default week: the one after the newest file in data/index.json.
//       Re-running for the same week refreshes odds for games not yet started and keeps
//       picks for games already underway.
//
//   node scripts/update.mjs refresh
//       Same as `new` for the newest week already in data/ (re-prices games not yet started).
//
//   node scripts/update.mjs scores
//       Update live/final scores for the newest week and the week before it.
//
// Optional env: ODDS_API_KEY (The Odds API). Without it, ESPN's DraftKings moneyline is used.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { espnUrl, fetchKalshi, getJSON, oddsApiUrl, parseEspn, parseKalshi, parseOddsApi, resultsByTeam } from "./sources.mjs";
import { applyScores, buildWeek, fmtUpdated } from "./build.mjs";
import { addReports } from "./report.mjs";
import { buildProps, fetchPropMarkets, gradeProps, trackMarkets } from "./props.mjs";

// Rebuild prop parlays for games Kalshi has opened that haven't kicked off, and grade settled legs.
async function updateProps(w) {
  try {
    trackMarkets(w);   // remember the current legs before a re-price replaces them
    w.props = buildProps(w, await fetchPropMarkets());
    const graded = await gradeProps(w);
    console.log(`Props: ${w.props.filter((p) => p.auto).length} game parlays${graded ? `, graded ${graded} legs` : ""}.`);
  } catch (e) { console.warn("Kalshi props unavailable:", e.message); }
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA = path.join(ROOT, "data");
const fileName = (season, week) => `${season}-week-${String(week).padStart(2, "0")}.json`;

async function readJSON(p, fallback = null) {
  if (!existsSync(p)) return fallback;
  return JSON.parse(await readFile(p, "utf8"));
}
const writeJSON = (p, obj) => writeFile(p, JSON.stringify(obj, null, 2) + "\n");

async function loadIndex() {
  return readJSON(path.join(DATA, "index.json"), { weeks: [] });
}
async function saveIndex(idx, season, week) {
  const file = fileName(season, week);
  if (!idx.weeks.some((w) => w.file === file)) idx.weeks.push({ season, week, file });
  idx.weeks.sort((a, b) => a.season - b.season || a.week - b.week);
  await writeJSON(path.join(DATA, "index.json"), idx);
}

function args(argv) {
  const a = { cmd: argv[0] };
  for (let i = 1; i < argv.length; i++) if (argv[i].startsWith("--")) a[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true;
  return a;
}

async function fetchWeek(season, week) {
  return parseEspn(await getJSON(espnUrl(season, week)));
}

async function updateScoresFor(season, week, games) {
  const p = path.join(DATA, fileName(season, week));
  const w = await readJSON(p);
  if (!w) return 0;
  const n = applyScores(w, games || (await fetchWeek(season, week)));
  const graded = await gradeProps(w);
  if (graded) console.log(`week ${week}: graded ${graded} prop leg${graded === 1 ? "" : "s"}`);
  if (n || graded) {
    w.refreshed = fmtUpdated(new Date());
    await writeJSON(p, w);
  }
  console.log(`week ${week}: ${n} game${n === 1 ? "" : "s"} updated`);
  return n;
}

async function cmdNew(a) {
  const idx = await loadIndex();
  const newest = idx.weeks.at(-1);
  let season = Number(a.season) || newest?.season;
  let week = Number(a.week) || (newest ? newest.week + 1 : null);
  // Scheduled runs fire more than once on Tuesdays (GitHub can start them hours late), so a
  // second run must not build the week after next: skip while the newest week still has games to play.
  if (!a.week && newest) {
    const cur = await readJSON(path.join(DATA, newest.file));
    if (cur?.games?.some((g) => g.status === "upcoming")) {
      console.log(`Week ${newest.week} still has games to play; not building week ${newest.week + 1} yet.`);
      return;
    }
  }
  if (!season || !week) {
    const cur = await getJSON("https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard");
    season = season || cur.season.year;
    week = week || cur.week.number;
  }
  if (week > 18) throw new Error("Regular season only (weeks 1-18).");

  const games = await fetchWeek(season, week);
  if (!games.length) throw new Error(`ESPN has no games for ${season} week ${week}.`);
  const prev = week > 1 ? await fetchWeek(season, week - 1) : [];
  if (prev.length) await updateScoresFor(season, week - 1, prev);

  let kalshi = [];
  try { kalshi = parseKalshi(await fetchKalshi()); } catch (e) { console.warn("Kalshi unavailable:", e.message); }
  let odds = [];
  if (process.env.ODDS_API_KEY) {
    try { odds = parseOddsApi(await getJSON(oddsApiUrl(process.env.ODDS_API_KEY))); } catch (e) { console.warn("The Odds API unavailable:", e.message); }
  } else console.warn("ODDS_API_KEY not set: using ESPN's DraftKings moneyline.");

  const p = path.join(DATA, fileName(season, week));
  const existing = await readJSON(p);
  const w = buildWeek({ season, week, games, last: resultsByTeam(prev), odds, kalshi, existing });
  const reported = await addReports(w);
  console.log(`Matchup reports: ${reported} games.`);
  await updateProps(w);
  await mkdir(DATA, { recursive: true });
  await writeJSON(p, w);
  await saveIndex(idx, season, week);
  await writeSchedule(season, week);
  const picked = w.games.filter((g) => g.pick).length;
  console.log(`${existing ? "Refreshed" : "Wrote"} ${path.relative(ROOT, p)}: ${w.games.length} games, ${picked} picks, ${w.parlays.length} parlays, ${w.games.filter((g) => g.kalshi).length} with Kalshi prices.`);
}

// Look-ahead schedule for the weeks after `week`, used by the app's preview weeks.
async function writeSchedule(season, week) {
  const weeks = [];
  for (let n = week + 1; n <= 18; n++) {
    try {
      const games = (await fetchWeek(season, n)).map((g) => ({ away: g.away, home: g.home, start: g.start, ...(g.info?.venue ? { venue: g.info.venue, city: g.info.city } : {}) }));
      if (games.length) weeks.push({ week: n, games });
    } catch (e) { console.warn(`Schedule for week ${n} unavailable:`, e.message); }
  }
  await writeJSON(path.join(DATA, `schedule-${season}.json`), { season, from: week + 1, weeks });
  const idx = await loadIndex();
  idx.schedule = `schedule-${season}.json`;
  await writeJSON(path.join(DATA, "index.json"), idx);
}

async function cmdScores() {
  const idx = await loadIndex();
  const newest = idx.weeks.at(-1);
  if (!newest) throw new Error("No weeks yet. Run: node scripts/update.mjs new");
  await updateScoresFor(newest.season, newest.week);
  if (newest.week > 1) await updateScoresFor(newest.season, newest.week - 1);
}

const a = args(process.argv.slice(2));
async function cmdRefresh() {
  const newest = (await loadIndex()).weeks.at(-1);
  if (!newest) throw new Error("No weeks yet. Run: node scripts/update.mjs new");
  return cmdNew({ season: newest.season, week: newest.week });
}

// Refresh matchup reports (injuries, ranks, predictor, headlines) for the newest week's
// games that haven't kicked off. Picks and odds are untouched.
async function cmdReport() {
  const newest = (await loadIndex()).weeks.at(-1);
  if (!newest) throw new Error("No weeks yet. Run: node scripts/update.mjs new");
  const p = path.join(DATA, newest.file);
  const w = await readJSON(p);
  const espn = await fetchWeek(newest.season, newest.week);
  w.games.forEach((g) => {
    const e = espn.find((x) => x.away === g.away && x.home === g.home);
    if (e && !g.espnId) g.espnId = e.espnId;
  });
  const n = await addReports(w);
  await updateProps(w);
  w.refreshed = fmtUpdated(new Date());
  await writeJSON(p, w);
  console.log(`week ${newest.week}: matchup reports for ${n} games`);
}

const run = { new: cmdNew, refresh: cmdRefresh, scores: cmdScores, report: cmdReport }[a.cmd];
if (!run) {
  console.log("Usage: node scripts/update.mjs new [--week N] [--season YYYY] | refresh | scores | report");
  process.exit(1);
}
run(a).catch((e) => { console.error(e.message); process.exit(1); });
