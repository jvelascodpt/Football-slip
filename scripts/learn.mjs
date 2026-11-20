// Learning from settled results. Each week, compare how often each kind of leg actually hit with
// the price it was picked at, and turn that into a small, evidence-weighted adjustment used to rank
// future picks. Pure functions; tested in tests/learn.test.mjs. Writes data/learning.json.
import { winner } from "../js/core.js";

// Shrinkage: an adjustment needs evidence. Nothing moves until a kind of leg has MIN_N settled
// results; after that the raw gap (actual - priced) is scaled by n / (n + PRIOR), so 10 legs
// count for a sixth of the gap, 50 for half, 150 for three quarters.
export const PRIOR = 50;
export const MIN_N = 8;
// Never move a pick's ranking by more than this many points, however strong the evidence.
export const MAX_ADJ = 6;

export const ML_BUCKETS = [["85+", 85, 101], ["72-84", 72, 85], ["60-71", 60, 72], ["50-59", 0, 60]];
export const mlBucket = (p) => ML_BUCKETS.find(([, lo, hi]) => p >= lo && p < hi)[0];
const STAT = /^\d+(?:\.\d+)?\+\s+(.+)$/;
export const propStat = (bet) => (STAT.exec(bet || "") || [])[1]?.toLowerCase() || null;

// Settled legs from every week: moneyline picks (by price bucket) and prop legs (by stat type).
export function collectLegs(weeks) {
  const ml = [], props = [];
  weeks.forEach((w) => {
    w.games.forEach((g) => {
      if (!g.pick || g.prob == null || g.status !== "final" || !winner(g)) return;
      ml.push({ key: mlBucket(g.prob), p: g.prob / 100, hit: winner(g) === g.pick });
    });
    Object.values(w.markets || {}).forEach((m) => {
      const stat = propStat(m.bet);
      if (!stat || m.prob == null || !(m.result === "hit" || m.result === "miss")) return;
      props.push({ key: stat, p: m.prob / 100, hit: m.result === "hit" });
    });
  });
  return { ml, props };
}

export function summarize(legs) {
  const out = {};
  legs.forEach((l) => {
    const s = (out[l.key] ||= { n: 0, hits: 0, expected: 0 });
    s.n++; s.hits += l.hit ? 1 : 0; s.expected += l.p;
  });
  Object.values(out).forEach((s) => {
    s.expected = Math.round(s.expected * 100) / 100;
    const gapPts = ((s.hits - s.expected) / s.n) * 100;
    s.gap = Math.round(gapPts * 10) / 10;
    s.adj = s.n < MIN_N ? 0 : Math.round(Math.max(-MAX_ADJ, Math.min(MAX_ADJ, gapPts * (s.n / (s.n + PRIOR)))) * 10) / 10;
  });
  return out;
}

// Record of every parlay Claude recommended, by type. Prop parlays count once locked (the version
// that was live at its first kickoff); suggested moneyline parlays count as built.
export function parlayRecord(weeks, findGame, parlayState) {
  const rec = {};
  const add = (type, legs, chance) => {
    const s = parlayState(legs, findGame);
    if (s !== "hit" && s !== "miss") return;
    const r = (rec[type] ||= { w: 0, l: 0, expected: 0 });
    s === "hit" ? r.w++ : r.l++;
    r.expected = Math.round((r.expected + chance) * 100) / 100;
  };
  weeks.forEach((w) => {
    (w.parlays || []).forEach((p) => {
      const chance = p.legs.reduce((a, [id, t]) => { const g = findGame(id); return a * (g?.prob == null ? 0.5 : (t === g.pick ? g.prob : 100 - g.prob) / 100); }, 1);
      add(p.name, p.legs, chance);
    });
    (w.props || []).filter((p) => p.auto).forEach((p) => {
      const legs = p.legs.map((l) => ({ ...l, kind: "prop" }));
      const type = p.key && String(p.key).startsWith("mix-") ? p.name.replace(/^(Saturday|Sunday) /, "Weekend ") : `${(p.tag || "").split(" ")[0]} night safe bet`;
      add(type, legs, legs.reduce((a, l) => a * ((l.prob ?? 50) / 100), 1));
    });
  });
  return rec;
}

export function buildLearning(weeks, findGame, parlayState, now = new Date()) {
  const { ml, props } = collectLegs(weeks);
  return {
    updated: now.toISOString(),
    weeks: weeks.map((w) => w.week),
    prior: PRIOR, minN: MIN_N, maxAdj: MAX_ADJ,
    ml: summarize(ml),
    props: summarize(props),
    parlays: parlayRecord(weeks, findGame, parlayState),
  };
}

// Adjustment (in percentage points) to apply when ranking a pick or a prop leg.
export const mlAdj = (learning, prob) => learning?.ml?.[mlBucket(prob)]?.adj || 0;
export const propAdj = (learning, stat) => learning?.props?.[String(stat || "").toLowerCase()]?.adj || 0;
