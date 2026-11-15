import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseEspn, parseKalshi, parseOddsApi, resultsByTeam, kalshiFor } from "../scripts/sources.mjs";
import { buildWeek, applyScores, fmtKick, fmtUpdated, estimate } from "../scripts/build.mjs";

const fx = (n) => JSON.parse(readFileSync(new URL(`./fixtures/${n}`, import.meta.url), "utf8"));
const w10 = parseEspn(fx("espn-2026-w10.json"));
const w9 = parseEspn(fx("espn-2026-w9.json"));
const kalshi = parseKalshi(fx("kalshi-open.json"));

test("ESPN parsing maps team codes, status, scores and moneylines", () => {
  assert.equal(w10.length, 14);
  const kc = w10.find((g) => g.away === "KC");
  assert.equal(kc.home, "ATL");
  assert.equal(kc.status, "upcoming");
  assert.deepEqual(kc.ml, ["-175", "+145"]);
  assert.deepEqual(kc.record, ["6-2", "3-6"]);
  const was = w10.find((g) => g.away === "WAS");
  assert.equal(was.status, "final");
  assert.deepEqual(was.score, [24, 21]);
  const live = w10.find((g) => g.away === "NE");
  assert.equal(live.status, "live");
  assert.match(live.live, /qtr/);
  assert.ok(w10.some((g) => g.away === "LA" && g.home === "ARI"));
  assert.ok(w10.some((g) => g.away === "JAC"));
});

test("Kalshi parsing groups both teams per game and matches by date", () => {
  const pitcin = kalshi.find((k) => k.prices.PIT != null && k.prices.CIN != null);
  assert.equal(pitcin.date, "2026-11-15");
  const g = w10.find((x) => x.away === "PIT");
  assert.deepEqual(kalshiFor(g, kalshi), [pitcin.prices.PIT, pitcin.prices.CIN]);
  // A game the following week between the same teams must not match.
  assert.equal(kalshiFor({ ...g, start: "2026-12-20T18:00:00Z" }, kalshi), null);
});

test("The Odds API parsing and multi-book consensus wins over a single book", () => {
  const odds = parseOddsApi([{
    commence_time: "2026-11-15T18:00:00Z", home_team: "Atlanta Falcons", away_team: "Kansas City Chiefs",
    bookmakers: [
      { markets: [{ key: "h2h", outcomes: [{ name: "Kansas City Chiefs", price: -150 }, { name: "Atlanta Falcons", price: 130 }] }] },
      { markets: [{ key: "h2h", outcomes: [{ name: "Kansas City Chiefs", price: -160 }, { name: "Atlanta Falcons", price: 135 }] }] },
    ],
  }]);
  assert.equal(odds[0].away, "KC");
  const kc = w10.find((g) => g.away === "KC");
  const e = estimate(kc, { odds });
  assert.equal(e.source, "2 sportsbooks");
  assert.ok(e.p > 0.58 && e.p < 0.61);
  assert.equal(estimate(kc, {}).source, "DraftKings");
});

test("buildWeek: picks, tiers input, notes, parlays; started games get no pick", () => {
  const now = new Date("2026-11-15T16:00:00Z");
  const w = buildWeek({ season: 2026, week: 10, games: w10, last: resultsByTeam(w9), kalshi, now });
  assert.equal(w.games.length, 14);
  const kc = w.games.find((g) => g.id === "w10-kc-atl");
  assert.equal(kc.pick, "KC");
  assert.equal(kc.prob, 61);
  assert.equal(kc.kick, "Sun 10:00 AM");
  assert.match(kc.note, /Chiefs beat the Jets 35-12/);
  assert.match(kc.note, /Falcons lost to the Bengals 34-17/);
  const ne = w.games.find((g) => g.id === "w10-ne-det");
  assert.equal(ne.pick, null);
  assert.equal(w.parlays.length, 3);
  assert.ok(w.parlays.every((p) => p.legs.every(([id]) => w.games.find((g) => g.id === id).status === "upcoming")));
  assert.deepEqual(w.tickets, []);
});

test("buildWeek refresh keeps picks for started games and keeps placed bets", () => {
  const before = new Date("2026-11-10T16:00:00Z");
  const earlier = buildWeek({ season: 2026, week: 10, games: w10.map((g) => ({ ...g, status: "upcoming", score: undefined, live: undefined })), now: before });
  earlier.tickets = [{ id: "t1", name: "x", legs: [["w10-kc-atl", "KC"]], cost: 10, payout: 20 }];
  const ne = earlier.games.find((g) => g.id === "w10-ne-det");
  ne.note = "hand edited";
  const refreshed = buildWeek({ season: 2026, week: 10, games: w10, existing: earlier, now: new Date("2026-11-15T16:00:00Z") });
  const ne2 = refreshed.games.find((g) => g.id === "w10-ne-det");
  assert.equal(ne2.note, "hand edited");
  assert.equal(ne2.pick, ne.pick);
  assert.equal(ne2.status, "live");
  assert.equal(refreshed.tickets.length, 1);
  // A suggested parlay containing a started game would be kept, not replaced.
  earlier.parlays = [{ name: "p", legs: [["w10-ne-det", "DET"]] }];
  const r2 = buildWeek({ season: 2026, week: 10, games: w10, existing: earlier, now: new Date("2026-11-15T16:00:00Z") });
  assert.deepEqual(r2.parlays, earlier.parlays);
});

test("applyScores fills in finals", () => {
  const week = { week: 10, games: [{ id: "w10-was-nyg", status: "upcoming" }, { id: "w10-kc-atl", status: "upcoming" }] };
  assert.equal(applyScores(week, w10), 1);
  assert.deepEqual(week.games[0].score, [24, 21]);
  assert.equal(week.games[0].status, "final");
  assert.equal(applyScores(week, w10), 0);
});

test("time formatting in Pacific time", () => {
  assert.equal(fmtKick("2026-11-16T01:20:00Z"), "Sun 5:20 PM");
  assert.equal(fmtUpdated(new Date("2026-11-15T16:00:00Z")), "Sun Nov 15, 8:00 AM PT");
});
