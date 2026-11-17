// Pure logic shared by the web app (js/app.js) and the data script (scripts/update.mjs).
// No DOM, no network: everything here is unit-tested in tests/core.test.mjs.

export const TEAMS = {
  ARI: "Cardinals", ATL: "Falcons", BAL: "Ravens", BUF: "Bills", CAR: "Panthers", CHI: "Bears",
  CIN: "Bengals", CLE: "Browns", DAL: "Cowboys", DEN: "Broncos", DET: "Lions", GB: "Packers",
  HOU: "Texans", IND: "Colts", JAC: "Jaguars", KC: "Chiefs", LA: "Rams", LAC: "Chargers",
  LV: "Raiders", MIA: "Dolphins", MIN: "Vikings", NE: "Patriots", NO: "Saints", NYG: "Giants",
  NYJ: "Jets", PHI: "Eagles", PIT: "Steelers", SEA: "Seahawks", SF: "49ers", TB: "Buccaneers",
  TEN: "Titans", WAS: "Commanders",
};

// Other sources spell a few teams differently (ESPN: WSH, JAX, LAR; Kalshi: LAR).
const ALIASES = { WSH: "WAS", JAX: "JAC", LAR: "LA", LVR: "LV", OAK: "LV", SD: "LAC", STL: "LA" };
export const teamCode = (abbr) => {
  const a = String(abbr || "").toUpperCase();
  return ALIASES[a] || a;
};

// ESPN's live status ("11:46 - 3rd", "Halftime", "End of 2nd") -> "3rd qtr 11:46", "Halftime", ...
export function liveText(detail) {
  const m = /^(.*?)\s*-\s*(\d)(st|nd|rd|th)$/.exec(detail || "");
  if (m) return `${m[2]}${m[3]} qtr ${m[1]}`.trim();
  return detail || "";
}

// Apply a live ESPN scoreboard to the loaded weeks. Updates status, score and live text of
// matching games in place and returns how many changed. Never touches picks or odds.
export function applyLiveScoreboard(weeks, espn) {
  const wkNo = espn?.week?.number, w = weeks.find((x) => x.week === wkNo);
  if (!w || !Array.isArray(espn.events)) return 0;
  let changed = 0;
  espn.events.forEach((e) => {
    const c = e.competitions?.[0];
    const a = c?.competitors?.find((x) => x.homeAway === "away"), h = c?.competitors?.find((x) => x.homeAway === "home");
    if (!a || !h) return;
    const g = w.games.find((x) => x.away === teamCode(a.team.abbreviation) && x.home === teamCode(h.team.abbreviation));
    if (!g) return;
    const t = e.status?.type || {};
    const status = t.state === "in" ? "live" : t.state === "post" && t.completed ? "final" : null;
    if (!status) return;   // still scheduled (or postponed): leave the file's view alone
    const before = JSON.stringify([g.status, g.score, g.live]);
    g.status = status;
    g.score = [Number(a.score) || 0, Number(h.score) || 0];
    if (status === "live") g.live = liveText(t.shortDetail); else delete g.live;
    if (JSON.stringify([g.status, g.score, g.live]) !== before) changed++;
  });
  return changed;
}

// Tiers by the pick's win probability (percent).
export const TIERS = [["lock", "Lock", 72], ["lean", "Lean", 60], ["flip", "Coin flip", 0]];
export const tierOf = (p) => TIERS.find((t) => p >= t[2]);

// Verdict band: an offered price is "good"/"poor" when the estimate beats/trails break-even by more than this.
export const EDGE_BAND = 0.02;

/* ---------- odds math ---------- */

// American moneyline -> implied probability including the book's margin.
export function impliedFromAmerican(ml) {
  const n = typeof ml === "string" ? parseFloat(ml.replace(/[^\d.+-]/g, "")) : ml;
  if (!Number.isFinite(n) || n === 0 || Math.abs(n) < 100) return null;
  return n < 0 ? -n / (-n + 100) : 100 / (n + 100);
}

// Remove the margin from a two-way market by normalising the implied probabilities to sum to 1.
export function noVig(impliedA, impliedB) {
  if (!(impliedA > 0) || !(impliedB > 0)) return null;
  const s = impliedA + impliedB;
  return [impliedA / s, impliedB / s];
}

