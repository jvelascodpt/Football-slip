// Fetching and parsing the three data sources. Parsers are pure and tested against
// trimmed real responses in tests/fixtures.
import { TEAMS, teamCode } from "../js/core.js";

const UA = { "User-Agent": "football-slip-data-script", Accept: "application/json" };

export async function getJSON(url, { tries = 3 } = {}) {
  let err;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: UA });
      if (!r.ok) throw new Error(`${r.status} ${r.statusText} for ${url.replace(/apiKey=[^&]+/, "apiKey=***")}`);
      return await r.json();
    } catch (e) {
      err = e;
      if (i < tries - 1) await new Promise((res) => setTimeout(res, 1000 * 2 ** i));
    }
  }
  throw err;
}

/* ---------- ESPN: schedule, scores, records, DraftKings moneyline ---------- */

export const espnUrl = (season, week) =>
  `https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?seasontype=2&week=${week}&dates=${season}`;

function liveText(detail) {
  const m = /^(.*?)\s*-\s*(\d)(st|nd|rd|th)$/.exec(detail || "");
  if (m) return `${m[2]}${m[3]} qtr ${m[1]}`.trim();
  return detail || "";
}

export function parseEspn(json) {
  return (json.events || []).map((e) => {
    const c = e.competitions[0];
    const side = (ha) => c.competitors.find((x) => x.homeAway === ha);
    const a = side("away"), h = side("home");
    const t = e.status?.type || {};
    let status = "upcoming";
    if (t.state === "in") status = "live";
    else if (t.state === "post") status = t.completed ? "final" : "upcoming";
    const ml = c.odds?.[0]?.moneyline;
    const dk = ml?.away?.close?.odds && ml?.home?.close?.odds ? [ml.away.close.odds, ml.home.close.odds] : null;
    const g = {
      start: new Date(e.date).toISOString(),
      away: teamCode(a.team.abbreviation),
      home: teamCode(h.team.abbreviation),
      status,
      record: [a.records?.[0]?.summary || null, h.records?.[0]?.summary || null],
      ml: dk, mlBook: dk ? c.odds[0].provider?.name || "Sportsbook" : null,
    };
    if (status !== "upcoming") g.score = [Number(a.score) || 0, Number(h.score) || 0];
    if (status === "live") g.live = liveText(t.shortDetail);
    if (t.state === "post" && !t.completed) g.live = t.shortDetail || "Postponed";
    return g;
  });
}

// Last week's result per team, for the notes: { BUF: {opp:"MIN", us:23, them:6, home:false} }.
export function resultsByTeam(parsedGames) {
  const out = {};
  parsedGames.filter((g) => g.status === "final").forEach((g) => {
    out[g.away] = { opp: g.home, us: g.score[0], them: g.score[1], home: false };
    out[g.home] = { opp: g.away, us: g.score[1], them: g.score[0], home: true };
  });
  return out;
}

/* ---------- Kalshi: market price per team ---------- */

export const kalshiUrl = (cursor) =>
  `https://api.elections.kalshi.com/trade-api/v2/markets?series_ticker=KXNFLGAME&status=open&limit=1000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;

export async function fetchKalshi() {
  const markets = [];
  let cursor = "";
  for (let i = 0; i < 10; i++) {
    const j = await getJSON(kalshiUrl(cursor));
    markets.push(...(j.markets || []));
    cursor = j.cursor;
    if (!cursor) break;
  }
  return { markets };
}

const MONTHS = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };
const cents = (x) => (x == null || x === "" ? null : Math.round(parseFloat(x) * 100));

// -> [{ date: "2026-11-15", prices: { PIT: 37, CIN: 64 } }] where prices are the "Yes" ask in cents (= percent).
export function parseKalshi(json) {
  const byEvent = new Map();
  (json.markets || []).forEach((m) => {
    const code = teamCode(m.ticker.split("-").pop());
    const dm = /-(\d{2})([A-Z]{3})(\d{2})/.exec(m.event_ticker || "");
    if (!dm || !TEAMS[code]) return;
    const date = `20${dm[1]}-${String(MONTHS[dm[2]] + 1).padStart(2, "0")}-${dm[3]}`;
    if (!byEvent.has(m.event_ticker)) byEvent.set(m.event_ticker, { date, prices: {} });
    const ask = cents(m.yes_ask_dollars ?? (m.yes_ask != null ? m.yes_ask / 100 : null));
    const last = cents(m.last_price_dollars ?? (m.last_price != null ? m.last_price / 100 : null));
    const price = ask > 0 && ask < 100 ? ask : last;
    if (price != null) byEvent.get(m.event_ticker).prices[code] = price;
  });
  return [...byEvent.values()];
}

const etDate = (iso) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date(iso));
const dayDiff = (a, b) => Math.abs(Date.parse(a) - Date.parse(b)) / 864e5;

export function kalshiFor(game, kalshi) {
  const ev = kalshi.find((k) => k.prices[game.away] != null && k.prices[game.home] != null && dayDiff(k.date, etDate(game.start)) <= 1);
  return ev ? [ev.prices[game.away], ev.prices[game.home]] : null;
}

/* ---------- The Odds API: moneylines from many books ---------- */

export const oddsApiUrl = (key) =>
  `https://api.the-odds-api.com/v4/sports/americanfootball_nfl/odds?regions=us&markets=h2h&oddsFormat=american&apiKey=${encodeURIComponent(key)}`;

const codeFromName = (name) => Object.keys(TEAMS).find((c) => String(name).endsWith(TEAMS[c])) || null;

// -> [{ start, away, home, pairs: [[awayML, homeML], ...] }]
export function parseOddsApi(json) {
  return (json || []).map((ev) => {
    const away = codeFromName(ev.away_team), home = codeFromName(ev.home_team);
    const pairs = [];
    (ev.bookmakers || []).forEach((b) => {
      const m = (b.markets || []).find((x) => x.key === "h2h");
      if (!m) return;
      const pa = m.outcomes.find((o) => o.name === ev.away_team)?.price;
      const ph = m.outcomes.find((o) => o.name === ev.home_team)?.price;
      if (pa != null && ph != null) pairs.push([pa, ph]);
    });
    return { start: ev.commence_time, away, home, pairs };
  }).filter((e) => e.away && e.home);
}

export function oddsFor(game, odds) {
  return odds.find((o) => o.away === game.away && o.home === game.home && dayDiff(o.start, game.start) <= 1) || null;
}
