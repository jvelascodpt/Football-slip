import { test } from "node:test";
import assert from "node:assert/strict";
import {
  impliedFromAmerican, noVig, consensusAwayProb, tierOf, probFor, parlayProb, parlayState, verdict,
  pickRecord, betsNet, suggestParlays, cleanBets, teamCode, winner,
} from "../js/core.js";

const close = (a, b, eps = 1e-4) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

test("american odds to implied probability", () => {
  close(impliedFromAmerican(-175), 175 / 275);
  close(impliedFromAmerican("+145"), 100 / 245);
  close(impliedFromAmerican("-110"), 110 / 210);
  assert.equal(impliedFromAmerican("EVEN"), null);
  assert.equal(impliedFromAmerican(50), null);
});

test("no-vig removes the margin so the two sides sum to 100%", () => {
  const [a, h] = noVig(impliedFromAmerican(-175), impliedFromAmerican(145));
  close(a + h, 1);
  close(a, 0.6085, 1e-3); // KC at ATL, week 10: 63.6% / 40.8% with margin -> 60.9% / 39.1%
  const [x, y] = noVig(impliedFromAmerican(-110), impliedFromAmerican(-110));
  close(x, 0.5); close(y, 0.5);
});

test("consensus averages books and skips bad pairs", () => {
  close(consensusAwayProb([[-110, -110], [-150, 130], ["n/a", 100]]), (0.5 + noVig(0.6, 100 / 230)[0]) / 2);
  assert.equal(consensusAwayProb([]), null);
});

test("tiers: Lock 72+, Lean 60-71, Coin flip under 60", () => {
  assert.equal(tierOf(72)[1], "Lock");
  assert.equal(tierOf(71)[1], "Lean");
  assert.equal(tierOf(60)[1], "Lean");
  assert.equal(tierOf(59)[1], "Coin flip");
});

const games = [
  { id: "a", away: "BUF", home: "NYJ", pick: "BUF", prob: 80, status: "final", score: [30, 10] },
  { id: "b", away: "MIA", home: "IND", pick: "IND", prob: 67, status: "final", score: [24, 20] },
  { id: "c", away: "KC", home: "ATL", pick: "KC", prob: 62, status: "upcoming" },
  { id: "d", away: "LA", home: "ARI", pick: "LA", prob: 83, status: "live", score: [7, 0] },
];
const find = (id) => games.find((g) => g.id === id);

test("leg and parlay probabilities", () => {
  close(probFor(find("c"), "KC"), 0.62);
  close(probFor(find("c"), "ATL"), 0.38);
  close(parlayProb([["a", "BUF"], ["c", "KC"]], find), 0.8 * 0.62);
  assert.equal(winner(find("b")), "MIA");
});

test("parlay state", () => {
  assert.equal(parlayState([["a", "BUF"]], find), "hit");
  assert.equal(parlayState([["a", "BUF"], ["b", "IND"]], find), "miss");
  assert.equal(parlayState([["a", "BUF"], ["d", "LA"]], find), "live");
  assert.equal(parlayState([["c", "KC"]], find), "pending");
});

test("verdict uses a +/- 2 point band around break-even", () => {
  // $10 paying $26.73 -> break-even 37.4%
  assert.equal(verdict(0.40, 10, 26.73).kind, "good");
  assert.equal(verdict(0.38, 10, 26.73).kind, "fair");
  assert.equal(verdict(0.35, 10, 26.73).kind, "poor");
  close(verdict(0.4, 10, 26.73).breakEven, 10 / 26.73);
  assert.equal(verdict(0.5, 10, 9), null);
});

test("records and bet net", () => {
  assert.deepEqual(pickRecord(games), { h: 1, m: 1, p: 2 });
  const r = betsNet([
    { legs: [["a", "BUF"]], cost: 10, payout: 12.5 },
    { legs: [["b", "IND"]], cost: 5, payout: 7 },
    { legs: [["c", "KC"]], cost: 3, payout: 5 },
  ], find);
  close(r.net, 2.5 - 5);
  assert.equal(r.open, 1);
});

test("suggested parlays: safest, medium, long shot from games still to play", () => {
  const g = [90, 85, 80, 75, 70, 65, 55, 52].map((p, i) => ({ id: "g" + i, away: "A" + i, home: "H" + i, pick: "H" + i, prob: p, status: "upcoming" }));
  g.push({ id: "done", away: "X", home: "Y", pick: "Y", prob: 95, status: "final", score: [0, 1] });
  const [safe, med, dog] = suggestParlays(g);
  assert.deepEqual(safe.legs.map((l) => l[0]), ["g0", "g1", "g2"]);
  assert.equal(med.legs.length, 5);
  assert.deepEqual(dog.legs, [["g7", "A7"], ["g6", "A6"]]);
});

test("team code aliases", () => {
  assert.equal(teamCode("WSH"), "WAS");
  assert.equal(teamCode("jax"), "JAC");
  assert.equal(teamCode("LAR"), "LA");
  assert.equal(teamCode("KC"), "KC");
});

test("cleanBets drops malformed entries", () => {
  const out = cleanBets([
    { id: "x", season: 2026, week: 10, legs: [["w10-a-b", "A"]], cost: 10, payout: 20, name: "ok" },
    { season: 2026, week: 10, legs: [], cost: 10, payout: 20 },
    { season: "2026", week: 10, legs: [["w10-a-b", "A"]], cost: -1, payout: 20 },
    null, "junk",
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].name, "ok");
  assert.deepEqual(cleanBets({ not: "an array" }), []);
});