// Average no-vig away-team probability across several books' [awayML, homeML] pairs.
export function consensusAwayProb(pairs) {
  const ps = pairs
    .map(([a, h]) => noVig(impliedFromAmerican(a), impliedFromAmerican(h)))
    .filter(Boolean)
    .map((x) => x[0]);
  if (!ps.length) return null;
  return ps.reduce((a, b) => a + b, 0) / ps.length;
}

/* ---------- games, legs, parlays ---------- */

export const winner = (g) =>
  g.status !== "final" || !g.score || g.score[0] === g.score[1] ? null : g.score[0] > g.score[1] ? g.away : g.home;

// Probability (0-1) that `team` wins game g. g.prob is the pick's probability in percent.
export const probFor = (g, team) => (g.prob == null ? 0.5 : (team === g.pick ? g.prob : 100 - g.prob) / 100);

// A leg is either [gameId, team] (picks, slips, suggested parlays) or an object
// {kind:"team"|"prop", game, team, player?, bet?, odds?, result?: "hit"|"miss"|null}.
export const legGame = (l) => (Array.isArray(l) ? l[0] : l.game);
export const legTeam = (l) => (Array.isArray(l) ? l[1] : l.team);
export const isProp = (l) => !Array.isArray(l) && l.kind === "prop";

// Kickoff has passed or the game is underway/finished.
export const locked = (g, now = Date.now()) => g.status !== "upcoming" || (!!g.start && now >= Date.parse(g.start));

export function legState(findGame) {
  return (leg) => {
    const game = findGame(legGame(leg));
    if (isProp(leg)) return leg.result || (game && locked(game) ? "live" : "pending");
    if (!game) return "pending";
    if (game.status === "final") return winner(game) === legTeam(leg) ? "hit" : "miss";
    return game.status === "live" ? "live" : "pending";
  };
}

export function parlayState(legs, findGame) {
  const s = legs.map(legState(findGame));
  if (s.includes("miss")) return "miss";
  if (s.length && s.every((x) => x === "hit")) return "hit";
  return s.some((x) => x !== "pending") ? "live" : "pending";
}

// Progress toward a parlay hitting (0-1): a hit leg counts 1; a live team leg counts .5 if
// leading, .25 if tied; a live prop leg counts its optional `progress`. Any miss busts it.
export function parlayProgress(legs, findGame) {
  const st = legs.map(legState(findGame));
  const n = legs.length, hit = st.filter((s) => s === "hit").length, live = st.filter((s) => s === "live").length;
  const bust = st.includes("miss");
  if (!n) return { p: 0, n, hit, live, bust, states: st };
  const one = (l, s) => {
    if (s === "hit") return 1;
    if (s !== "live") return 0;
    if (isProp(l)) return typeof l.progress === "number" ? Math.min(Math.max(l.progress, 0), 0.99) : 0;
    const g = findGame(legGame(l));
    if (!g || !g.score) return 0;
    const t = legTeam(l), us = t === g.away ? g.score[0] : g.score[1], them = t === g.away ? g.score[1] : g.score[0];
    return us > them ? 0.5 : us === them ? 0.25 : 0;
  };
  const p = bust ? 1 : legs.reduce((a, l, i) => a + one(l, st[i]), 0) / n;
  return { p, n, hit, live, bust, states: st };
}

export const parlayProb = (legs, findGame) =>
  legs.reduce((a, l) => {
    if (isProp(l)) return a * (l.odds != null ? impliedFromAmerican(l.odds) || 0.5 : 0.5);
    const g = findGame(legGame(l));
    return a * (g ? probFor(g, legTeam(l)) : 0.5);
  }, 1);

// American odds -> decimal payout multiple (stake included).
export const decimalFromAmerican = (o) => (o < 0 ? 1 + 100 / -o : 1 + o / 100);

// Price check for an offered payout on a stake, given the estimated chance p (0-1).
export function verdict(p, stake, payout) {
  if (!(payout > stake) || !(stake > 0)) return null;
  const breakEven = stake / payout;
  const edge = p - breakEven;
  const kind = edge > EDGE_BAND ? "good" : edge < -EDGE_BAND ? "poor" : "fair";
  return { breakEven, edge, kind };
}

// Record for a set of picks; `who(g)` returns the picked team (default: the model's pick).
export function pickRecord(games, who = (g) => g.pick) {
  let h = 0, m = 0, p = 0;
  games.forEach((g) => {
    const t = who(g);
    if (!t) return;
    if (g.status === "final") (winner(g) === t ? h++ : m++);
    else p++;
  });
  return { h, m, p };
}

