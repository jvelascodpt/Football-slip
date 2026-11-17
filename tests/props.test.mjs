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
  assert.equal(jt.bet, "40+ rushing yards");   // 67% is closer to 72% than 81%
  assert.equal(jt.prob, 67);
  assert.match(jt.why, /Team leader in rushing/);
  assert.equal(p.tag, "Thu");
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

test("gradeProps fills results from settled Kalshi markets for games underway or final", async () => {
  const week = { games: [{ ...game, status: "final" }], props: [{ auto: true, game: game.id, legs: [
    { game: game.id, ticker: "A", result: null }, { game: game.id, ticker: "B", result: null }, { game: game.id, ticker: "C", result: null },
  ] }] };
  const n = await gradeProps(week, async (t) => ({ A: { result: "yes" }, B: { result: "no" }, C: { result: "" } })[t]);
  assert.equal(n, 2);
  assert.deepEqual(week.props[0].legs.map((l) => l.result), ["hit", "miss", null]);
});
