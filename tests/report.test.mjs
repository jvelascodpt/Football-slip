import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTeamStats, rankTeams, parseSummary, parseTeamNews, keyInjuries, edges, buildReport } from "../scripts/report.mjs";

const stat = (name, value) => ({ name, value });
const teamStats = (gp, pts, yds, oppPts, oppYds, to = 0) => ({ results: {
  stats: { categories: [
    { name: "general", stats: [stat("gamesPlayed", gp)] },
    { name: "scoring", stats: [stat("totalPointsPerGame", pts)] },
    { name: "passing", stats: [stat("yardsPerGame", yds), stat("netPassingYardsPerGame", yds * 0.6)] },
    { name: "rushing", stats: [stat("rushingYardsPerGame", yds * 0.4)] },
    { name: "miscellaneous", stats: [stat("turnOverDifferential", to)] },
  ] },
  opponent: [
    { name: "scoring", stats: [stat("totalPointsPerGame", oppPts)] },
    { name: "passing", stats: [stat("yardsPerGame", oppYds), stat("netPassingYardsPerGame", oppYds * 0.6)] },
    { name: "rushing", stats: [stat("rushingYardsPerGame", oppYds * 0.4)] },
  ],
} });

test("team stats parse and rank: offense high is good, defense low is good", () => {
  const s = parseTeamStats(teamStats(10, 20.8, 304.7, 27.1, 369.9, -12));
  assert.equal(s.ppg, 20.8); assert.equal(s.oppg, 27.1); assert.equal(s.to, -12);
  assert.equal(parseTeamStats({ results: {} }), null);
  const r = rankTeams({
    IND: parseTeamStats(teamStats(10, 20.8, 304, 27.1, 369, -12)),
    HOU: parseTeamStats(teamStats(9, 25.9, 361, 24.3, 365, 4)),
    KC: parseTeamStats(teamStats(9, 25.9, 400, 18.0, 300, 4)),
  });
  assert.deepEqual(r.HOU.ppg, [25.9, 1]);   // tie with KC shares 1st
  assert.deepEqual(r.KC.ppg, [25.9, 1]);
  assert.deepEqual(r.IND.ppg, [20.8, 3]);
  assert.equal(r.KC.oppg[1], 1);            // fewest allowed ranks 1st
  assert.equal(r.IND.oppg[1], 3);
  assert.equal(r.IND.to[1], 3);
});

const summary = {
  leaders: [{ team: { abbreviation: "HOU" }, leaders: [
    { name: "passingYards", leaders: [{ athlete: { displayName: "C.J. Stroud" }, displayValue: "2,462 YDS" }] },
    { name: "rushingYards", leaders: [{ athlete: { displayName: "Woody Marks" }, displayValue: "391 YDS" }] },
  ] }],
  injuries: [{ team: { abbreviation: "HOU" }, injuries: [
    { athlete: { displayName: "Woody Marks", position: { abbreviation: "RB" } }, status: "Doubtful", details: { type: "Concussion", detail: "Not Specified" } },
    { athlete: { displayName: "Danielle Hunter", position: { abbreviation: "DE" } }, status: "Questionable", details: { type: "Hamstring" } },
    { athlete: { displayName: "Backup QB", position: { abbreviation: "QB" } }, status: "Out", details: {} },
    { athlete: { displayName: "Ignored", position: { abbreviation: "WR" } }, status: "Active", details: {} },
  ] }],
  lastFiveGames: [{ team: { abbreviation: "HOU" }, events: [{ gameResult: "W", score: "26-3", atVs: "vs", opponent: { abbreviation: "TEN" } }] }],
  predictor: { homeTeam: { gameProjection: "74.4" }, awayTeam: { gameProjection: "25.4" } },
};

test("summary: injuries, leaders, form and ESPN predictor", () => {
  const s = parseSummary(summary);
  assert.deepEqual(s.fpi, [25.4, 74.4]);
  assert.equal(s.teams.HOU.injuries.length, 3);
  assert.equal(s.teams.HOU.injuries[0].detail, "Concussion");
  assert.deepEqual(s.teams.HOU.form, [{ r: "W", s: "26-3", opp: "TEN", home: true }]);
});

test("injuries that matter: quarterbacks and team stat leaders who are out, doubtful or questionable", () => {
  const s = parseSummary(summary).teams.HOU;
  const k = keyInjuries(s.injuries, s.leaders);
  assert.deepEqual(k.map((i) => [i.name, i.why]), [["Woody Marks", "Team leader in rushing"], ["Backup QB", "Quarterback"]]);
});

test("edges compare each offense with the defense it faces", () => {
  const ranks = { IND: { ppg: [20.8, 23], oppg: [27.1, 29] }, HOU: { ppg: [25.9, 9], oppg: [18.3, 10] } };
  const [a, h] = edges({ away: "IND", home: "HOU" }, ranks);
  assert.match(a, /Colts offense \(23rd in scoring\) vs Texans defense \(10th in points allowed\): edge to the defense/);
  assert.match(h, /edge to the offense/);
  ranks.HOU.oppg = [24.3, 18];
  assert.match(edges({ away: "IND", home: "HOU" }, ranks)[0], /even matchup/);
  assert.deepEqual(edges({ away: "IND", home: "HOU" }, {}), []);
});

test("team news keeps recent team-specific stories only", () => {
  const now = new Date("2026-11-17T16:00:00Z");
  const team = (id) => ({ type: "team", teamId: id });
  const n = parseTeamNews({ articles: [
    { headline: "League roundup", categories: [team(1), team(2), team(3)], published: "2026-11-17T10:00:00Z" },
    { headline: "Texans D struggles", type: "Media", categories: [team(34)], published: "2026-11-16T10:00:00Z", links: { web: { href: "https://x" } } },
    { headline: "Old story", categories: [team(34)], published: "2026-11-01T10:00:00Z" },
  ] }, now);
  assert.deepEqual(n.map((x) => x.h), ["Texans D struggles"]);
  assert.equal(n[0].video, true);
});

test("buildReport sorts injuries by severity and survives missing data", () => {
  const r = buildReport({ away: "IND", home: "HOU" }, { summary: parseSummary(summary), ranks: null, news: {} }, new Date("2026-11-17T16:00:00Z"));
  assert.deepEqual(r.teams.HOU.injuries.map((i) => i.status), ["Out", "Doubtful", "Questionable"]);
  assert.deepEqual(r.teams.IND.injuries, []);
  assert.deepEqual(r.edges, []);
  assert.deepEqual(r.fpi, [25.4, 74.4]);
});
