import {
  TEAMS, TIERS, tierOf, winner, probFor, legState, parlayState, parlayProb, parlayProgress, verdict,
  pickRecord, betsNet, EDGE_BAND, cleanBets, locked, legGame, legTeam, isProp, impliedFromAmerican,
  decimalFromAmerican, gameId, applyLiveScoreboard,
} from "./core.js";
import { COLORS, espnAb, logoUrl, teamStyle } from "./teams.js";

/* ---------- storage (per device) ---------- */
const KEY = { bets: "football-slip:bets", picks: "football-slip:picks", prefs: "football-slip:prefs", theme: "football-slip:theme" };
const store = {
  get(k, fb) { try { const v = localStorage.getItem(k); return v == null ? fb : JSON.parse(v); } catch (e) { return fb; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } },
};

/* ---------- state ---------- */
let DATA = { weeks: [] }, SCHEDULE = { weeks: [] };
let wk = null;
let slip = [];            // [[gameId, team], ...]
let stake = 10, offered = "", betName = "";
let draft = null;          // log-a-bet form state
let delArm = null;         // bet id armed for delete (tap twice)
let myBets = cleanBets(store.get(KEY.bets, []));
let myPicks = store.get(KEY.picks, {}) || {};   // {gameId: team}
{ const p = store.get(KEY.prefs, {}); if (p && p.stake > 0) stake = p.stake; }

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const money = (n) => "$" + n.toFixed(2);
const pct = (p) => (p * 100).toFixed(p < 0.1 ? 1 : 0) + "%";
const nick = (t) => TEAMS[t] || t;
const fmtOdds = (o) => (o > 0 ? "+" : "") + o;

const allGames = () => DATA.weeks.flatMap((w) => w.games);
const game = (id) => (wk && wk.games.find((g) => g.id === id)) || allGames().find((g) => g.id === id);
const stateLabel = { hit: "Hit", miss: "Missed", live: "In play", pending: "Not started" };
const sameWeek = (a, w) => a.season === w.season && a.week === w.week;
const betsFor = (w) => [
  ...(w.tickets || []).map((t, i) => ({ ...t, id: t.id || `file-${w.week}-${i}`, fromFile: true })),
  ...myBets.filter((b) => sameWeek(b, w)),
];
const allBets = () => DATA.weeks.flatMap(betsFor);
const yourPick = (g) => myPicks[g.id];

function saveBets() { if (!store.set(KEY.bets, myBets)) toast("Could not save on this device. Private browsing?"); }
function savePicks() { if (!store.set(KEY.picks, myPicks)) toast("Could not save picks on this device. Private browsing?"); }

let toastTimer;
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg; t.classList.add("on");
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove("on"), 2200);
}

