// Player-prop parlays from Kalshi's NFL player markets, built per game as soon as Kalshi opens
// them (Thursday games are usually open by Tuesday). Kalshi also settles each market, so legs
// are graded automatically. Parsing and selection are pure and tested in tests/props.test.mjs.
import { TEAMS } from "../js/core.js";
import { getJSON } from "./sources.mjs";

const API = "https://api.elections.kalshi.com/trade-api/v2";
// Kalshi series -> how a leg reads: "60+ rushing yards".
export const PROP_SERIES = {
  KXNFLPASSYDS: "passing yards",
  KXNFLRSHYDS: "rushing yards",
  KXNFLRECYDS: "receiving yards",
  KXNFLREC: "receptions",
  KXNFLPASSTDS: "passing touchdowns",
  KXNFLTD: "touchdowns",
};
const TO_KALSHI = { LA: "LAR" };   // app code -> Kalshi code where they differ
const kalshiCode = (t) => TO_KALSHI[t] || t;
const MONTHS = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };
const etDate = (iso) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date(iso));
const cents = (x) => (x == null || x === "" ? null : Math.round(parseFloat(x) * 100));

// Market -> prop candidate, or null if it isn't a player line we can use.
export function parsePropMarket(m, series) {
  const ev = /-(\d{2})([A-Z]{3})(\d{2})([A-Z]+)$/.exec(m.event_ticker || "");
  const tm = /^(.+?):\s*(\d+)\+/.exec(m.title || "");
  if (!ev || !tm || !PROP_SERIES[series]) return null;
  const date = `20${ev[1]}-${String(MONTHS[ev[2]] + 1).padStart(2, "0")}-${ev[3]}`;
  const playerSeg = m.ticker.split("-").at(-2) || "";
  const done = m.status === "finalized" || m.status === "settled" || m.result === "yes" || m.result === "no";
  return {
    ticker: m.ticker, series, date, teams: ev[4], seg: playerSeg,
    player: tm[1].trim(), line: Number(tm[2]), stat: PROP_SERIES[series],
    bid: cents(m.yes_bid_dollars), ask: cents(m.yes_ask_dollars),
    result: done ? (m.result === "yes" ? "hit" : m.result === "no" ? "miss" : null) : null,
  };
}

