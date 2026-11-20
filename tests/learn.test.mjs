import { test } from "node:test";
import assert from "node:assert/strict";
import { collectLegs, summarize, parlayRecord, buildLearning, mlBucket, propStat, mlAdj, propAdj, MIN_N } from "../scripts/learn.mjs";
import { parlayState } from "../js/core.js";

const g = (id, pick, prob, score, away = "A", home = "H") => ({ id, away, home, pick, prob, status: "final", score });
const week = {
  week: 10,
  games: [g("g1", "H", 80, [10, 20]), g("g2", "H", 80, [30, 20]), g("g3", "A", 55, [21, 14]), { id: "g4", away: "A", home: "H", pick: "H", prob: 90, status: "upcoming" }],
  parlays: [{ name: "Safe three", legs: [["g1", "H"], ["g3", "A"]] }, { name: "Underdog swing", legs: [["g2", "A"]] }],
  props: [{ auto: true, key: "g1", tag: "Thu · Safe", legs: [{ game: "g1", ticker: "T1", prob: 80, result: "hit" }, { game: "g1", ticker: "T2", prob: 80, result: "miss" }] }],
  markets: { T1: { game: "g1", bet: "40+ receiving yards", prob: 80, result: "hit" }, T2: { game: "g1", bet: "200+ passing yards", prob: 80, result: "miss" }, T3: { game: "g4", bet: "2+ receptions", prob: 70, result: null } },
};
const byId = new Map(week.games.map((x) => [x.id, x]));
const find = (id) => byId.get(id);

test("buckets and stat names", () => {
  assert.equal(mlBucket(91), "85+"); assert.equal(mlBucket(72), "72-84"); assert.equal(mlBucket(59), "50-59");
  assert.equal(propStat("40+ receiving yards"), "receiving yards");
  assert.equal(propStat("nonsense"), null);
});

test("collects settled legs only", () => {
  const { ml, props } = collectLegs([week]);
  assert.equal(ml.length, 3);   // g4 not final
  assert.deepEqual(ml.map((l) => l.hit), [true, false, true]);
  assert.equal(props.length, 2);   // T3 unsettled
});

test("no adjustment until there is enough evidence, then a shrunken, capped one", () => {
  const few = summarize(Array.from({ length: MIN_N - 1 }, () => ({ key: "k", p: 0.7, hit: true })));
  assert.equal(few.k.adj, 0);
  assert.ok(few.k.gap > 0);
  const many = summarize(Array.from({ length: 100 }, (_, i) => ({ key: "k", p: 0.7, hit: i % 25 < 19 })));   // 76% vs 70% priced
  assert.ok(many.k.adj > 0 && many.k.adj < 6);   // shrunk below the raw 6-point gap
  assert.equal(many.k.adj, 4);   // 6 points x 100 / (100 + 50)
  const extreme = summarize(Array.from({ length: 1000 }, () => ({ key: "k", p: 0.5, hit: true })));
  assert.equal(extreme.k.adj, 6);   // capped
});

test("parlay record by type, with expected wins", () => {
  const r = parlayRecord([week], find, parlayState);
  assert.deepEqual(r["Safe three"], { w: 1, l: 0, expected: 0.44 });
  assert.deepEqual(r["Underdog swing"], { w: 1, l: 0, expected: 0.2 });
  assert.deepEqual(r["Thu night safe bet"], { w: 0, l: 1, expected: 0.64 });
});

test("adjust lookups read the learning file", () => {
  const L = buildLearning([week], find, parlayState);
  assert.equal(mlAdj(L, 81), L.ml["72-84"].adj);
  assert.equal(propAdj(L, "Receiving Yards"), L.props["receiving yards"].adj);
  assert.equal(mlAdj(null, 80), 0);
  assert.equal(propAdj({}, "receptions"), 0);
});