/* ---------- weeks (loaded + look-ahead previews) ---------- */
const ptKick = (d) => new Date(d).toLocaleString("en-US", { timeZone: "America/Los_Angeles", weekday: "short", hour: "numeric", minute: "2-digit" }).replace(",", "");
function previewWeek(n) {
  const f = SCHEDULE.weeks.find((x) => x.week === n);
  if (!f) return null;
  return {
    season: SCHEDULE.season, week: n, preview: true, parlays: [], tickets: [], updated: DATA.weeks.at(-1)?.updated,
    games: f.games.map((g) => ({
      id: gameId(n, g.away, g.home), away: g.away, home: g.home, start: g.start, kick: ptKick(g.start),
      pick: null, prob: null, status: "upcoming", info: g.venue ? { venue: g.venue, city: g.city } : undefined,
    })),
  };
}
const weekNums = () => [...new Set([...DATA.weeks.map((w) => w.week), ...SCHEDULE.weeks.map((w) => w.week)])].sort((a, b) => a - b);
const weekObj = (n) => DATA.weeks.find((w) => w.week === n) || previewWeek(n);
function picksOpen(w) {
  const d = new Date(Math.min(...w.games.map((g) => Date.parse(g.start))));
  while (d.getDay() !== 2) d.setDate(d.getDate() - 1);   // the Tuesday run builds the week
  return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

/* ---------- shared pieces ---------- */
const badge = (team) => `<span class="tb"><img src="${logoUrl(team)}" alt="" loading="lazy" onerror="this.parentNode.classList.add('gone')"></span>`;

function kalshiLine(g) {
  if (g.status !== "upcoming" || (!g.kalshi && !g.source)) return { html: "", value: null };
  let value = null;
  const parts = [];
  if (g.source) parts.push(`Estimate from ${esc(g.source)}`);
  if (g.kalshi && g.prob != null) {
    const [ka, kh] = g.kalshi;
    const ea = probFor(g, g.away) * 100, eh = 100 - ea;
    if (ea - ka > EDGE_BAND * 100) value = g.away;
    else if (eh - kh > EDGE_BAND * 100) value = g.home;
    parts.push(`Kalshi <b>${esc(nick(g.away))} ${ka}%</b> · <b>${esc(nick(g.home))} ${kh}%</b>`);
  }
  return { html: `<p class="src">${parts.join(". ")}</p>`, value };
}

// Spread, total, moneylines, weather, stadium.
function gameInfo(g) {
  const x = g.info; if (!x) return "";
  const ml = x.mlAway || x.mlHome ? `${g.away} ${x.mlAway || "n/a"} · ${g.home} ${x.mlHome || "n/a"}` : "";
  const items = [
    ["Spread", x.spread ? x.spread + (x.total ? ` · O/U ${x.total}` : "") : ""],
    ["Moneyline", ml],
    ["Weather", x.weather || (g.status === "upcoming" ? "Forecast closer to kickoff" : "")],
    ["Stadium", x.venue ? x.venue + (x.city ? `, ${x.city}` : "") : ""],
  ].filter((i) => i[1]);
  return items.length ? `<dl class="ginfo">${items.map(([k, v]) => `<div><dt>${k}</dt><dd>${esc(v)}</dd></div>`).join("")}</dl>` : "";
}

// Scouting report: g.news.{TEAM}.s / .w are a string or a list of strings.
function newsBlock(g) {
  if (!g.news) return "";
  const pts = (v, cls, lbl) => [].concat(v || []).map((x) => `<p><b class="${cls}">${lbl}</b> ${esc(x)}</p>`).join("");
  const col = (team) => { const n = g.news[team]; return n ? `<div class="scout" style="${teamStyle(team)}"><div class="sh">${badge(team)}${esc(nick(team))}</div>${pts(n.s, "g", "Strength")}${pts(n.w, "b", "Weakness")}</div>` : ""; };
  return `<div class="scouting">${col(g.away)}${col(g.home)}</div>`;
}

function progressBar(legs) {
  if (!legs.length) return "";
  const { p, n, hit, live, bust, states } = parlayProgress(legs, game), pc = Math.round(p * 100);
  const label = bust ? `Busted · ${hit} of ${n} hit` : hit === n ? `Winner · all ${n} hit` : states.every((s) => s === "pending") ? `Not started · ${n} legs` : `${hit} of ${n} legs hit${live ? ` · ${live} in play` : ""}`;
  const fill = p > 0 ? `width:${(p * 100).toFixed(1)}%;background-size:${(100 / p).toFixed(1)}% 100%;opacity:${(0.5 + 0.5 * p).toFixed(2)}` : "width:0";
  return `<div class="progwrap"><div class="prog${bust ? " bust" : ""}" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pc}" aria-label="${label}"><i style="${fill}"></i></div>
    <div class="proglbl"><span>${label}</span><span>${bust ? "" : pc + "%"}</span></div></div>`;
}

// Winnings banner. Confetti plays the first time it's shown this visit (and on a re-render within 1.5 s).
const celebrated = new Map();
function winBlock(key, cost, payout, label) {
  const t = celebrated.get(key), fresh = !t || Date.now() - t < 1500;
  const colors = ["var(--gold)", "#ffffff", "var(--good)", "var(--accent)", "#ffe680"];
  const bits = fresh ? Array.from({ length: 30 }, (_, i) => {
    const a = Math.random() * Math.PI * 2, d = 60 + Math.random() * 110;
    return `<i style="--dx:${(Math.cos(a) * d).toFixed(0)}px;--dy:${(Math.sin(a) * d - 50).toFixed(0)}px;--r:${Math.round(Math.random() * 720 - 360)}deg;background:${colors[i % colors.length]};animation-delay:${(Math.random() * 0.2).toFixed(2)}s"></i>`;
  }).join("") : "";
  return `<div class="win${fresh ? " pop" : ""}" data-win="${esc(key)}"><div class="confetti" aria-hidden="true">${bits}</div>
    <span class="trophy" aria-hidden="true">🏆</span><div><b>+${money(payout - cost)}</b><span>${label || `You won · paid ${money(payout)} on ${money(cost)}`}</span></div></div>`;
}

/* ---------- picks ---------- */
function setPick(g, team) {
  if (!g || wk.preview || locked(g)) { render(); return; }
  const next = myPicks[g.id] === team ? null : team;
  if (next) myPicks[g.id] = next; else delete myPicks[g.id];
  slip = slip.filter((l) => l[0] !== g.id || l[1] === next);
  savePicks(); render();
}

function viewPicks() {
  const you = pickRecord(wk.games, yourPick), cl = pickRecord(wk.games);
  const toMake = wk.games.filter((g) => !locked(g) && !myPicks[g.id]).length;
  const rows = wk.games.map((g) => {
    const t = g.prob != null ? tierOf(g.prob) : null, w = winner(g), lk = locked(g) || !!wk.preview, mineT = myPicks[g.id];
    const res = mineT && g.status === "final" ? (w === mineT ? "hit" : "miss") : null;
    const btn = (team, i) => {
      const mine = team === mineT, ai = team === g.pick;
      const right = g.status === "upcoming"
        ? `<span class="pct">${g.prob != null ? Math.round(probFor(g, team) * 100) + "%" : ""}</span>`
        : `<span class="sc">${g.score ? g.score[i] : ""}</span>`;
      const tags = [mine ? "YOUR PICK" : "", ai ? "CLAUDE" + (g.prob != null ? " " + g.prob + "%" : "") : ""].filter(Boolean);
      return `<button class="team${mine ? " mine" : ""}" style="${teamStyle(team)}" ${lk ? "disabled" : ""} data-g="${g.id}" data-t="${team}" aria-pressed="${mine}">
        <span class="row">${badge(team)}${right}</span>
        <span class="nm">${i ? "at " : ""}${esc(nick(team))}</span>
        <span class="tag">${tags.join(" · ") || "&nbsp;"}</span></button>`;
    };
    const status = g.status === "final" ? "Final" : g.status === "live" ? `Live${g.live ? " · " + esc(g.live) : ""}` : lk ? "Locked" : "";
    const k = kalshiLine(g);
    const right = wk.preview ? `<span class="pill sp">Preview</span>`
      : res ? `<span class="pill ${res} sp">${res === "hit" ? "You hit" : "You missed"}</span>`
      : status ? `<span class="pill ${g.status === "live" ? "live" : ""} sp">${lk && g.status !== "final" ? "🔒 " : ""}${status}</span>`
      : !mineT ? `<span class="pill need sp">Make your pick</span>` : `<span class="pill sp">Locks at kickoff</span>`;
    const bar = g.prob != null ? `<div class="bar${g.pick === g.home ? " r" : ""}"><i style="width:${g.prob}%;background:${(COLORS[espnAb(g.pick)] || ["var(--accent)"])[0]}"></i></div>` : "";
    return `<article class="card">
      <div class="meta"><span>${esc(g.kick)} PT</span>${t ? `<span class="pill ${t[0]}">${t[1]}</span>` : ""}${k.value ? `<span class="pill value">Kalshi value: ${esc(nick(k.value))}</span>` : ""}${right}</div>
      <div class="teams">${btn(g.away, 0)}${btn(g.home, 1)}</div>${bar}${k.html}${gameInfo(g)}
      ${g.note ? `<p class="note">${esc(g.note)}</p>` : ""}${newsBlock(g)}</article>`;
  }).join("");
  if (wk.preview) {
    const opens = picksOpen(wk), byes = 32 - 2 * wk.games.length;
    return `<section class="sec">
    <div class="summary">
      <div class="tile"><b>${wk.games.length}</b><span>Games this week</span></div>
      <div class="tile"><b>${byes}</b><span>Teams on bye</span></div>
      <div class="tile"><b>${esc(opens)}</b><span>Picks open</span></div>
    </div>
    <div class="sechead"><h2>Week ${wk.week} preview</h2><small>Look-ahead only · picks open ${esc(opens)}</small></div>
    ${rows}</section>`;
  }
  return `<section class="sec">
    <div class="summary">
      <div class="tile"><b>${you.h}-${you.m}</b><span>Your record this week</span></div>
      <div class="tile"><b>${cl.h}-${cl.m}</b><span>Claude's record this week</span></div>
      <div class="tile"><b>${toMake}</b><span>Picks left to make</span></div>
    </div>
    <div class="sechead"><h2>Week ${wk.week} picks</h2><small>Tap who you think wins · locks at kickoff</small></div>
    ${rows || `<p class="empty">No games in this week's file.</p>`}</section>`;
}

/* ---------- parlays ---------- */
function legItem(l, i, opts = {}) {
  const g = game(legGame(l)), s = legState(game)(l), team = legTeam(l);
  if (isProp(l)) {
    const grade = opts.grade ? `<span class="p"><button class="grade${l.result === "hit" ? " on hit" : ""}" data-grade="${opts.grade}|${i}|hit">Hit</button> <button class="grade${l.result === "miss" ? " on miss" : ""}" data-grade="${opts.grade}|${i}|miss">Miss</button></span>` : "";
    return `<li><span class="dot ${s}" title="${stateLabel[s]}"></span>${badge(team)}<span><b>${esc(l.player)}</b> ${esc(l.bet)}</span>${l.odds != null ? `<span class="p">${fmtOdds(l.odds)}</span>` : ""}${grade}</li>`;
  }
  if (!g) return `<li><span class="dot"></span><span>${esc(nick(team))} (game not found)</span></li>`;
  const opp = team === g.away ? g.home : g.away;
  return `<li><span class="dot ${s}" title="${stateLabel[s]}"></span>${opts.logos ? badge(team) : ""}<span><b>${esc(nick(team))}</b> over ${esc(nick(opp))}</span>
    <span class="p">${Math.round(probFor(g, team) * 100)}%</span>${opts.removable ? `<button data-rm="${i}" aria-label="Remove ${esc(nick(team))}">×</button>` : ""}</li>`;
}
const legsList = (legs, opts) => `<ul class="legs">${legs.map((l, i) => legItem(l, i, opts)).join("")}</ul>`;

function builder() {
  if (!slip.length) return `<div class="card"><p class="empty">Your slip is empty. Add your picks below, or load one of the suggested parlays.</p></div>`;
  return `<div class="card">
    ${legsList(slip, { removable: true })}
    <div class="big" id="bBig"></div>
    <div class="fields">
      <label for="stake">Stake ($)<input id="stake" type="number" inputmode="decimal" min="1" step="1" value="${stake}"></label>
      <label for="offered">Payout offered ($)<input id="offered" type="number" inputmode="decimal" min="0" step="0.01" value="${esc(offered)}" placeholder="e.g. 26.73"></label>
      <label for="betName" class="full">Name (optional)<input id="betName" type="text" maxlength="40" value="${esc(betName)}" placeholder="e.g. Kalshi four-leg"></label>
    </div>
    <p class="verdict" id="bVerdict"></p>
    <div class="btnrow"><button class="btn" data-place id="placeBtn">Save as placed bet</button><button class="btn ghost" data-clear>Clear slip</button></div>
    <span class="hint" id="placeHint"></span></div>`;
}

function calc() {
  const big = $("#bBig"), ver = $("#bVerdict"); if (!big || !slip.length) return;
  const p = parlayProb(slip, game), off = parseFloat(offered);
  big.innerHTML = `<b>${pct(p)}</b><span>chance all ${slip.length} leg${slip.length > 1 ? "s" : ""} hit<br>Fair payout on ${money(stake)} is ${money(stake / p)}</span>`;
  const v = verdict(p, stake, off);
  if (v) {
    const cls = { good: "g", poor: "b", fair: "w" }[v.kind], word = { good: "Good price.", poor: "Poor price.", fair: "Roughly fair." }[v.kind];
    ver.innerHTML = `<b class="${cls}">${word}</b> A ${money(off)} payout needs ${(v.breakEven * 100).toFixed(1)}% to break even. Estimated chance is ${(p * 100).toFixed(1)}%.`;
  } else ver.textContent = "Enter the payout your book offers to see whether the price is fair.";
  const ok = off > stake;
  $("#placeBtn").disabled = !ok;
  $("#placeHint").textContent = ok ? `Saves on this phone with cost ${money(stake)} and payout ${money(off)}.` : "Enter the payout to save this as a placed bet.";
}

function parlayCard(pl, i) {
  const p = parlayProb(pl.legs, game), s = parlayState(pl.legs, game);
  const canLoad = pl.legs.every((l) => game(l[0])?.status === "upcoming");
  return `<article class="card">
    <div class="meta"><b style="color:var(--ink);font-size:15px">${esc(pl.name)}</b>${pl.tag ? `<span class="pill">${esc(pl.tag)}</span>` : ""}<span class="pill ${s === "pending" ? "" : s} sp">${stateLabel[s]}</span></div>
    ${legsList(pl.legs, {})}${progressBar(pl.legs)}
    <div class="big"><b>${pct(p)}</b><span>estimated chance before kickoff<br>Fair payout on $10 is ${money(10 / p)}.</span></div>
    ${pl.note ? `<p class="note">${esc(pl.note)}</p>` : ""}
    ${canLoad ? `<div class="btnrow"><button class="btn" data-load="${i}">Load into slip</button></div>` : ""}</article>`;
}

function betCard(b) {
  const legs = b.legs || [], s = parlayState(legs, game);
  const del = b.fromFile ? "" : `<button class="btn ghost" data-delbet="${esc(b.id)}">${delArm === b.id ? "Tap again to delete" : "Delete"}</button>`;
  return `<article class="card${s === "hit" ? " won" : ""}"><div class="meta"><b style="color:var(--ink);font-size:15px">${esc(b.name || "Bet")}</b>${b.book ? `<span class="pill">${esc(b.book)}</span>` : ""}<span class="pill ${s === "pending" ? "" : s} sp">${stateLabel[s]}</span></div>
    ${legsList(legs, { logos: true, grade: b.fromFile ? null : b.id })}
    ${progressBar(legs)}${s === "hit" ? winBlock("b" + b.id, +b.cost, +b.payout) : ""}
    <div class="big"><b>${money(+b.payout)}</b><span>pays on ${money(+b.cost)}<br>Needs ${(b.cost / b.payout * 100).toFixed(1)}% to break even</span></div>
    ${legs.some(isProp) && !b.fromFile ? `<p class="hint">Mark prop legs Hit or Miss once the game ends.</p>` : ""}
    ${del ? `<div class="btnrow">${del}</div>` : ""}</article>`;
}

const openPicks = () => wk.games.filter((g) => !locked(g) && myPicks[g.id]);
function fromPicks() {
  const open = openPicks();
  if (!open.length) return `<section class="sec"><div class="sechead"><h2>Add your picks</h2></div><div class="card"><p class="empty">Make picks on the Picks tab and they'll show up here to add to your slip.</p></div></section>`;
  return `<section class="sec"><div class="sechead"><h2>Add your picks</h2><small>Games that haven't kicked off</small></div>
    <div class="card"><ul class="legs">${open.map((g) => {
      const t = myPicks[g.id], on = slip.some((l) => l[0] === g.id && l[1] === t);
      return `<li>${badge(t)}<span><b>${esc(nick(t))}</b> over ${esc(nick(t === g.away ? g.home : g.away))}</span><span class="p">${Math.round(probFor(g, t) * 100)}%</span>
        <button class="add${on ? " on" : ""}" data-addpick="${g.id}" aria-pressed="${on}">${on ? "✓ Added" : "+ Add"}</button></li>`;
    }).join("")}</ul>
    <div class="btnrow"><button class="btn ghost" data-addall>Add all</button></div></div></section>`;
}

const blankLeg = () => ({ kind: "team", pick: "", player: "", bet: "" });
function teamOptions(sel) {
  return `<option value="">Choose…</option>` + wk.games.map((g) => `<optgroup label="${esc(nick(g.away))} at ${esc(nick(g.home))} · ${esc(g.kick)}">${[g.away, g.home].map((t) => { const v = g.id + "|" + t; return `<option value="${v}"${v === sel ? " selected" : ""}>${esc(nick(t))}</option>`; }).join("")}</optgroup>`).join("");
}
function betForm() {
  if (!draft) return `<div class="btnrow"><button class="btn" data-newbet>+ Log a bet</button></div>`;
  const legs = draft.legs.map((l, i) => `<div class="legrow">
      <select data-leg="${i}" data-lf="kind" aria-label="Leg type"><option value="team"${l.kind === "team" ? " selected" : ""}>Team wins</option><option value="prop"${l.kind === "prop" ? " selected" : ""}>Player prop</option></select>
      <select data-leg="${i}" data-lf="pick" aria-label="${l.kind === "prop" ? "Player's team" : "Team"}">${teamOptions(l.pick)}</select>
      ${l.kind === "prop" ? `<input data-leg="${i}" data-lf="player" placeholder="Player" aria-label="Player" value="${esc(l.player)}"><input data-leg="${i}" data-lf="bet" placeholder="e.g. Over 64.5 rec yds" aria-label="Bet" value="${esc(l.bet)}">` : ""}
      <button class="x" data-rmleg="${i}" aria-label="Remove leg">×</button></div>`).join("");
  return `<div class="card betform">
    <h3>Log a bet</h3>
    <p class="hint">Any game this week, including ones already started.</p>
    <div class="fields">
      <label>Name<input data-f="name" value="${esc(draft.name)}" placeholder="e.g. Kalshi four-leg"></label>
      <label>Where<input data-f="book" value="${esc(draft.book)}"></label>
      <label>Cost ($)<input data-f="cost" type="number" inputmode="decimal" min="0" step="0.01" value="${esc(draft.cost)}"></label>
      <label>Pays ($)<input data-f="payout" type="number" inputmode="decimal" min="0" step="0.01" value="${esc(draft.payout)}"></label>
    </div>
    <div class="legform">${legs}</div>
    <div class="btnrow"><button class="btn ghost" data-addleg>+ Add leg</button></div>
    ${draft.msg ? `<p class="verdict">${esc(draft.msg)}</p>` : ""}
    <div class="btnrow"><button class="btn" data-savebet>Save bet</button><button class="btn ghost" data-cancelbet>Cancel</button></div></div>`;
}
function saveDraft() {
  const d = draft, cost = parseFloat(d.cost), payout = parseFloat(d.payout);
  const legs = d.legs.filter((l) => l.pick && (l.kind === "team" || (l.player.trim() && l.bet.trim()))).map((l) => {
    const [g, team] = l.pick.split("|");
    return l.kind === "team" ? { kind: "team", game: g, team } : { kind: "prop", game: g, team, player: l.player.trim(), bet: l.bet.trim(), result: null };
  });
  if (!legs.length) { d.msg = "Add at least one complete leg."; return render(); }
  if (!(cost > 0) || !(payout > cost)) { d.msg = "Enter what you paid and what it pays (more than the cost)."; return render(); }
  addBet({ legs, cost, payout, name: d.name.trim() || `${legs.length}-leg ${d.book.trim() || "bet"}`, book: d.book.trim() });
  draft = null; render(); toast("Bet saved.");
}

function viewParlays() {
  const bets = betsFor(wk);
  return `<section class="sec"><div class="sechead"><h2>Your slip</h2><small>Hit chance multiplies each leg</small></div>${builder()}</section>
  ${fromPicks()}
  <section class="sec"><div class="sechead"><h2>Suggested for week ${wk.week}</h2></div>
    ${(wk.parlays || []).map(parlayCard).join("") || `<p class="empty">No suggestions yet.</p>`}</section>
  <section class="sec"><div class="sechead"><h2>Bets you placed</h2><small>Settle as games finish</small></div>
    ${betForm()}${bets.slice().reverse().map(betCard).join("") || `<p class="empty">None saved for week ${wk.week} yet.</p>`}</section>`;
}

/* ---------- props ---------- */
function propCard(p, i) {
  const legs = p.legs.map((l) => ({ ...l, kind: "prop" }));
  const s = parlayState(legs, game);
  const prob = legs.reduce((a, l) => a * (impliedFromAmerican(l.odds) || 0.5), 1), pay = legs.reduce((a, l) => a * decimalFromAmerican(l.odds), 1) * 10;
  return `<article class="card${i ? "" : " feat"}${s === "hit" ? " won" : ""}">
    <div class="meta"><b style="color:var(--ink);font-size:15px">${esc(p.name)}</b>${p.tag ? `<span class="pill${i ? "" : " lock"}">${esc(p.tag)}</span>` : ""}<span class="pill ${s === "pending" ? "" : s} sp">${stateLabel[s]}</span></div>
    <ul class="legs">${legs.map((l) => {
      const g = game(l.game), st = legState(game)(l);
      return `<li><span class="dot ${st}" title="${stateLabel[st]}"></span>${badge(l.team)}<span><b>${esc(l.player)}</b> ${esc(l.bet)}</span><span class="p">${fmtOdds(l.odds)}</span>
        ${l.why || g ? `<p class="why">${g ? `${esc(nick(g.away))} at ${esc(nick(g.home))}, ${esc(g.kick)} PT. ` : ""}${esc(l.why || "")}</p>` : ""}</li>`;
    }).join("")}</ul>
    ${progressBar(legs)}${s === "hit" ? winBlock(`p${wk.week}-${i}`, 10, pay, `It hit · a $10 bet paid ${money(pay)}`) : ""}
    <div class="big"><b>${pct(prob)}</b><span>chance all ${legs.length} hit, from book prices<br>Pays about ${money(pay)} on $10 as a regular parlay</span></div>
    ${p.note ? `<p class="note">${esc(p.note)}</p>` : ""}</article>`;
}
function viewProps() {
  const ps = wk.props || [];
  return `<section class="sec"><div class="sechead"><h2>Week ${wk.week} player parlay</h2><small>Top pick first</small></div>
    ${ps.length ? ps.map(propCard).join("") : `<div class="card"><p class="empty">This week's top player parlay posts Sunday morning, once injury reports and prop lines are settled.</p></div>`}
    <p class="empty">Player props on the same game are related, so books price same-game parlays differently. Check your book's actual payout before betting.</p></section>`;
}

/* ---------- tracker ---------- */
function viewTracker() {
  const all = allGames(), r = pickRecord(all), y = pickRecord(all, yourPick);
  const settled = r.h + r.m, ySettled = y.h + y.m;
  let ph = 0, pm = 0;
  DATA.weeks.forEach((w) => (w.parlays || []).forEach((p) => { const s = parlayState(p.legs, game); if (s === "hit") ph++; if (s === "miss") pm++; }));
  const b = betsNet(allBets(), game);
  const tiers = TIERS.map((t, i) => {
    const hi = i ? TIERS[i - 1][2] : 101;
    const x = pickRecord(all.filter((g) => g.pick && g.prob >= t[2] && g.prob < hi));
    return `<tr><td>${t[1]}</td><td class="n">${x.h}-${x.m}</td><td class="n">${x.h + x.m ? Math.round(x.h / (x.h + x.m) * 100) + "%" : "n/a"}</td><td class="n">${x.p}</td></tr>`;
  }).join("");
  const weeks = DATA.weeks.slice().reverse().map((w) => {
    const x = pickRecord(w.games), z = pickRecord(w.games, yourPick), ps = (w.parlays || []).map((p) => parlayState(p.legs, game)), wb = betsNet(betsFor(w), game);
    const net = wb.net ? `${wb.net > 0 ? "+" : "-"}${money(Math.abs(wb.net))}` : "$0.00";
    return `<tr><td>Week ${w.week}</td><td class="n">${z.h}-${z.m}</td><td class="n">${x.h}-${x.m}</td><td class="n">${x.p}</td><td class="n">${ps.filter((s) => s === "hit").length}-${ps.filter((s) => s === "miss").length}</td><td class="n">${net}</td></tr>`;
  }).join("");
  return `<section class="sec">
    <div class="summary">
      <div class="tile"><b>${y.h}-${y.m}</b><span>Your picks${ySettled ? ", " + Math.round(y.h / ySettled * 100) + "% correct" : ""}</span></div>
      <div class="tile"><b>${r.h}-${r.m}</b><span>Claude's picks${settled ? ", " + Math.round(r.h / settled * 100) + "% correct" : ""}</span></div>
      <div class="tile"><b style="color:${b.net > 0 ? "var(--good)" : b.net < 0 ? "var(--bad)" : "inherit"}">${b.net < 0 ? "-" : b.net > 0 ? "+" : ""}${money(Math.abs(b.net))}</b><span>Your bets, net${b.open ? " (" + b.open + " open)" : ""}</span></div>
    </div>
    <div class="sechead"><h2>Claude by confidence</h2><small>Locks should hit most often</small></div>
    <div class="card tablewrap"><table><thead><tr><th>Tier</th><th class="n">Record</th><th class="n">Hit rate</th><th class="n">Pending</th></tr></thead><tbody>${tiers}</tbody></table></div>
    <div class="sechead"><h2>By week</h2></div>
    <div class="card tablewrap"><table><thead><tr><th>Week</th><th class="n">You</th><th class="n">Claude</th><th class="n">Pending</th><th class="n">Parlays</th><th class="n">Bets net</th></tr></thead><tbody>${weeks}</tbody></table></div>
    ${settled ? "" : `<p class="empty">Tracking starts with week ${DATA.weeks[0].week}. Results fill in as games finish.</p>`}
  </section>
  <section class="sec">
    <div class="sechead"><h2>Back up your bets</h2></div>
    <div class="card">
      <p class="note">Your picks and bets are stored in this browser on this phone only (${myBets.length} bet${myBets.length === 1 ? "" : "s"}, ${Object.keys(myPicks).length} pick${Object.keys(myPicks).length === 1 ? "" : "s"}). Export a backup now and then, and import it on a new phone or after clearing Safari data.</p>
      <div class="btnrow"><button class="btn" data-export>Export</button><label class="btn ghost" for="importFile">Import</label><input id="importFile" type="file" accept="application/json,.json" hidden></div>
    </div>
  </section>`;
}

/* ---------- field + ticker ---------- */
function drawField() {
  const seq = [10, 20, 30, 40, 50, 40, 30, 20], n = Math.ceil(innerHeight / 160) + 1; let h = "";
  for (let i = 0; i < n; i++) {
    const y = 158.5 + i * 160, v = seq[i % seq.length];
    h += `<span class="yd l" style="top:${y}px">${v}</span><span class="yd r" style="top:${y}px">${v}</span>`;
  }
  $("#field").innerHTML = h;
}

// Live from ESPN's public scoreboard. Tue/Wed preview next week's games; other days show this week's scores.
// Falls back to the scores in the newest week file if the feed can't be reached.
const ESPN = "https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard";
const getJSON = async (u) => { const r = await fetch(u); if (!r.ok) throw new Error(r.status); return r.json(); };
function fromEspn(e) {
  const c = e.competitions[0], a = c.competitors.find((x) => x.homeAway === "away"), h = c.competitors.find((x) => x.homeAway === "home");
  return { away: a.team.abbreviation, home: h.team.abbreviation, as: +a.score || 0, hs: +h.score || 0, state: e.status.type.state, detail: e.status.type.shortDetail || "", date: new Date(e.date) };
}
function fromData() {
  const st = { final: "post", live: "in", upcoming: "pre" }, w = DATA.weeks[DATA.weeks.length - 1];
  return w.games.map((g) => ({ away: g.away, home: g.home, as: g.score ? g.score[0] : 0, hs: g.score ? g.score[1] : 0, state: st[g.status] || "pre", detail: g.status === "upcoming" ? g.kick + " PT" : g.live || "", date: g.start ? new Date(g.start) : null }));
}
const tm = (ab) => `<span class="tm"><img class="lg" src="${logoUrl(ab, true)}" alt="" width="22" height="22" onerror="this.classList.add('gone')"><b>${esc(espnAb(ab))}</b></span>`;
function tkItem(t) {
  if (t.state === "pre") {
    const when = t.date ? t.date.toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" }) : t.detail;
    return `<span class="tk">${tm(t.away)} at ${tm(t.home)}<span class="st">${esc(when)}</span></span>`;
  }
  const fin = t.state === "post", aLo = fin && t.as < t.hs, hLo = fin && t.hs < t.as;
  return `<span class="tk"><span class="tm ${aLo ? "lo" : ""}">${tm(t.away)} ${t.as}</span><span class="tm ${hLo ? "lo" : ""}">${tm(t.home)} ${t.hs}</span><span class="st${fin ? "" : " live"}">${fin ? "Final" : esc(t.detail)}</span></span>`;
}
let tkTimer;
async function loadTicker() {
  clearTimeout(tkTimer);
  const preview = [2, 3].includes(new Date().getDay());
  let items, label;
  try {
    let d = await getJSON(ESPN), wkNo = d.week && d.week.number;
    label = wkNo ? `Week ${wkNo} scores` : "Scores";
    // Keep the game cards as current as the ticker (the data file only updates hourly).
    if (applyLiveScoreboard(DATA.weeks, d) && wk && wk.week === wkNo && !(document.activeElement && document.activeElement.matches("input,select"))) render();
    if (preview && d.season && d.season.type === 2 && wkNo && wkNo < 18) {
      const n = await getJSON(`${ESPN}?seasontype=2&week=${wkNo + 1}`);
      if (n.events && n.events.length) { d = n; label = `Week ${wkNo + 1} games`; }
    }
    items = (d.events || []).map(fromEspn);
  } catch (e) {
    items = fromData(); label = `Week ${DATA.weeks[DATA.weeks.length - 1].week} scores`;
  }
  const rank = { in: 0, post: 1, pre: 2 };
  items.sort((a, b) => rank[a.state] - rank[b.state] || (a.date && b.date ? (a.state === "post" ? b.date - a.date : a.date - b.date) : 0));
  $("#tkLbl").textContent = label;
  const html = items.length ? items.map(tkItem).join("") : `<span class="tk">No games scheduled</span>`, track = $("#tkTrack");
  if (matchMedia("(prefers-reduced-motion: reduce)").matches || items.length < 2) track.innerHTML = `<div class="grp">${html}</div>`;
  else { track.innerHTML = `<div class="grp">${html}</div><div class="grp" aria-hidden="true">${html}</div>`; track.style.setProperty("--dur", Math.max(20, items.length * 5) + "s"); }
  tkTimer = setTimeout(loadTicker, items.some((t) => t.state === "in") ? 60000 : 600000);
}

/* ---------- render + routing ---------- */
function route() { const h = (location.hash || "#picks").slice(1); return ["picks", "parlays", "props", "tracker"].includes(h) ? h : "picks"; }
function render() {
  const v = route();
  document.querySelectorAll("nav a").forEach((a) => { a.classList.toggle("on", a.dataset.v === v); a.setAttribute("aria-current", a.dataset.v === v ? "page" : "false"); });
  $("#updated").textContent = `${wk.season} season · updated ${wk.updated || ""}`;
  $("#view").innerHTML = v === "picks" ? viewPicks() : v === "parlays" ? viewParlays() : v === "props" ? viewProps() : viewTracker();
  document.querySelectorAll("[data-win]").forEach((el) => { if (!celebrated.has(el.dataset.win)) celebrated.set(el.dataset.win, Date.now()); });
  calc();
  const s = $("#slip"); s.classList.toggle("on", slip.length > 0 && v !== "parlays");
  if (slip.length) { $("#slipPct").textContent = pct(parlayProb(slip, game)); $("#slipTxt").textContent = slip.length + " leg" + (slip.length > 1 ? "s" : "") + " on your slip"; }
}

function addBet({ legs, cost, payout, name, book = "" }) {
  const bet = cleanBets([{ id: "b-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), season: wk.season, week: wk.week, name: name || `${legs.length}-leg bet`, book, legs, cost, payout, placedAt: new Date().toISOString() }])[0];
  if (bet) { myBets.push(bet); saveBets(); }
}

function exportData() {
  const blob = new Blob([JSON.stringify({ app: "football-slip", exported: new Date().toISOString(), bets: myBets, picks: myPicks }, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `football-slip-backup-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

async function importData(file) {
  try {
    const j = JSON.parse(await file.text());
    const incoming = cleanBets(Array.isArray(j) ? j : j.bets);
    const have = new Set(myBets.map((b) => b.id));
    const fresh = incoming.filter((b) => !have.has(b.id));
    myBets.push(...fresh); saveBets();
    let np = 0;
    if (j && j.picks && typeof j.picks === "object") {
      Object.entries(j.picks).forEach(([id, t]) => { if (typeof t === "string" && TEAMS[t] && !myPicks[id]) { myPicks[id] = t; np++; } });
      savePicks();
    }
    render();
    toast(`Imported ${fresh.length} bet${fresh.length === 1 ? "" : "s"} and ${np} pick${np === 1 ? "" : "s"}.`);
  } catch (e) { toast("That file is not a Football Slip backup."); }
}

/* ---------- theme ---------- */
const THEMES = ["auto", "light", "dark"];
function applyTheme(t) {
  if (t === "auto") delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = t;
  const b = $("#theme"); b.textContent = t[0].toUpperCase() + t.slice(1); b.setAttribute("aria-label", `Theme: ${t}. Tap to change.`);
}
let theme = store.get(KEY.theme, "auto"); if (!THEMES.includes(theme)) theme = "auto";
applyTheme(theme);
$("#theme").addEventListener("click", () => { theme = THEMES[(THEMES.indexOf(theme) + 1) % 3]; store.set(KEY.theme, theme); applyTheme(theme); });

/* ---------- events ---------- */
window.addEventListener("hashchange", () => { render(); window.scrollTo(0, 0); });
$("#refresh").addEventListener("click", (e) => { const b = e.currentTarget; b.classList.add("busy"); b.disabled = true; setTimeout(() => location.reload(), 150); });
document.addEventListener("click", (e) => {
  const t = e.target.closest("[data-g]");
  if (t && !t.disabled) { setPick(game(t.dataset.g), t.dataset.t); return; }
  if (e.target.closest("[data-newbet]")) { draft = { name: "", book: "Kalshi", cost: "", payout: "", legs: [blankLeg()], msg: "" }; render(); return; }
  if (e.target.closest("[data-cancelbet]")) { draft = null; render(); return; }
  if (e.target.closest("[data-addleg]")) { draft.legs.push(blankLeg()); render(); return; }
  const rl = e.target.closest("[data-rmleg]"); if (rl) { draft.legs.splice(+rl.dataset.rmleg, 1); if (!draft.legs.length) draft.legs.push(blankLeg()); render(); return; }
  if (e.target.closest("[data-savebet]")) { saveDraft(); return; }
  const gr = e.target.closest("[data-grade]");
  if (gr) {
    const [id, i, res] = gr.dataset.grade.split("|"), b = myBets.find((x) => x.id === id), l = b && b.legs[+i];
    if (l && isProp(l)) { l.result = l.result === res ? null : res; saveBets(); render(); }
    return;
  }
  const db = e.target.closest("[data-delbet]");
  if (db) {
    const id = db.dataset.delbet;
    if (delArm !== id) { delArm = id; render(); return; }
    delArm = null; myBets = myBets.filter((x) => x.id !== id); saveBets(); render(); return;
  }
  const ap = e.target.closest("[data-addpick]");
  if (ap) { const id = ap.dataset.addpick, team = myPicks[id], had = slip.some((l) => l[0] === id); slip = slip.filter((l) => l[0] !== id); if (!had && team) slip.push([id, team]); render(); return; }
  if (e.target.closest("[data-addall]")) { openPicks().forEach((g) => { slip = slip.filter((l) => l[0] !== g.id); slip.push([g.id, myPicks[g.id]]); }); render(); return; }
  const rm = e.target.closest("[data-rm]"); if (rm) { slip.splice(+rm.dataset.rm, 1); render(); return; }
  const ld = e.target.closest("[data-load]"); if (ld) { const pl = wk.parlays[+ld.dataset.load]; slip = pl.legs.map((l) => l.slice()); offered = ""; betName = pl.name; render(); window.scrollTo(0, 0); return; }
  if (e.target.closest("[data-clear]")) { slip = []; offered = ""; betName = ""; render(); return; }
  if (e.target.closest("[data-place]")) {
    const off = parseFloat(offered); if (!(off > stake)) return;
    addBet({ legs: slip, cost: stake, payout: off, name: betName.trim() });
    slip = []; offered = ""; betName = ""; render(); toast("Bet saved. It now counts in the Tracker.");
    return;
  }
  if (e.target.closest("[data-export]")) { exportData(); return; }
});
document.addEventListener("input", (e) => {
  if (e.target.id === "stake") { const v = parseFloat(e.target.value); if (v > 0) { stake = v; store.set(KEY.prefs, { stake }); calc(); } }
  if (e.target.id === "offered") { offered = e.target.value; calc(); }
  if (e.target.id === "betName") betName = e.target.value;
  if (draft && e.target.dataset.f) draft[e.target.dataset.f] = e.target.value;
  if (draft && e.target.dataset.lf) { const l = draft.legs[+e.target.dataset.leg]; if (l) { l[e.target.dataset.lf] = e.target.value; if (e.target.dataset.lf === "kind") render(); } }
});
document.addEventListener("change", (e) => {
  if (e.target.id === "importFile" && e.target.files[0]) importData(e.target.files[0]);
});

/* ---------- boot ---------- */
async function load() {
  const get = async (u) => { const r = await fetch(u, { cache: "no-cache" }); if (!r.ok) throw new Error(`${r.status} ${u}`); return r.json(); };
  const idx = await get("data/index.json");
  const weeks = await Promise.all(idx.weeks.map((w) => get("data/" + w.file)));
  DATA = { weeks: weeks.sort((a, b) => a.season - b.season || a.week - b.week) };
  if (!DATA.weeks.length) throw new Error("No weeks in data/index.json");
  if (idx.schedule) {
    try {
      const sc = await get("data/" + idx.schedule), have = new Set(DATA.weeks.map((w) => w.week));
      SCHEDULE = { season: sc.season, weeks: (sc.weeks || []).filter((w) => !have.has(w.week)) };
    } catch (e) { /* previews are optional */ }
  }
  wk = DATA.weeks[DATA.weeks.length - 1];
  const sel = $("#week");
  sel.innerHTML = weekNums().map((n) => `<option value="${n}"${n === wk.week ? " selected" : ""}>Week ${n}${DATA.weeks.some((w) => w.week === n) ? "" : " · preview"}</option>`).join("");
  sel.addEventListener("change", (e) => { wk = weekObj(+e.target.value) || wk; slip = []; draft = null; render(); });
  render();
  loadTicker();
}
drawField(); window.addEventListener("resize", drawField);
load().catch((e) => {
  $("#updated").textContent = "";
  $("#view").innerHTML = `<div class="card"><p class="empty">Could not load this week's data (${esc(e.message)}). Check your connection and reload.</p></div>`;
});
// Re-check locks every 30 s so a game locks at kickoff even if the page stays open.
let lastLocks = "";
setInterval(() => {
  if (!wk) return;
  const s = wk.games.map((g) => (locked(g) ? 1 : 0)).join("");
  if (s !== lastLocks) { lastLocks = s; if (!document.activeElement || !document.activeElement.matches("input,select")) render(); }
}, 30000);
