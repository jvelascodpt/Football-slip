import {
  TEAMS, TIERS, tierOf, winner, probFor, legState, parlayState, parlayProb, verdict,
  pickRecord, betsNet, EDGE_BAND, cleanBets,
} from "./core.js";

/* ---------- storage (per device) ---------- */
const KEY = { bets: "football-slip:bets", prefs: "football-slip:prefs", theme: "football-slip:theme" };
const store = {
  get(k, fb) { try { const v = localStorage.getItem(k); return v == null ? fb : JSON.parse(v); } catch (e) { return fb; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } },
};

/* ---------- state ---------- */
let DATA = { weeks: [] };
let wk = null;
let slip = [];            // [[gameId, team], ...]
let stake = 10, offered = "", betName = "";
let logLegs = [];          // legs picked in the "log a bet" form
let myBets = cleanBets(store.get(KEY.bets, []));
{ const p = store.get(KEY.prefs, {}); if (p && p.stake > 0) stake = p.stake; }

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const money = (n) => "$" + n.toFixed(2);
const pct = (p) => (p * 100).toFixed(p < 0.1 ? 1 : 0) + "%";
const nick = (t) => TEAMS[t] || t;

const allGames = () => DATA.weeks.flatMap((w) => w.games);
const game = (id) => (wk && wk.games.find((g) => g.id === id)) || allGames().find((g) => g.id === id);
const stateLabel = { hit: "Hit", miss: "Missed", live: "In play", pending: "Not started" };
const sameWeek = (a, w) => a.season === w.season && a.week === w.week;
// Bets for a week: ones saved in the data file plus ones saved on this device.
const betsFor = (w) => [
  ...(w.tickets || []).map((t) => ({ ...t, fromFile: true })),
  ...myBets.filter((b) => sameWeek(b, w)),
];
const allBets = () => DATA.weeks.flatMap(betsFor);

function saveBets() {
  if (!store.set(KEY.bets, myBets)) toast("Could not save on this device. Private browsing?");
}

let toastTimer;
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg; t.classList.add("on");
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove("on"), 2200);
}

/* ---------- picks ---------- */
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

function viewPicks() {
  const r = pickRecord(wk.games);
  const rows = wk.games.map((g) => {
    const t = g.prob != null ? tierOf(g.prob) : null, w = winner(g), open = g.status === "upcoming";
    const res = g.pick && g.status === "final" ? (w === g.pick ? "hit" : "miss") : null;
    const btn = (team, i) => {
      const mine = team === g.pick, sel = slip.some((l) => l[0] === g.id && l[1] === team);
      const right = g.status === "upcoming"
        ? `<span class="pct">${g.prob != null ? Math.round(probFor(g, team) * 100) + "%" : ""}</span>`
        : `<span class="sc">${g.score ? g.score[i] : ""}</span>`;
      return `<button class="team${mine ? " mine" : ""}${sel ? " sel" : ""}" ${open ? "" : "disabled"} data-g="${g.id}" data-t="${team}" aria-pressed="${sel}">
        <span class="row"><span class="nm">${i ? "at " : ""}${esc(nick(team))}</span>${right}</span>
        <span class="tag">${mine ? "MY PICK" + (g.status !== "upcoming" && g.prob != null ? " · " + g.prob + "%" : "") : "&nbsp;"}</span></button>`;
    };
    const status = g.status === "final" ? "Final" : g.status === "live" ? `Live${g.live ? " · " + esc(g.live) : ""}` : "";
    const bar = g.prob != null ? `<div class="bar${g.pick === g.home ? " r" : ""}"><i style="width:${g.prob}%"></i></div>` : "";
    const k = kalshiLine(g);
    return `<article class="card">
      <div class="meta"><span>${esc(g.kick)} PT</span>${t ? `<span class="pill ${t[0]}">${t[1]}</span>` : ""}
        ${k.value ? `<span class="pill value">Kalshi value: ${esc(nick(k.value))}</span>` : ""}
        ${res ? `<span class="pill ${res} sp">${res === "hit" ? "Hit" : "Miss"}</span>` : status ? `<span class="pill ${g.status === "live" ? "live" : ""} sp">${status}</span>` : ""}</div>
      <div class="teams">${btn(g.away, 0)}${btn(g.home, 1)}</div>${bar}
      ${k.html}
      <p class="note">${esc(g.note || "")}</p></article>`;
  }).join("");
  return `<section class="sec">
    <div class="summary">
      <div class="tile"><b>${r.h}-${r.m}</b><span>My record this week</span></div>
      <div class="tile"><b>${r.p}</b><span>Picks still to play</span></div>
      <div class="tile"><b>${wk.games.filter((g) => g.prob >= 72).length}</b><span>Locks (72%+)</span></div>
    </div>
    <div class="sechead"><h2>Week ${wk.week} picks</h2><small>Tap a team to add it to your slip</small></div>
    ${rows || `<p class="empty">No games in this week's file.</p>`}</section>`;
}

