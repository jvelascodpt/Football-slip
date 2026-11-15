// Turns parsed source data into a week file. Pure: no network, no file system.
import { TEAMS, consensusAwayProb, gameId, impliedFromAmerican, noVig, suggestParlays, EDGE_BAND } from "../js/core.js";
import { kalshiFor, oddsFor } from "./sources.mjs";

const nick = (t) => TEAMS[t] || t;

export const fmtKick = (iso) =>
  new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", weekday: "short", hour: "numeric", minute: "2-digit" })
    .format(new Date(iso)).replace(",", "");

export function fmtUpdated(date) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles", weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  }).formatToParts(date).map((x) => [x.type, x.value]));
  return `${p.weekday} ${p.month} ${p.day}, ${p.hour}:${p.minute} ${p.dayPeriod} PT`;
}

// Estimated away-win probability (0-1) and where it came from.
export function estimate(g, { odds = [], kalshi = [] } = {}) {
  const o = oddsFor(g, odds);
  if (o && o.pairs.length) {
    const p = consensusAwayProb(o.pairs);
    if (p != null) return { p, source: `${o.pairs.length} sportsbook${o.pairs.length > 1 ? "s" : ""}` };
  }
  if (g.ml) {
    const nv = noVig(impliedFromAmerican(g.ml[0]), impliedFromAmerican(g.ml[1]));
    if (nv) return { p: nv[0], source: g.mlBook || "Sportsbook" };
  }
  const k = kalshiFor(g, kalshi);
  if (k) return { p: k[0] / (k[0] + k[1]), source: "Kalshi" };
  return null;
}

function lastWeekLine(team, last) {
  const r = last?.[team];
  if (!r) return null;
  const verb = r.us > r.them ? "beat" : r.us < r.them ? "lost to" : "tied";
  const hi = Math.max(r.us, r.them), lo = Math.min(r.us, r.them);
  return `${nick(team)} ${verb} the ${nick(r.opp)} ${hi}-${lo}`;
}

export function buildNote(g, { last } = {}) {
  const parts = [];
  if (g.record?.[0] && g.record?.[1]) parts.push(`${nick(g.away)} ${g.record[0]}, ${nick(g.home)} ${g.record[1]}.`);
  const lines = [lastWeekLine(g.away, last), lastWeekLine(g.home, last)].filter(Boolean);
  if (lines.length) parts.push(`Last week: ${lines.join("; ")}.`);
  if (g.prob < 55) parts.push("Close to a coin flip.");
  if (g.kalshi) {
    const [ka, kh] = g.kalshi;
    const estA = g.pick === g.away ? g.prob : 100 - g.prob;
    const valueA = estA - ka, valueH = 100 - estA - kh;
    if (valueA > EDGE_BAND * 100) parts.push(`Kalshi sells the ${nick(g.away)} at ${ka}%, cheaper than the ${estA}% estimate.`);
    else if (valueH > EDGE_BAND * 100) parts.push(`Kalshi sells the ${nick(g.home)} at ${kh}%, cheaper than the ${100 - estA}% estimate.`);
    else parts.push(`Kalshi has the ${nick(g.pick)} at ${g.pick === g.away ? ka : kh}%.`);
  }
  return parts.join(" ") || `${nick(g.pick)} favored per ${g.source}.`;
}

const SCORE_FIELDS = ["status", "score", "live", "kick", "start"];

// Build (or refresh) a week. Games that already kicked off keep the pick they had in
// `existing`, or get no pick if they had none. Placed bets ("tickets") are always kept.
export function buildWeek({ season, week, games, last = {}, odds = [], kalshi = [], existing = null, now = new Date() }) {
  const old = new Map((existing?.games || []).map((g) => [g.id, g]));
  const out = games
    .slice()
    .sort((a, b) => Date.parse(a.start) - Date.parse(b.start))
    .map((src) => {
      const id = gameId(week, src.away, src.home);
      const base = { id, away: src.away, home: src.home, start: src.start, kick: fmtKick(src.start), status: src.status };
      if (src.score) base.score = src.score;
      if (src.live) base.live = src.live;
      if (src.record?.some(Boolean)) base.record = src.record;
      const prev = old.get(id);
      if (src.status !== "upcoming" || Date.parse(src.start) <= now.getTime()) {
        if (prev) {
          const keep = { ...prev };
          SCORE_FIELDS.forEach((f) => delete keep[f]);
          return { ...keep, ...base, record: prev.record || base.record };
        }
        return { ...base, pick: null, prob: null, note: "Already underway when picks were made, so it does not count in the record." };
      }
      const est = estimate(src, { odds, kalshi });
      if (!est) return { ...base, pick: null, prob: null, note: "No moneyline posted yet." };
      const pick = est.p > 0.5 ? src.away : src.home;
      const g = { ...base, pick, prob: Math.round(Math.max(est.p, 1 - est.p) * 100), source: est.source };
      const k = kalshiFor(src, kalshi);
      if (k) g.kalshi = k;
      g.note = buildNote(g, { last });
      return g;
    });

  const started = (legs) => legs.some(([id]) => out.find((g) => g.id === id)?.status !== "upcoming");
  const keepParlays = existing?.parlays?.length && existing.parlays.some((p) => started(p.legs));
  return {
    season,
    week,
    updated: fmtUpdated(now),
    games: out,
    parlays: keepParlays ? existing.parlays : suggestParlays(out),
    tickets: existing?.tickets || [],
  };
}

// Refresh status/score/live for games in an existing week. Returns the number of games changed.
export function applyScores(weekObj, games) {
  let changed = 0;
  games.forEach((src) => {
    const g = weekObj.games.find((x) => x.id === gameId(weekObj.week, src.away, src.home));
    if (!g) return;
    const before = JSON.stringify([g.status, g.score, g.live]);
    g.status = src.status;
    if (src.score) g.score = src.score; else delete g.score;
    if (src.live) g.live = src.live; else delete g.live;
    if (JSON.stringify([g.status, g.score, g.live]) !== before) changed++;
  });
  return changed;
}