export async function fetchPropMarkets() {
  const out = [];
  for (const series of Object.keys(PROP_SERIES)) {
    let cursor = "";
    for (let i = 0; i < 5; i++) {
      const j = await getJSON(`${API}/markets?series_ticker=${series}&status=open&limit=1000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
      (j.markets || []).forEach((m) => { const p = parsePropMarket(m, series); if (p) out.push(p); });
      cursor = j.cursor; if (!cursor) break;
    }
  }
  return out;
}

// Which game and team a candidate belongs to, or null.
export function matchProp(p, games) {
  for (const g of games) {
    const a = kalshiCode(g.away), h = kalshiCode(g.home);
    if (p.teams !== a + h) continue;
    if (Math.abs(Date.parse(p.date) - Date.parse(etDate(g.start))) > 864e5) continue;
    const team = p.seg.startsWith(a) ? g.away : p.seg.startsWith(h) ? g.home : null;
    return team ? { game: g, team } : null;
  }
  return null;
}

const TARGET = 72;                      // aim for lines priced near 72%
const liquid = (p) => p.bid != null && p.ask != null && p.bid >= 3 && p.ask - p.bid <= 6;
const BAD_STATUS = new Set(["Out", "Injured Reserve", "Suspension", "Doubtful", "Questionable"]);

// One 3-leg parlay for a game: three different players (both teams represented when possible),
// team stat leaders first, injured players skipped, each at the line priced closest to 72%.
export function pickGameParlay(game, candidates) {
  const rep = game.report?.teams || {};
  const injured = new Set(Object.values(rep).flatMap((t) => (t.injuries || []).filter((i) => BAD_STATUS.has(i.status)).map((i) => i.name)));
  const leaderOf = {};
  Object.values(rep).forEach((t) => (t.leaders || []).forEach((l) => { leaderOf[l.name] ||= l; }));
  const best = new Map();   // player -> best candidate
  candidates.filter((c) => liquid(c) && c.ask >= 60 && c.ask <= 85 && !injured.has(c.player)).forEach((c) => {
    const cur = best.get(c.player);
    if (!cur || Math.abs(c.ask - TARGET) < Math.abs(cur.ask - TARGET)) best.set(c.player, c);
  });
  const ranked = [...best.values()].sort((x, y) =>
    (leaderOf[y.player] ? 1 : 0) - (leaderOf[x.player] ? 1 : 0) || Math.abs(x.ask - TARGET) - Math.abs(y.ask - TARGET));
  const legs = [];
  for (const c of ranked) {
    if (legs.length === 3) break;
    const sameTeam = legs.filter((l) => l.team === c.team).length;
    const otherTeamLeft = ranked.some((r) => r.team !== c.team && !legs.includes(r));
    if (legs.length === 2 && sameTeam === 2 && otherTeamLeft) continue;   // keep both teams in it
    legs.push(c);
  }
  if (legs.length < 3) return null;
  const nick = (t) => TEAMS[t] || t;
  return {
    auto: true, game: game.id,
    name: `${nick(game.away)} at ${nick(game.home)}`,
    tag: game.kick ? game.kick.split(" ")[0] : "",
    note: "Kalshi player props near 72% each, from three different players. Same-game legs are related, so treat the combined chance as rough.",
    legs: legs.map((c) => {
      const l = leaderOf[c.player];
      return {
        game: game.id, team: c.team, player: c.player, bet: `${c.line}+ ${c.stat}`, prob: c.ask, ticker: c.ticker, result: null,
        why: l ? `Team leader in ${l.cat.toLowerCase()}: ${l.value}.` : "",
      };
    }),
  };
}

// Rebuild auto prop parlays for games that haven't started; keep hand-entered parlays and any
// parlay whose game already kicked off. Returns the new props list.
export function buildProps(week, candidates, now = new Date()) {
  const started = (id) => { const g = week.games.find((x) => x.id === id); return !g || g.status !== "upcoming" || Date.parse(g.start) <= now.getTime(); };
  const kept = (week.props || []).filter((p) => !p.auto || started(p.game));
  const keptGames = new Set(kept.filter((p) => p.auto).map((p) => p.game));
  const byGame = new Map();
  candidates.forEach((c) => {
    const m = matchProp(c, week.games);
    if (m) { if (!byGame.has(m.game.id)) byGame.set(m.game.id, []); byGame.get(m.game.id).push({ ...c, team: m.team }); }
  });
  const fresh = week.games
    .filter((g) => !keptGames.has(g.id) && !started(g.id) && byGame.has(g.id))
    .map((g) => pickGameParlay(g, byGame.get(g.id)))
    .filter(Boolean);
  const start = (p) => Date.parse(week.games.find((g) => g.id === p.game)?.start || 0);
  // Games still to play first (soonest first), then finished ones; hand-entered parlays keep their place on top.
  const manual = kept.filter((p) => !p.auto), auto = [...kept.filter((p) => p.auto), ...fresh];
  auto.sort((x, y) => (started(x.game) - started(y.game)) || start(x) - start(y));
  return [...manual, ...auto];
}

// Fill in hit/miss from Kalshi for legs whose market has settled. Returns the number graded.
export async function gradeProps(week, fetchMarket = (t) => getJSON(`${API}/markets/${t}`).then((j) => j.market)) {
  let n = 0;
  for (const p of week.props || []) {
    for (const l of p.legs || []) {
      if (!l.ticker || l.result) continue;
      const g = week.games.find((x) => x.id === l.game);
      if (!g || g.status === "upcoming") continue;
      try {
        const m = await fetchMarket(l.ticker);
        if (m && (m.result === "yes" || m.result === "no")) { l.result = m.result === "yes" ? "hit" : "miss"; n++; }
      } catch (e) { /* try again next run */ }
    }
  }
  return n;
}