// Net profit of placed bets: settled hits add payout-cost, misses subtract cost; others count as open.
export function betsNet(bets, findGame) {
  let net = 0, open = 0, won = 0, lost = 0;
  bets.forEach((b) => {
    const s = parlayState(b.legs, findGame);
    if (s === "hit") { net += b.payout - b.cost; won++; }
    else if (s === "miss") { net -= b.cost; lost++; }
    else open++;
  });
  return { net, open, won, lost };
}

/* ---------- suggestions ---------- */

// Three suggested parlays from the games still to play: safest (top 3 favourites),
// medium (top 5 favourites) and long shot (the two likeliest underdogs).
export function suggestParlays(games) {
  const open = games.filter((g) => g.status === "upcoming" && g.pick && g.prob != null);
  const favs = open.slice().sort((a, b) => b.prob - a.prob);
  const dogs = open
    .filter((g) => g.prob < 75)
    .map((g) => ({ g, team: g.pick === g.away ? g.home : g.away, p: 100 - g.prob }))
    .sort((a, b) => b.p - a.p);
  const nick = (t) => TEAMS[t] || t;
  const out = [];
  if (favs.length >= 3) {
    const legs = favs.slice(0, 3).map((g) => [g.id, g.pick]);
    out.push({ name: "Safe three", tag: "Safest", legs, note: "The three biggest favorites still to play." });
  }
  if (favs.length >= 5) {
    const legs = favs.slice(0, 5).map((g) => [g.id, g.pick]);
    const extra = favs.slice(3, 5).map((g) => nick(g.pick)).join(" and ");
    out.push({ name: "Five favorites", tag: "Medium", legs, note: `Safe three plus the ${extra}.` });
  }
  if (dogs.length >= 2) {
    const legs = dogs.slice(0, 2).map((d) => [d.g.id, d.team]);
    out.push({
      name: "Underdog swing", tag: "Long shot", legs,
      note: `The two likeliest underdogs: ${dogs.slice(0, 2).map((d) => `${nick(d.team)} ${Math.round(d.p)}%`).join(", ")}. Small stake only.`,
    });
  }
  return out;
}

// Validate bets read from storage or an imported backup; drops anything malformed.
// Legs are normalised to objects: {kind:"team", game, team} or {kind:"prop", game, team, player, bet, result}.
export function cleanLeg(l) {
  if (Array.isArray(l)) return typeof l[0] === "string" && typeof l[1] === "string" ? { kind: "team", game: l[0], team: l[1] } : null;
  if (!l || typeof l !== "object" || typeof l.game !== "string" || typeof l.team !== "string") return null;
  if (l.kind === "prop") {
    if (typeof l.player !== "string" || typeof l.bet !== "string" || !l.player.trim() || !l.bet.trim()) return null;
    return { kind: "prop", game: l.game, team: l.team, player: l.player.slice(0, 60), bet: l.bet.slice(0, 80), result: l.result === "hit" || l.result === "miss" ? l.result : null, ...(typeof l.ticker === "string" ? { ticker: l.ticker.slice(0, 80) } : {}) };
  }
  return { kind: "team", game: l.game, team: l.team };
}

export function cleanBets(list) {
  if (!Array.isArray(list)) return [];
  return list.flatMap((b, i) => {
    if (!b || typeof b !== "object") return [];
    const legs = Array.isArray(b.legs) ? b.legs.map(cleanLeg).filter(Boolean) : [];
    const cost = Number(b.cost), payout = Number(b.payout), season = Number(b.season), week = Number(b.week);
    if (!legs.length || !(cost > 0) || !(payout > 0) || !Number.isInteger(season) || !Number.isInteger(week)) return [];
    return [{
      id: typeof b.id === "string" && b.id ? b.id : `b-import-${i}-${cost}-${payout}`,
      season, week, legs, cost, payout,
      name: typeof b.name === "string" ? b.name.slice(0, 40) : `${legs.length}-leg bet`,
      book: typeof b.book === "string" ? b.book.slice(0, 30) : "",
      placedAt: typeof b.placedAt === "string" ? b.placedAt : null,
    }];
  });
}

export const gameId =(week, away, home) => `w${week}-${away}-${home}`.toLowerCase();
