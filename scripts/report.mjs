// Matchup report per game: offense/defense ranks, injuries that matter, ESPN's predictor,
// recent form, stat leaders and team headlines. Fetchers hit ESPN's public site API;
// the parse/build functions are pure and tested in tests/report.test.mjs.
import { TEAMS, teamCode } from "../js/core.js";
import { getJSON } from "./sources.mjs";

const SITE = "https://site.api.espn.com/apis/site/v2/sports/football/nfl";

/* ---------- team stats -> league ranks ---------- */

const findStat = (cats, cat, name) => cats?.find((c) => c.name === cat)?.stats?.find((s) => s.name === name)?.value;

// One team's season numbers from /teams/{id}/statistics.
export function parseTeamStats(json) {
  const own = json?.results?.stats?.categories, opp = json?.results?.opponent;
  const gp = findStat(own, "general", "gamesPlayed");
  if (!gp) return null;
  const per = (v) => (v == null ? null : v / gp);
  return {
    gp,
    ppg: findStat(own, "scoring", "totalPointsPerGame") ?? per(findStat(own, "scoring", "totalPoints")),
    ypg: findStat(own, "passing", "yardsPerGame") ?? per(findStat(own, "rushing", "totalYards")),
    pass: findStat(own, "passing", "netPassingYardsPerGame"),
    rush: findStat(own, "rushing", "rushingYardsPerGame"),
    oppg: findStat(opp, "scoring", "totalPointsPerGame") ?? per(findStat(opp, "scoring", "totalPoints")),
    oypg: findStat(opp, "passing", "yardsPerGame") ?? per(findStat(opp, "rushing", "totalYards")),
    opass: findStat(opp, "passing", "netPassingYardsPerGame"),
    orush: findStat(opp, "rushing", "rushingYardsPerGame"),
    to: findStat(own, "miscellaneous", "turnOverDifferential"),
  };
}

// Rank every team 1-32. Offense: more is better. Defense (o*): less is better. Turnovers: more is better.
const RANK_KEYS = { ppg: -1, ypg: -1, pass: -1, rush: -1, oppg: 1, oypg: 1, opass: 1, orush: 1, to: -1 };
export function rankTeams(statsByTeam) {
  const out = {};
  Object.keys(statsByTeam).forEach((t) => { out[t] = {}; });
  Object.entries(RANK_KEYS).forEach(([k, dir]) => {
    const list = Object.entries(statsByTeam).filter(([, s]) => s && s[k] != null).sort((a, b) => dir * (a[1][k] - b[1][k]));
    list.forEach(([t, s], i) => {
      // ties share the better rank
      const rank = i > 0 && list[i - 1][1][k] === s[k] ? out[list[i - 1][0]][k][1] : i + 1;
      out[t][k] = [Math.round(s[k] * 10) / 10, rank];
    });
  });
  return out;
}

export async function fetchRanks() {
  const teams = (await getJSON(`${SITE}/teams`)).sports[0].leagues[0].teams.map((x) => x.team);
  const stats = {}, ids = {};
  for (const t of teams) {
    const code = teamCode(t.abbreviation);
    ids[code] = t.id;
    try { stats[code] = parseTeamStats(await getJSON(`${SITE}/teams/${t.id}/statistics`)); } catch (e) { console.warn(`Stats for ${code} unavailable:`, e.message); }
  }
  return { ranks: rankTeams(stats), ids };
}

/* ---------- game summary: injuries, predictor, form, leaders ---------- */

const STATUS_ORDER = { Out: 0, "Injured Reserve": 0, Suspension: 0, Doubtful: 1, Questionable: 2, "Day-To-Day": 3, Probable: 4 };
const LEADER_CATS = { passingYards: "Passing", rushingYards: "Rushing", receivingYards: "Receiving", sacks: "Sacks", totalTackles: "Tackles" };

export function parseSummary(json) {
  const out = { teams: {}, fpi: null };
  const team = (abbr) => (out.teams[teamCode(abbr)] ||= { injuries: [], leaders: [], form: [] });
  (json?.leaders || []).forEach((l) => {
    const t = team(l.team?.abbreviation);
    (l.leaders || []).forEach((c) => {
      const top = c.leaders?.[0];
      if (LEADER_CATS[c.name] && top?.athlete?.displayName) t.leaders.push({ cat: LEADER_CATS[c.name], name: top.athlete.displayName, value: top.displayValue || "" });
    });
  });
  (json?.injuries || []).forEach((it) => {
    const t = team(it.team?.abbreviation);
    (it.injuries || []).forEach((i) => {
      const status = i.status || i.type?.description || "";
      if (!(status in STATUS_ORDER)) return;
      const d = i.details || {};
      const detail = d.detail && d.detail !== "Not Specified" ? d.detail : d.type && d.type !== "Not Specified" ? d.type : "";
      t.injuries.push({ name: i.athlete?.displayName || "", pos: i.athlete?.position?.abbreviation || "", status, detail });
    });
  });
  (json?.lastFiveGames || []).forEach((l) => {
    team(l.team?.abbreviation).form = (l.events || []).map((e) => ({ r: e.gameResult, s: e.score, opp: teamCode(e.opponent?.abbreviation), home: e.atVs === "vs" }));
  });
  const p = json?.predictor;
  if (p?.homeTeam?.gameProjection && p?.awayTeam?.gameProjection) out.fpi = [Number(p.awayTeam.gameProjection), Number(p.homeTeam.gameProjection)];
  return out;
}