/* ---------- parlays ---------- */
function legsList(legs, removable) {
  return `<ul class="legs">${legs.map((l, i) => {
    const g = game(l[0]);
    if (!g) return `<li><span class="dot"></span><span>${esc(nick(l[1]))} (game not found)</span></li>`;
    const s = legState(game)(l);
    return `<li><span class="dot ${s}" title="${stateLabel[s]}"></span><span><b>${esc(nick(l[1]))}</b> over ${esc(nick(l[1] === g.away ? g.home : g.away))}</span>
      <span class="p">${Math.round(probFor(g, l[1]) * 100)}%</span>${removable ? `<button data-rm="${i}" aria-label="Remove ${esc(nick(l[1]))}">×</button>` : ""}</li>`;
  }).join("")}</ul>`;
}

function builder() {
  if (!slip.length) return `<div class="card"><p class="empty">Your slip is empty. Tap teams on the Picks tab, or load one of the suggested parlays below.</p></div>`;
  return `<div class="card">
    ${legsList(slip, true)}
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

function parlayCard(pl, i, kind) {
  const p = parlayProb(pl.legs, game), s = parlayState(pl.legs, game);
  const line = kind === "ticket"
    ? `Cost ${money(pl.cost)}, pays ${money(pl.payout)}. Break-even ${(pl.cost / pl.payout * 100).toFixed(1)}%.`
    : `Fair payout on $10 is ${money(10 / p)}.`;
  const canLoad = pl.legs.every((l) => game(l[0])?.status === "upcoming");
  const actions = kind === "ticket"
    ? (pl.fromFile ? "" : `<div class="btnrow"><button class="btn danger" data-del="${esc(pl.id)}">Delete bet</button></div>`)
    : (canLoad ? `<div class="btnrow"><button class="btn" data-load="${i}">Load into slip</button></div>` : "");
  return `<article class="card">
    <div class="meta"><b style="color:var(--ink);font-size:15px">${esc(pl.name || "Placed bet")}</b>${pl.tag ? `<span class="pill">${esc(pl.tag)}</span>` : ""}<span class="pill ${s === "pending" ? "" : s} sp">${stateLabel[s]}</span></div>
    ${legsList(pl.legs, false)}
    <div class="big"><b>${pct(p)}</b><span>estimated chance before kickoff<br>${line}</span></div>
    ${pl.note ? `<p class="note">${esc(pl.note)}</p>` : ""}
    ${actions}</article>`;
}

function logForm() {
  const rows = wk.games.map((g) => {
    const chip = (team) => {
      const on = logLegs.some((l) => l[0] === g.id && l[1] === team);
      return `<button type="button" class="chip" data-lg="${g.id}" data-lt="${team}" aria-pressed="${on}">${esc(nick(team))}<small>${g.prob != null ? Math.round(probFor(g, team) * 100) + "%" : ""}</small></button>`;
    };
    return `<div class="prow">${chip(g.away)}${chip(g.home)}</div>`;
  }).join("");
  return `<details class="card" id="logForm"${logLegs.length ? " open" : ""}>
    <summary>Log a bet you already placed</summary>
    <p class="hint">Pick the legs, including games already started, then enter what it cost and what it pays.</p>
    <div class="picker">${rows}</div>
    <div class="fields">
      <label for="logCost">Cost ($)<input id="logCost" type="number" inputmode="decimal" min="0.01" step="0.01" placeholder="10"></label>
      <label for="logPayout">Payout ($)<input id="logPayout" type="number" inputmode="decimal" min="0.01" step="0.01" placeholder="26.73"></label>
      <label for="logName" class="full">Name (optional)<input id="logName" type="text" maxlength="40" placeholder="e.g. Sunday early games"></label>
    </div>
    <div class="btnrow"><button class="btn" type="button" data-logsave>Save bet</button><span class="hint" id="logHint">${logLegs.length} leg${logLegs.length === 1 ? "" : "s"} picked</span></div>
  </details>`;
}

function viewParlays() {
  const bets = betsFor(wk);
  return `<section class="sec"><div class="sechead"><h2>Your slip</h2><small>Hit chance multiplies each leg</small></div>${builder()}</section>
  <section class="sec"><div class="sechead"><h2>Suggested for week ${wk.week}</h2></div>
    ${(wk.parlays || []).map((p, i) => parlayCard(p, i, "sug")).join("") || `<p class="empty">No suggestions yet.</p>`}</section>
  <section class="sec"><div class="sechead"><h2>Bets you placed</h2><small>${bets.length ? bets.length + " this week" : ""}</small></div>
    ${bets.map((b, i) => parlayCard(b, i, "ticket")).join("") || `<p class="empty">None saved for week ${wk.week} yet.</p>`}
    ${logForm()}</section>`;
}

/* ---------- tracker ---------- */
function viewTracker() {
  const all = allGames(), r = pickRecord(all);
  const settled = r.h + r.m;
  let ph = 0, pm = 0;
  DATA.weeks.forEach((w) => (w.parlays || []).forEach((p) => { const s = parlayState(p.legs, game); if (s === "hit") ph++; if (s === "miss") pm++; }));
  const b = betsNet(allBets(), game);
  const tiers = TIERS.map((t, i) => {
    const hi = i ? TIERS[i - 1][2] : 101;
    const x = pickRecord(all.filter((g) => g.pick && g.prob >= t[2] && g.prob < hi));
    return `<tr><td>${t[1]}</td><td class="n">${x.h}-${x.m}</td><td class="n">${x.h + x.m ? Math.round(x.h / (x.h + x.m) * 100) + "%" : "n/a"}</td><td class="n">${x.p}</td></tr>`;
  }).join("");
  const weeks = DATA.weeks.slice().reverse().map((w) => {
    const x = pickRecord(w.games), ps = (w.parlays || []).map((p) => parlayState(p.legs, game)), wb = betsNet(betsFor(w), game);
    const net = wb.net ? `${wb.net > 0 ? "+" : "-"}${money(Math.abs(wb.net))}` : "$0.00";
    return `<tr><td>Week ${w.week}</td><td class="n">${x.h}-${x.m}</td><td class="n">${x.p}</td><td class="n">${ps.filter((s) => s === "hit").length}-${ps.filter((s) => s === "miss").length}</td><td class="n">${net}</td></tr>`;
  }).join("");
  return `<section class="sec">
    <div class="summary">
      <div class="tile"><b>${r.h}-${r.m}</b><span>Season picks${settled ? ", " + Math.round(r.h / settled * 100) + "% correct" : ""}</span></div>
      <div class="tile"><b>${ph}-${pm}</b><span>Suggested parlays hit-missed</span></div>
      <div class="tile"><b style="color:${b.net > 0 ? "var(--good)" : b.net < 0 ? "var(--bad)" : "inherit"}">${b.net < 0 ? "-" : b.net > 0 ? "+" : ""}${money(Math.abs(b.net))}</b><span>Your bets, net${b.open ? " (" + b.open + " open)" : ""}</span></div>
    </div>
    <div class="sechead"><h2>By confidence</h2><small>Locks should hit most often</small></div>
    <div class="card tablewrap"><table><thead><tr><th>Tier</th><th class="n">Record</th><th class="n">Hit rate</th><th class="n">Pending</th></tr></thead><tbody>${tiers}</tbody></table></div>
    <div class="sechead"><h2>By week</h2></div>
    <div class="card tablewrap"><table><thead><tr><th>Week</th><th class="n">Picks</th><th class="n">Pending</th><th class="n">Parlays</th><th class="n">Bets net</th></tr></thead><tbody>${weeks}</tbody></table></div>
    ${settled ? "" : `<p class="empty">Tracking starts with week ${DATA.weeks[0].week}. Results fill in as games finish.</p>`}
  </section>
  <section class="sec">
    <div class="sechead"><h2>Back up your bets</h2></div>
    <div class="card">
      <p class="note">Bets you save are stored in this browser on this phone only (${myBets.length} saved). Export a backup now and then, and import it on a new phone or after clearing Safari data.</p>
      <div class="btnrow"><button class="btn" data-export>Export bets</button><label class="btn ghost" for="importFile">Import bets</label><input id="importFile" type="file" accept="application/json,.json" hidden></div>
    </div>
  </section>`;
}

/* ---------- render + routing ---------- */
function route() { const h = (location.hash || "#picks").slice(1); return ["picks", "parlays", "tracker"].includes(h) ? h : "picks"; }
function render() {
  const v = route();
  document.querySelectorAll("nav a").forEach((a) => { a.classList.toggle("on", a.dataset.v === v); a.setAttribute("aria-current", a.dataset.v === v ? "page" : "false"); });
  $("#updated").textContent = `${wk.season} season · updated ${wk.updated}`;
  $("#view").innerHTML = v === "picks" ? viewPicks() : v === "parlays" ? viewParlays() : viewTracker();
  calc();
  const s = $("#slip"); s.classList.toggle("on", slip.length > 0 && v !== "parlays");
  if (slip.length) { $("#slipPct").textContent = pct(parlayProb(slip, game)); $("#slipTxt").textContent = slip.length + " leg" + (slip.length > 1 ? "s" : "") + " on your slip"; }
}

function addBet({ legs, cost, payout, name }) {
  const bet = { id: "b-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), season: wk.season, week: wk.week, name: name || `${legs.length}-leg bet`, legs: legs.map((l) => l.slice()), cost, payout, placedAt: new Date().toISOString() };
  myBets.push(bet); saveBets();
}

function exportBets() {
  const blob = new Blob([JSON.stringify({ app: "football-slip", exported: new Date().toISOString(), bets: myBets }, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `football-slip-bets-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

async function importBets(file) {
  try {
    const j = JSON.parse(await file.text());
    const incoming = cleanBets(Array.isArray(j) ? j : j.bets);
    const have = new Set(myBets.map((b) => b.id));
    const fresh = incoming.filter((b) => !have.has(b.id));
    myBets.push(...fresh); saveBets(); render();
    toast(`Imported ${fresh.length} bet${fresh.length === 1 ? "" : "s"}${incoming.length - fresh.length ? `, skipped ${incoming.length - fresh.length} already saved` : ""}.`);
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
document.addEventListener("click", (e) => {
  const t = e.target.closest("[data-g]");
  if (t && !t.disabled) {
    const id = t.dataset.g, team = t.dataset.t, had = slip.some((l) => l[0] === id && l[1] === team);
    slip = slip.filter((l) => l[0] !== id); if (!had) slip.push([id, team]); render(); return;
  }
  const rm = e.target.closest("[data-rm]"); if (rm) { slip.splice(+rm.dataset.rm, 1); render(); return; }
  const ld = e.target.closest("[data-load]"); if (ld) { const pl = wk.parlays[+ld.dataset.load]; slip = pl.legs.map((l) => l.slice()); offered = ""; betName = pl.name; render(); window.scrollTo(0, 0); return; }
  if (e.target.closest("[data-clear]")) { slip = []; offered = ""; betName = ""; render(); return; }
  if (e.target.closest("[data-place]")) {
    const off = parseFloat(offered); if (!(off > stake)) return;
    addBet({ legs: slip, cost: stake, payout: off, name: betName.trim() });
    slip = []; offered = ""; betName = ""; render(); toast("Bet saved. It now counts in the Tracker.");
    return;
  }
  const lg = e.target.closest("[data-lg]");
  if (lg) {
    const id = lg.dataset.lg, team = lg.dataset.lt, had = logLegs.some((l) => l[0] === id && l[1] === team);
    logLegs = logLegs.filter((l) => l[0] !== id); if (!had) logLegs.push([id, team]);
    document.querySelectorAll(`[data-lg="${id}"]`).forEach((b) => b.setAttribute("aria-pressed", String(logLegs.some((l) => l[0] === id && l[1] === b.dataset.lt))));
    $("#logHint").textContent = `${logLegs.length} leg${logLegs.length === 1 ? "" : "s"} picked`;
    return;
  }
  if (e.target.closest("[data-logsave]")) {
    const cost = parseFloat($("#logCost").value), payout = parseFloat($("#logPayout").value);
    if (!logLegs.length) return toast("Pick at least one leg.");
    if (!(cost > 0) || !(payout > cost)) return toast("Enter a cost, and a payout bigger than the cost.");
    addBet({ legs: logLegs, cost, payout, name: $("#logName").value.trim() });
    logLegs = []; render(); toast("Bet saved.");
    return;
  }
  const del = e.target.closest("[data-del]");
  if (del) {
    const b = myBets.find((x) => x.id === del.dataset.del);
    if (b && confirm(`Delete "${b.name}"? This cannot be undone.`)) { myBets = myBets.filter((x) => x !== b); saveBets(); render(); }
    return;
  }
  if (e.target.closest("[data-export]")) { exportBets(); return; }
});
document.addEventListener("input", (e) => {
  if (e.target.id === "stake") { const v = parseFloat(e.target.value); if (v > 0) { stake = v; store.set(KEY.prefs, { stake }); calc(); } }
  if (e.target.id === "offered") { offered = e.target.value; calc(); }
  if (e.target.id === "betName") betName = e.target.value;
});
document.addEventListener("change", (e) => {
  if (e.target.id === "importFile" && e.target.files[0]) importBets(e.target.files[0]);
});

/* ---------- boot ---------- */
async function load() {
  const get = async (u) => { const r = await fetch(u, { cache: "no-cache" }); if (!r.ok) throw new Error(`${r.status} ${u}`); return r.json(); };
  const idx = await get("data/index.json");
  const weeks = await Promise.all(idx.weeks.map((w) => get("data/" + w.file)));
  DATA = { weeks: weeks.sort((a, b) => a.season - b.season || a.week - b.week) };
  if (!DATA.weeks.length) throw new Error("No weeks in data/index.json");
  wk = DATA.weeks[DATA.weeks.length - 1];
  const sel = $("#week");
  const multi = new Set(DATA.weeks.map((w) => w.season)).size > 1;
  sel.innerHTML = DATA.weeks.map((w, i) => ({ w, i })).reverse().map(({ w, i }) => `<option value="${i}">${multi ? w.season + " · " : ""}Week ${w.week}</option>`).join("");
  sel.value = String(DATA.weeks.length - 1);
  sel.addEventListener("change", (e) => { wk = DATA.weeks[+e.target.value]; slip = []; logLegs = []; render(); });
  render();
}
load().catch((e) => {
  $("#updated").textContent = "";
  $("#view").innerHTML = `<div class="card"><p class="empty">Could not load this week's data (${esc(e.message)}). Check your connection and reload.</p></div>`;
});
