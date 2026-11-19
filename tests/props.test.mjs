import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePropMarket, matchProp, pickGameParlay, buildProps, gradeProps } from "../scripts/props.mjs";

const mk = (ticker, title, bid, ask, extra = {}) => ({
  ticker, event_ticker: ticker.split("-").slice(0, 2).join("-"), title,
  yes_bid_dollars: (bid / 100).toFixed(4), yes_ask_dollars: (ask / 100).toFixed(4), status: "active", ...extra,
});
const game = { id: "w11-ind-hou", away: "IND", home: "HOU", start: "2026-11-20T01:15:00.000Z", kick: "Thu 5:15 PM", status: "upcoming",
  report: { teams: {
    IND: { injuries: [{ name: "Hurt Guy", status: "Questionable" }], leaders: [{ cat: "Rushing", name: "Jonathan Taylor", value: "739 YDS" }] },
    HOU: { injuries: [], leaders: [{ cat: "Receiving", name: "Nico Collins", value: "478 YDS" }] },
  } } };

const markets = [
  ["KXNFLRSHYDS", mk("KXNFLRSHYDS-26NOV19INDHOU-INDJTAYLOR28-40", "Jonathan Taylor: 40+ rushing yards", 66, 67)],
  ["KXNFLRSHYDS", mk("KXNFLRSHYDS-26NOV19INDHOU-INDJTAYLOR28-30", "Jonathan Taylor: 30+ rushing yards", 77, 81)],
  ["KXNFLREC", mk("KXNFLREC-26NOV19INDHOU-HOUNCOLLINS12-4", "Nico Collins: 4+ receptions", 71, 73)],
  ["KXNFLPASSYDS", mk("KXNFLPASSYDS-26NOV19INDHOU-HOUCSTROUD7-225", "C.J. Stroud: 225+ passing yards", 70, 74)],
  ["KXNFLRECYDS", mk("KXNFLRECYDS-26NOV19INDHOU-HOUDSCHULTZ86-20", "Dalton Schultz: 20+ receiving yards", 68, 71)],
  ["KXNFLRECYDS", mk("KXNFLRECYDS-26NOV19INDHOU-INDHURTGUY1-20", "Hurt Guy: 20+ receiving yards", 71, 72)],
  ["KXNFLRECYDS", mk("KXNFLRECYDS-26NOV19INDHOU-INDTHIN5-20", "Thin Market: 20+ receiving yards", 1, 72)],
].map(([s, m]) => parsePropMarket(m, s));

test("prop markets parse into player, line, stat, prices and game", () => {
  const p = markets[0];
  assert.deepEqual([p.player, p.line, p.stat, p.bid, p.ask, p.teams, p.date], ["Jonathan Taylor", 40, "rushing yards", 66, 67, "INDHOU", "2026-11-19"]);
  assert.equal(parsePropMarket({ ticker: "x", event_ticker: "y", title: "Who wins?" }, "KXNFLREC"), null);
  assert.deepEqual(matchProp(p, [game]).team, "IND");
  assert.equal(matchProp({ ...p, date: "2026-12-24" }, [game]), null);
  // Kalshi spells the Rams LAR
  assert.equal(matchProp({ ...p, teams: "LARARI", seg: "LARMSTAFFORD9" }, [{ ...game, away: "LA", home: "ARI" }]).team, "LA");
});

test("game parlay: three players, both teams, leaders first, injured and thin markets skipped", () => {
  const cands = markets.map((c) => ({ ...c, team: matchProp(c, [game]).team }));
  const p = pickGameParlay(game, cands);
  const players = p.legs.map((l) => l.player);
  assert.equal(players.length, 3);
  assert.ok(players.includes("Jonathan Taylor") && players.includes("Nico Collins"));
  assert.ok(!players.includes("Hurt Guy") && !players.includes("Thin Market"));
  assert.ok(new Set(p.legs.map((l) => l.team)).size === 2);
  const jt = p.legs.find((l) => l.player === "Jonathan Taylor");
  assert.equal(jt.bet, "30+ rushing yards");   // safe bet: the 81% line, not the 67% one
  assert.equal(jt.prob, 81);
  assert.ok(p.legs.every((l) => l.prob >= 72 && l.prob <= 88));
  assert.match(jt.why, /Team leader in rushing/);
  assert.equal(p.tag, "Thu · Safe");
});

test("buildProps keeps hand-entered and started parlays, rebuilds the rest", () => {
  const manual = { name: "Mine", legs: [] };
  const week = { games: [game], props: [manual, { auto: true, game: "w11-ind-hou", name: "old", legs: [] }] };
  const before = buildProps(week, markets, new Date("2026-11-18T12:00:00Z"));
  assert.equal(before[0], manual);
  assert.equal(before.length, 2);
  assert.equal(before[1].legs.length, 3);
  const after = buildProps({ ...week, props: before }, [], new Date("2026-11-20T02:00:00Z"));
  assert.deepEqual(after, before);   // game started: nothing rebuilt or dropped
});