export async function fetchSummary(espnId) {
  return parseSummary(await getJSON(`${SITE}/summary?event=${espnId}`));
}

/* ---------- team headlines ---------- */

// Team-specific stories from the last 7 days (skip league-wide roundups tagged with many teams).
export function parseTeamNews(json, now = new Date()) {
  return (json?.articles || [])
    .filter((a) => (a.categories || []).filter((c) => c.type === "team").length <= 2)
    .filter((a) => !a.published || now - new Date(a.published) < 7 * 864e5)
    .slice(0, 3)
    .map((a) => ({ h: a.headline, d: a.description || "", url: a.links?.web?.href || "", video: a.type === "Media", at: a.published || null }));
}

export async function fetchTeamNews(id) {
  return parseTeamNews(await getJSON(`${SITE}/news?team=${id}&limit=15`));
}

/* ---------- build the report ---------- */

// An injury matters when the player is a quarterback or one of the team's stat leaders,
// and he's out, doubtful or questionable.
export function keyInjuries(injuries, leaders) {
  const leaderNames = new Map(leaders.map((l) => [l.name, l.cat]));
  return injuries
    .filter((i) => STATUS_ORDER[i.status] <= 2 && (i.pos === "QB" || leaderNames.has(i.name)))
    .map((i) => ({ ...i, why: i.pos === "QB" ? "Quarterback" : `Team leader in ${leaderNames.get(i.name).toLowerCase()}` }));
}

const ord = (n) => n + (n % 100 >= 11 && n % 100 <= 13 ? "th" : ["th", "st", "nd", "rd"][n % 10] || "th");

// Short sentences comparing each offense with the defense it faces.
export function edges(game, ranks) {
  const a = ranks[game.away], h = ranks[game.home];
  if (!a?.ppg || !h?.ppg || !a?.oppg || !h?.oppg) return [];
  const line = (off, def) => {
    const o = ranks[off].ppg[1], d = ranks[def].oppg[1];
    const gap = d - o;   // positive: offense ranks better than the defense it faces
    const tag = gap >= 10 ? "edge to the offense" : gap <= -10 ? "edge to the defense" : "even matchup";
    return `${TEAMS[off]} offense (${ord(o)} in scoring) vs ${TEAMS[def]} defense (${ord(d)} in points allowed): ${tag}.`;
  };
  return [line(game.away, game.home), line(game.home, game.away)];
}

export function buildReport(game, { summary, ranks, news }, now = new Date()) {
  const side = (t) => {
    const s = summary?.teams?.[t] || { injuries: [], leaders: [], form: [] };
    const injuries = s.injuries.slice().sort((x, y) => STATUS_ORDER[x.status] - STATUS_ORDER[y.status]);
    return {
      rank: ranks?.[t] || null,
      key: keyInjuries(injuries, s.leaders),
      injuries,
      leaders: s.leaders,
      form: s.form,
      news: news?.[t] || [],
    };
  };
  return {
    updated: now.toISOString(),
    fpi: summary?.fpi || null,
    edges: ranks ? edges(game, ranks) : [],
    teams: { [game.away]: side(game.away), [game.home]: side(game.home) },
  };
}

// Fetch everything and attach a report to each game that hasn't kicked off. Returns games updated.
export async function addReports(week, { now = new Date(), log = console } = {}) {
  const todo = week.games.filter((g) => g.status === "upcoming" && g.espnId);
  if (!todo.length) return 0;
  let ranks = null, ids = {};
  try { ({ ranks, ids } = await fetchRanks()); } catch (e) { log.warn("Team ranks unavailable:", e.message); }
  const newsCache = {};
  const teamNews = async (t) => {
    if (!(t in newsCache)) { try { newsCache[t] = ids[t] ? await fetchTeamNews(ids[t]) : []; } catch (e) { newsCache[t] = []; } }
    return newsCache[t];
  };
  let n = 0;
  for (const g of todo) {
    let summary = null;
    try { summary = await fetchSummary(g.espnId); } catch (e) { log.warn(`Summary for ${g.id} unavailable:`, e.message); }
    const news = { [g.away]: await teamNews(g.away), [g.home]: await teamNews(g.home) };
    g.report = buildReport(g, { summary, ranks, news }, now);
    n++;
  }
  return n;
}
