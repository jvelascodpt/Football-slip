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
      cursor = j.cursor;
      await new Promise((r) => setTimeout(r, 400));   // be gentle with Kalshi's rate limit
      if (!cursor) break;
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

const TARGET = 72;                      // default aim for a line's price
const liquid = (p) => p.bid != null && p.ask != null && p.bid >= 3 && p.ask - p.bid <= 6;
const BAD_STATUS = new Set(["Out", "Injured Reserve", "Suspension", "Doubtful", "Questionable"]);
const nick = (t) => TEAMS[t] || t;
const ptDay = (iso) => new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", weekday: "short" }).format(new Date(iso));

// Thursday, Monday (and other weekday) games get their own parlay; Saturday and Sunday games are pooled.
export const pooled = (g) => ["Sat", "Sun"].includes(ptDay(g.start));

// Injured players and team stat leaders, from the games' matchup reports.
function context(games) {
  const injured = new Set(), leaderOf = {};
  games.forEach((g) => Object.values(g.report?.teams || {}).forEach((t) => {
    (t.injuries || []).forEach((i) => { if (BAD_STATUS.has(i.status)) injured.add(i.name); });
    (t.leaders || []).forEach((l) => { leaderOf[l.name] ||= l; });
  }));
  return { injured, leaderOf };
}

// Best line per player in [lo, hi], closest to `target`; team stat leaders first.
function rankPlayers(cands, { lo, hi, target }, { injured, leaderOf }) {
  const best = new Map();
  cands.filter((c) => liquid(c) && c.ask >= lo && c.ask <= hi && !injured.has(c.player)).forEach((c) => {
    const cur = best.get(c.player);
    if (!cur || Math.abs(c.ask - target) < Math.abs(cur.ask - target)) best.set(c.player, c);
  });
  return [...best.values()].sort((x, y) =>
    (leaderOf[y.player] ? 1 : 0) - (leaderOf[x.player] ? 1 : 0) || Math.abs(x.ask - target) - Math.abs(y.ask - target) || x.ticker.localeCompare(y.ticker));
}

const toLeg = (c, { leaderOf }) => {
  const l = leaderOf[c.player];
  return { game: c.gameId, team: c.team, player: c.player, bet: `${c.line}+ ${c.stat}`, prob: c.ask, ticker: c.ticker, result: null,
    why: l ? `Team leader in ${l.cat.toLowerCase()}: ${l.value}.` : "" };
};

// Thursday/Monday safe bet for a single game: three different players, both teams represented when
// possible, team stat leaders first, injured players skipped, each at the line priced closest to 80%.
export function pickGameParlay(game, candidates) {
  const ctx = context([game]);
  const ranked = rankPlayers(candidates.map((c) => ({ ...c, gameId: game.id })), { lo: 72, hi: 88, target: 80 }, ctx);   // safe bet only
  const legs = [];
  for (const c of ranked) {
    if (legs.length === 3) break;
    const sameTeam = legs.filter((l) => l.team === c.team).length;
    const otherTeamLeft = ranked.some((r) => r.team !== c.team && !legs.includes(r));
    if (legs.length === 2 && sameTeam === 2 && otherTeamLeft) continue;   // keep both teams in it
    legs.push(c);
  }
  if (legs.length < 3) return null;
  return {
    auto: true, key: game.id, game: game.id,
    name: `${nick(game.away)} at ${nick(game.home)}`,
    tag: `${game.kick ? game.kick.split(" ")[0] + " · " : ""}Safe`,
    note: "Safe bet: three Kalshi player props near 80% each, from three different players in this game. Same-game legs are related, so treat the combined chance as rough.",
    legs: legs.map((c) => toLeg(c, ctx)),
  };
}

// Weekend parlays that mix games: every leg from a different game.
export const MIX = [
  { key: "mix-safe", size: 3, lo: 72, hi: 88, target: 80, name: "safe bet", tier: "Safe",
    note: "Three Kalshi player props near 80% each, each from a different game." },
  { key: "mix-medium", size: 4, lo: 62, hi: 78, target: 70, name: "medium bet", tier: "Medium",
    note: "Four Kalshi player props near 70% each, each from a different game." },
  { key: "mix-payout", size: 2, lo: 32, hi: 48, target: 40, name: "high payout", tier: "High payout",
    note: "Two longer-shot Kalshi player props near 40% each, from different games. Fewer legs, bigger return. Small stake only." },
];
export function pickMixParlay(spec, games, candidates) {
  const ctx = context(games);
  const ranked = rankPlayers(candidates, spec, ctx);
  const legs = [], usedGames = new Set();
  // Spread the legs out: best player per game first, by kickoff-agnostic ranking.
  for (const c of ranked) {
    if (legs.length === spec.size) break;
    if (usedGames.has(c.gameId)) continue;
    usedGames.add(c.gameId); legs.push(c);
  }
  if (legs.length < spec.size) return null;
  const day = ptDay(games.find((g) => g.id === legs[0].gameId).start) === "Sat" ? "Saturday" : "Sunday";
  return { auto: true, key: spec.key, games: legs.map((c) => c.gameId), name: `${day} ${spec.name}`, tag: spec.tier, note: spec.note, legs: legs.map((c) => toLeg(c, ctx)) };
}