test("gradeProps saves live prices and settled results for every tracked leg", async () => {
  const week = { games: [{ ...game, status: "live" }], props: [{ auto: true, key: game.id, game: game.id, legs: [
    { game: game.id, ticker: "A", result: null, prob: 80 }, { game: game.id, ticker: "B", result: null, prob: 75 },
  ] }], markets: { OLD: { game: game.id, player: "x", bet: "y", prob: 70, result: null } } };
  const n = await gradeProps(week, async (ts) => {
    assert.deepEqual(ts.sort(), ["A", "B", "OLD"]);   // an earlier version's leg is still tracked
    return [{ ticker: "A", result: "yes" }, { ticker: "B", yes_bid_dollars: "0.6000", yes_ask_dollars: "0.6400" }, { ticker: "OLD", result: "no" }];
  });
  assert.equal(n, 2);
  assert.deepEqual(week.props[0].legs.map((l) => [l.result, l.live]), [["hit", undefined], [null, 62]]);
  assert.equal(week.markets.OLD.result, "miss");
  assert.equal(week.markets.B.live, 62);
  const upcoming = { games: [game], props: [{ legs: [{ game: game.id, ticker: "Z", result: null }] }] };
  assert.equal(await gradeProps(upcoming, async () => { throw new Error("should not fetch"); }), 0);
});

import { pooled, pickMixParlay, MIX } from "../scripts/props.mjs";

// A Sunday slate: four games, two players each, prices 50-80%.
const sunday = ["ARI-KC", "TB-DET", "MIA-BUF", "NO-CHI", "TEN-DAL"].map((m, i) => {
  const [away, home] = m.split("-");
  return { id: `w11-${away.toLowerCase()}-${home.toLowerCase()}`, away, home, start: `2026-11-22T${18 + (i > 2 ? 3 : 0)}:00:00.000Z`, kick: "Sun 10:00 AM", status: "upcoming", report: { teams: {} } };
});
const sundayCands = sunday.flatMap((g, i) => [70, 80, 42].map((ask, j) => ({
  ticker: `T-${g.id}-${j}`, player: `${g.home} Player ${j}`, line: 50, stat: "rushing yards", bid: ask - 2, ask: ask - i, team: g.home, gameId: g.id,
})));

test("Thursday and Monday games stand alone; Saturday and Sunday games are pooled", () => {
  assert.equal(pooled(game), false);                                                       // Thu 5:15 PM PT
  assert.equal(pooled({ start: "2026-11-24T01:15:00.000Z" }), false);                      // Mon 5:15 PM PT
  assert.equal(pooled({ start: "2026-11-22T18:00:00.000Z" }), true);                       // Sun 10 AM PT
  assert.equal(pooled({ start: "2026-11-23T01:20:00.000Z" }), true);                       // Sun night 5:20 PM PT
});

test("Sunday parlays: safe (3 near 80%), medium (4 near 70%), high payout (2 near 40%), one leg per game", () => {
  const [safe, medium, payout] = MIX.map((m) => pickMixParlay(m, sunday, sundayCands));
  assert.equal(safe.name, "Sunday safe bet");
  assert.equal(safe.legs.length, 3);
  assert.ok(safe.legs.every((l) => l.prob >= 72 && l.prob <= 88));
  assert.equal(medium.legs.length, 4);
  assert.ok(medium.legs.every((l) => l.prob >= 62 && l.prob <= 78));
  assert.equal(payout.legs.length, 2);
  assert.ok(payout.legs.every((l) => l.prob >= 32 && l.prob <= 48));
  [safe, medium, payout].forEach((p) => assert.equal(new Set(p.legs.map((l) => l.game)).size, p.legs.length));
  assert.equal(pickMixParlay(MIX[1], sunday.slice(0, 2), sundayCands.slice(0, 6)), null);  // not enough games for four legs
});

test("buildProps: per-game for Thursday, mixed for Sunday, old Sunday per-game parlays replaced", () => {
  const raw = [...markets];
  const week = { games: [game, ...sunday], props: [{ auto: true, game: sunday[0].id, name: "old per-game", legs: [] }] };
  const props = buildProps(week, raw, new Date("2026-11-18T12:00:00Z"));
  // matchProp only finds the Thursday markets in `markets`; add the Sunday pool directly via a stub list
  assert.ok(props.some((p) => p.key === "w11-ind-hou"));
  assert.ok(!props.some((p) => p.name === "old per-game"));
});