// Rebuild auto prop parlays that haven't started; keep hand-entered parlays and any parlay
// with a leg whose game already kicked off (so it isn't rebuilt or duplicated). Returns the list.
export function buildProps(week, candidates, now = new Date()) {
  const gameById = new Map(week.games.map((g) => [g.id, g]));
  const started = (id) => { const g = gameById.get(id); return !g || g.status !== "upcoming" || Date.parse(g.start) <= now.getTime(); };
  const games = (p) => p.games || (p.game ? [p.game] : (p.legs || []).map((l) => l.game));
  const anyStarted = (p) => games(p).some(started);
  const keyOf = (p) => p.key || p.game;
  // Old per-game parlays for weekend games are replaced by the mixed ones unless already started.
  const kept = (week.props || []).filter((p) => !p.auto || anyStarted(p));
  const keptKeys = new Set(kept.filter((p) => p.auto).map(keyOf));

  const open = week.games.filter((g) => !started(g.id));
  const byGame = new Map();
  candidates.forEach((c) => {
    const m = matchProp(c, open);
    if (m) { if (!byGame.has(m.game.id)) byGame.set(m.game.id, []); byGame.get(m.game.id).push({ ...c, team: m.team, gameId: m.game.id }); }
  });
  const fresh = [];
  open.filter((g) => !pooled(g) && !keptKeys.has(g.id) && byGame.has(g.id)).forEach((g) => {
    const p = pickGameParlay(g, byGame.get(g.id)); if (p) fresh.push(p);
  });
  const weekend = open.filter((g) => pooled(g) && byGame.has(g.id));
  const pool = weekend.flatMap((g) => byGame.get(g.id));
  MIX.filter((m) => !keptKeys.has(m.key)).forEach((m) => { const p = pickMixParlay(m, weekend, pool); if (p) fresh.push(p); });

  // Weekend mixes sort together (at the weekend's first kickoff) so they stay in tier order.
  const weekendStart = Math.min(...week.games.filter(pooled).map((g) => Date.parse(g.start)));
  const first = (p) => (String(p.key).startsWith("mix-") ? weekendStart : Math.min(...games(p).map((id) => Date.parse(gameById.get(id)?.start || 0))));
  const order = (p) => MIX.findIndex((m) => m.key === p.key);
  // Parlays still to play first (soonest first), then finished ones; hand-entered parlays stay on top.
  const manual = kept.filter((p) => !p.auto), auto = [...kept.filter((p) => p.auto), ...fresh];
  auto.sort((x, y) => (anyStarted(x) - anyStarted(y)) || first(x) - first(y) || order(x) - order(y));
  return [...manual, ...auto];
}

// Every prop leg the app has suggested this week, by Kalshi ticker, so bets logged from an
// earlier version of a parlay still get live prices and results after a re-price.
export function trackMarkets(week) {
  week.markets ||= {};
  (week.props || []).forEach((p) => (p.legs || []).forEach((l) => {
    if (!l.ticker) return;
    const m = (week.markets[l.ticker] ||= { game: l.game, player: l.player, bet: l.bet, prob: l.prob, result: null });
    if (l.result && !m.result) m.result = l.result;
  }));
  return week.markets;
}

const fetchMarketsBatch = async (tickers) => {
  const out = [];
  for (let i = 0; i < tickers.length; i += 50) {
    const j = await getJSON(`${API}/markets?tickers=${tickers.slice(i, i + 50).map(encodeURIComponent).join(",")}&limit=100`);
    out.push(...(j.markets || []));
  }
  return out;
};

// For games underway or finished: save each tracked market's live price (percent) and, once
// Kalshi settles it, the result; copy both onto the matching parlay legs. Returns legs graded.
export async function gradeProps(week, fetchMarkets = fetchMarketsBatch, now = new Date()) {
  const markets = trackMarkets(week);
  const status = (id) => week.games.find((g) => g.id === id)?.status;
  const due = Object.keys(markets).filter((t) => !markets[t].result && status(markets[t].game) && status(markets[t].game) !== "upcoming");
  let n = 0;
  if (due.length) {
    let fetched = [];
    try { fetched = await fetchMarkets(due); } catch (e) { return 0; }   // try again next run
    fetched.forEach((km) => {
      const m = markets[km.ticker]; if (!m) return;
      if (km.result === "yes" || km.result === "no") { m.result = km.result === "yes" ? "hit" : "miss"; n++; delete m.live; return; }
      const bid = cents(km.yes_bid_dollars), ask = cents(km.yes_ask_dollars), last = cents(km.last_price_dollars);
      const live = bid != null && ask != null && ask > 0 ? Math.round((bid + ask) / 2) : last;
      if (live != null) { m.live = live; m.liveAt = now.toISOString(); }
    });
  }
  (week.props || []).forEach((p) => (p.legs || []).forEach((l) => {
    const m = l.ticker && markets[l.ticker]; if (!m) return;
    if (m.result) { l.result = m.result; delete l.live; } else if (m.live != null) l.live = m.live;
  }));
  return n;
}
