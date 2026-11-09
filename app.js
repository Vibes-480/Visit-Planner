"use strict";
/* Visit Planner: plan family visits (timeline, food, sleep, check-ins) for yourself.
   Data lives in the private repo Vibes-480/Visit-Planner-Data (data.json) and is copied
   on each device, so it works offline. The GitHub token is stored only on this device. */

const DATA_REPO = "Vibes-480/Visit-Planner-Data";
const DEFAULT_LOC = [55.68, 10.5];          // middle of Denmark, for sunset when no place has a location
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const app = $("#app");

/* ---------- storage ---------- */
const store = {
  get(k, d) { try { const v = localStorage.getItem("vp." + k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem("vp." + k, JSON.stringify(v)); } catch {} },
};
const blank = () => ({ version: 1, settings: { bufferMin: 15, updated: "" }, people: [], places: [], trips: [] });
let D = store.get("data", null) || blank();
let S = store.get("settings", { token: "", tripId: "", tab: "plan" });
let RW = store.get("roadworks", { trips: {} });
const saveS = () => store.set("settings", S);
const saveLocal = () => store.set("data", D);

/* ---------- helpers ---------- */
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const uid = () => Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-4);
const now = () => new Date().toISOString();
const pad = n => String(n).padStart(2, "0");
const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const hm = d => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const toDate = (day, time = "00:00") => { const [y, m, d] = day.split("-").map(Number); const [h, mi] = (time || "00:00").split(":").map(Number); return new Date(y, m - 1, d, h, mi); };
const addDays = (day, n) => { const d = toDate(day); d.setDate(d.getDate() + n); return ymd(d); };
const daysBetween = (a, b) => Math.round((toDate(b) - toDate(a)) / 864e5);
const mins = t => { const [h, m] = (t || "0:0").split(":").map(Number); return h * 60 + m; };
const fromMins = m => { m = ((Math.round(m) % 1440) + 1440) % 1440; return `${pad(Math.floor(m / 60))}:${pad(m % 60)}`; };
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"], MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const dayLabel = day => { const d = toDate(day); return `${DOW[d.getDay()]} ${d.getDate()} ${MON[d.getMonth()]}`; };
const range = t => t.end && t.end !== t.start ? `${dayLabel(t.start)} – ${dayLabel(t.end)}` : dayLabel(t.start);
const lines = s => String(s || "").split("\n").map(x => x.trim()).filter(Boolean);
const live = arr => arr.filter(x => !x.deleted);
const person = id => D.people.find(p => p.id === id && !p.deleted);
const place = id => D.places.find(p => p.id === id && !p.deleted);
const buffer = () => Number(D.settings?.bufferMin ?? 15);
function touch(obj) { obj.updated = now(); saveLocal(); queueSync(); }

/* ---------- sunrise / sunset (NOAA approximation) ---------- */
function sunUT(day, lat, lon, rising) {
  const r = Math.PI / 180, d = toDate(day);
  const N = Math.round((Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) - Date.UTC(d.getFullYear(), 0, 0)) / 864e5);
  const lh = lon / 15, t = N + ((rising ? 6 : 18) - lh) / 24, M = 0.9856 * t - 3.289;
  let L = (M + 1.916 * Math.sin(M * r) + 0.02 * Math.sin(2 * M * r) + 282.634 + 360) % 360;
  let RA = (Math.atan(0.91764 * Math.tan(L * r)) / r + 360) % 360;
  RA = (RA + Math.floor(L / 90) * 90 - Math.floor(RA / 90) * 90) / 15;
  const sinDec = 0.39782 * Math.sin(L * r), cosDec = Math.cos(Math.asin(sinDec));
  const cosH = (Math.cos(90.833 * r) - sinDec * Math.sin(lat * r)) / (cosDec * Math.cos(lat * r));
  if (cosH > 1 || cosH < -1) return null;
  const H = (rising ? 360 - Math.acos(cosH) / r : Math.acos(cosH) / r) / 15;
  const UT = ((H + RA - 0.06571 * t - 6.622 - lh) % 24 + 24) % 24;
  return new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) + UT * 36e5);
}
function tripLoc(t) { const p = (t.route || []).map(place).find(p => p && p.lat != null); return p ? [p.lat, p.lon] : DEFAULT_LOC; }
function isDark(dt, loc) {
  const day = ymd(dt), rise = sunUT(day, loc[0], loc[1], true), set = sunUT(day, loc[0], loc[1], false);
  return !rise || !set ? false : dt < rise || dt > set;
}
const sunset = (day, loc) => { const s = sunUT(day, loc[0], loc[1], false); return s ? hm(s) : "?"; };

/* ---------- GitHub sync ---------- */
const b64enc = s => btoa(unescape(encodeURIComponent(s)));
const b64dec = s => decodeURIComponent(escape(atob(s.replace(/\n/g, ""))));
async function gh(path, method = "GET", body) {
  const r = await fetch(`https://api.github.com/repos/${DATA_REPO}${path}`, { method, cache: "no-store",
    body: body ? JSON.stringify(body) : undefined,
    headers: { Authorization: `Bearer ${S.token}`, Accept: "application/vnd.github+json" } });
  if (r.status === 404) return null;
  if (r.status === 409 || r.status === 422) { const e = new Error("conflict"); e.conflict = true; throw e; }
  if (r.status === 401 || r.status === 403) throw new Error("GitHub refused the token. Check it in Trips → Settings.");
  if (!r.ok) throw new Error(`GitHub error ${r.status}`);
  return r.status === 204 ? {} : r.json().catch(() => ({}));
}
async function getJson(file) { const r = await gh(`/contents/${file}`); return r ? { sha: r.sha, json: JSON.parse(b64dec(r.content)) } : null; }
function mergeData(a, b) {
  const out = blank();
  out.settings = (b.settings?.updated || "") > (a.settings?.updated || "") ? b.settings : a.settings;
  for (const k of ["people", "places", "trips"]) {
    const m = new Map();
    for (const x of [...(a[k] || []), ...(b[k] || [])]) { const o = m.get(x.id); if (!o || (x.updated || "") > (o.updated || "")) m.set(x.id, x); }
    out[k] = [...m.values()];
  }
  return out;
}
let syncing = false, again = false, syncTimer = null, syncState = { s: "", msg: "" };
function setSync(s, msg) { syncState = { s, msg }; const el = $("#sync"); if (el) el.innerHTML = `<span class="dot ${s}"></span>${esc(msg)}`; }
function queueSync() { clearTimeout(syncTimer); if (S.token) { setSync("busy", "Saving…"); syncTimer = setTimeout(syncNow, 1200); } else setSync("", "On this device only"); }
async function syncNow() {
  if (!S.token) { setSync("", "On this device only"); return; }
  if (syncing) { again = true; return; }
  syncing = true; setSync("busy", "Syncing…");
  try {
    for (let i = 0; i < 3; i++) {
      const r = await getJson("data.json");
      if (r) D = mergeData(D, r.json);
      const body = JSON.stringify(D, null, 1);
      if (r && JSON.stringify(r.json, null, 1) === body) break;
      try { await gh("/contents/data.json", "PUT", { message: "Update from the app", content: b64enc(body), sha: r?.sha }); break; }
      catch (e) { if (!e.conflict || i === 2) throw e; }
    }
    saveLocal();
    const rw = await getJson("roadworks.json").catch(() => null);
    if (rw) { RW = rw.json; store.set("roadworks", RW); }
    setSync("ok", `Synced ${hm(new Date())}`);
  } catch (e) {
    setSync("bad", navigator.onLine === false ? "Offline, saved on this device" : e.message);
  } finally {
    syncing = false;
    if (again) { again = false; syncNow(); } else if ($("#sheet").hidden) render();
  }
}

/* ---------- trip helpers ---------- */
const trips = () => live(D.trips).sort((a, b) => a.start.localeCompare(b.start));
function curTrip() {
  let t = D.trips.find(x => x.id === S.tripId && !x.deleted);
  if (!t) { const today = ymd(new Date()), ts = trips(); t = ts.find(x => (x.end || x.start) >= today) || ts[ts.length - 1]; if (t) { S.tripId = t.id; saveS(); } }
  return t;
}
const tripDays = t => { const out = []; for (let d = t.start; d <= (t.end || t.start); d = addDays(d, 1)) out.push(d); return out; };
const tripPeople = t => (t.people || []).map(person).filter(Boolean);
const sortSteps = arr => [...arr].sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
const KINDS = { drive: "Drive", train: "Train / bus", walk: "Walk", food: "Food", event: "Event", other: "Other" };
const FOOD = { home: "Bring from home", order: "Order ahead", buy: "Buy on the way", none: "Not needed" };

function analyse(t) {
  const loc = tripLoc(t), buf = buffer(), steps = sortSteps(t.timeline || []), gaps = {}, dark = {}, alerts = [];
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i], n = steps[i + 1];
    if (s.kind === "drive") {
      const st = toDate(s.date, s.time), en = new Date(st.getTime() + (s.mins || 0) * 6e4);
      if (isDark(st, loc) || isDark(en, loc)) dark[s.id] = true;
    }
    if (!n || n.date !== s.date || !s.mins) continue;
    const slack = mins(n.time) - (mins(s.time) + Number(s.mins));
    if (slack < 0) gaps[s.id] = ["warn", `${-slack} min late for “${n.text}”`];
    else if (slack < Math.min(buf, 5) || (n.fixed && slack < buf)) gaps[s.id] = ["warn", `Only ${slack} min spare before “${n.text}”`];
    else if (n.fixed && slack >= buf + 20) gaps[s.id] = ["ok", `${slack} min spare. You could start ${slack - buf} min later.`];
  }
  const tight = Object.values(gaps).filter(g => g[0] === "warn").length;
  if (tight) alerts.push(["warn", "!", tight === 1 ? "One step is too tight" : `${tight} steps are too tight`, "See the orange notes in the timeline."]);
  const spare = steps.filter(s => gaps[s.id]?.[0] === "ok");
  if (spare.length) alerts.push(["ok", "✓", "No need to rush", `${spare[0].text} at ${spare[0].time}: ${gaps[spare[0].id][1]}`]);
  const darkSteps = steps.filter(s => dark[s.id]);
  if (darkSteps.length) {
    const noDark = tripPeople(t).filter(p => p.noDark);
    const badDriver = darkSteps.find(s => s.driver && person(s.driver)?.noDark);
    if (badDriver) alerts.push(["bad", "!", `${person(badDriver.driver).name} is set to drive after dark`, `${badDriver.text} at ${badDriver.time}. Sunset is ${sunset(badDriver.date, loc)}.`]);
    else alerts.push(["night", "☾", `Driving after dark: ${darkSteps.map(s => s.time).join(", ")}`,
      `Sunset ${sunset(darkSteps[0].date, loc)}.` + (noDark.length ? ` ${noDark.map(p => p.name).join(" and ")} can't drive in the dark.` : "")]);
  }
  if (steps.length && t.food?.mode !== "none") {
    const food = steps.filter(s => s.kind === "food");
    if (!food.length) alerts.push(["warn", "!", "No time to eat in the plan", "Add a food step, or bring food you can eat on the way."]);
    else { const short = food.find(s => s.mins && s.mins < 20); if (short) alerts.push(["warn", "!", `Only ${short.mins} min to eat`, t.food?.mode === "home" ? "Good thing you're bringing food." : "Bringing your own food is the safe choice."]); }
  }
  const late = (t.checkins || []).filter(c => !c.done && toDate(...c.due.split("T")) < new Date());
  if (late.length) alerts.push(["warn", "!", late.length === 1 ? "1 check-in is overdue" : `${late.length} check-ins are overdue`, late.map(c => c.text).slice(0, 3).join(" · ")]);
  return { steps, gaps, dark, alerts, loc };
}

/* ---------- views ---------- */
function render() {
  const tab = S.tab || "plan";
  $$("nav button").forEach(b => b.setAttribute("aria-selected", b.dataset.v === tab));
  ({ plan: renderPlan, checks: renderChecks, people: renderPeople, trips: renderTrips })[tab]();
  renderOverview(); renderCount();
  setSync(syncState.s, syncState.msg || (S.token ? "" : "On this device only"));
}
const alertHtml = a => `<div class="alert ${a[0]}"><span class="ic">${a[1]}</span><div><b>${esc(a[2])}</b>${a[3] ? esc(a[3]) : ""}${a[4] || ""}</div></div>`;
const emptyTrip = () => `<div class="empty"><h1>No trips yet</h1><p>Plan your next visit: who, when, food, sleep and what to check with people.</p><button class="btn primary" data-act="new-trip">New trip</button></div>`;

function roadworksHtml(t) {
  const r = RW.trips?.[t.id], hasLoc = (t.route || []).some(id => place(id)?.lat != null);
  const today = ymd(new Date()); if ((t.end || t.start) < today) return "";
  const btn = S.token && hasLoc ? `<div class="btns"><button class="btn" data-act="rw-check">Check now</button></div>` : "";
  if (!hasLoc) return alertHtml(["warn", "i", "Roadworks check is off for this trip", "Add places with a location to the route (Edit trip) and it runs the day before."]);
  if (!r) return alertHtml(["ok", "i", "Roadworks get checked the day before", "Danish roads, plus German motorways when the route goes there.", btn]);
  const when = `Checked ${dayLabel(r.checked.slice(0, 10))} ${r.checked.slice(11, 16)}`;
  if (!r.items.length) return alertHtml(["ok", "✓", "No roadworks found on your route", when + ".", btn]);
  const list = `<ul class="lines">${r.items.slice(0, 6).map(x => `<li><b style="display:inline">${esc(x.title)}</b> near ${esc(x.near)} (${x.km} km)${x.text ? `. ${esc(x.text)}` : ""}</li>`).join("")}</ul>`;
  return alertHtml(["warn", "!", r.items.length === 1 ? "Roadworks on your route" : `${r.items.length} roadworks on your route`, when + ". Plan extra time or another way in or out.", list + btn]);
}

function renderPlan() {
  const t = curTrip(); if (!t) { app.innerHTML = emptyTrip(); return; }
  const a = analyse(t), ppl = tripPeople(t);
  const chips = ppl.map(p => `<span class="chip ${p.noDark ? "night" : ""}">${esc(p.name)}${p.noDark ? " · no driving in the dark" : ""}</span>`).join("")
    + lines(t.others).map(x => `<span class="chip">${esc(x)}</span>`).join("");
  const imp = ppl.flatMap(p => lines(p.important).map(x => [p.name, x]));
  const byDay = tripDays(t).map(day => [day, a.steps.filter(s => s.date === day)]);
  const extra = a.steps.filter(s => !tripDays(t).includes(s.date));
  const stepLi = s => `<li class="${s.fixed ? "fixed" : ""} ${a.dark[s.id] ? "night" : ""}" data-act="edit-step" data-id="${s.id}">
      <span class="t">${esc(s.time)}</span><div class="what">${esc(s.text)}${s.fixed ? `<span class="tag fixed">fixed</span>` : ""}${a.dark[s.id] ? `<span class="tag nt">after dark</span>` : ""}</div>
      <div class="sub">${[s.kind && s.kind !== "other" ? KINDS[s.kind] : "", s.mins ? `${s.mins} min` : "", s.driver && person(s.driver) ? `${person(s.driver).name} drives` : "", s.sub].filter(Boolean).map(esc).join(" · ")}</div>
      ${a.gaps[s.id] ? `<div class="gap ${a.gaps[s.id][0]}">${esc(a.gaps[s.id][1])}</div>` : ""}</li>`;
  const food = t.food || { mode: "", items: [] };
  app.innerHTML = `
    <div class="row"><div class="eyebrow">${esc(range(t))}${t.sleep ? ` · ${esc(t.sleep)}` : ""}</div><button class="btn ghost" data-act="edit-trip">Edit trip</button></div>
    <h1>${esc(t.title)}</h1>
    <div class="who">${chips}</div>
    ${a.alerts.map(alertHtml).join("")}
    ${roadworksHtml(t)}
    ${imp.length ? `<h2>Remember</h2><div class="card"><ul class="lines" style="margin:0">${imp.map(([n, x]) => `<li><span class="imp">${esc(n)}:</span> ${esc(x)}</li>`).join("")}</ul></div>` : ""}
    <h2>Timeline ${a.steps.some(s => s.fixed) ? `<button class="btn ghost" data-act="work-back">Work back from fixed times</button>` : ""}</h2>
    ${a.steps.length ? byDay.map(([day, st]) => st.length ? `<div class="day">${dayLabel(day)} · sunset ${sunset(day, a.loc)}</div><ul class="tl">${st.map(stepLi).join("")}</ul>` : "").join("")
      + (extra.length ? `<div class="day">Outside the trip dates</div><ul class="tl">${extra.map(stepLi).join("")}</ul>` : "")
      : `<p class="muted small">Add the times that can't move first (a concert, someone finishing work), mark them as fixed, then add the steps before them with how long each takes. “Work back” fills in the start times.</p>`}
    <button class="add" data-act="add-step">+ Add step</button>

    <h2>Food</h2>
    <div class="card stack">
      <div class="seg" role="group" aria-label="How will you eat?">${Object.entries(FOOD).map(([k, v]) => `<button data-act="food-mode" data-mode="${k}" aria-pressed="${food.mode === k}">${v}</button>`).join("")}</div>
      ${(food.items || []).map((x, i) => `<div class="row click" data-act="edit-food" data-i="${i}"><span>${esc(x.text)}</span><span class="k">${esc(x.when)}</span></div>`).join("")}
      <div class="btns" style="margin:0"><button class="btn" data-act="add-food">+ Add food item</button>${food.mode && food.mode !== "none" ? `<button class="btn" data-act="food-checks">Add food reminders</button>` : ""}</div>
    </div>

    <h2>Sleep and getting back <button class="btn ghost" data-act="edit-trip">Edit</button></h2>
    <div class="card"><dl class="plan">
      <dt>Sleep</dt><dd>${esc(t.sleep) || `<span class="muted">Not set</span>`}</dd>
      <dt>Back</dt><dd>${esc(t.back) || `<span class="muted">Not set</span>`}</dd>
      <dt>Route</dt><dd>${(t.route || []).map(place).filter(Boolean).map(p => esc(p.name)).join(" → ") || `<span class="muted">Not set</span>`}</dd>
      ${t.notes ? `<dt>Notes</dt><dd>${esc(t.notes).replace(/\n/g, "<br>")}</dd>` : ""}
    </dl></div>

    <h2>If things go wrong</h2>
    <div class="card stack">
      ${(t.backup || []).map((b, i) => `<div class="row click" data-act="edit-backup" data-i="${i}"><span>${esc(b.if)}</span><span class="k">${esc(b.then)}</span></div>`).join("") || `<span class="muted small">Backup plans: a later train, another way out of town, where to eat if there's no time.</span>`}
      <button class="btn" style="justify-self:start" data-act="add-backup">+ Add backup plan</button>
    </div>

    <h2>After the trip</h2>
    <div class="card click" data-act="edit-review">${t.review ? esc(t.review).replace(/\n/g, "<br>") : `<span class="muted">What went wrong or could be easier next time? Tap to write it down, and save it to a person or place for next time.</span>`}</div>`;
}

function renderChecks() {
  const t = curTrip(); if (!t) { app.innerHTML = emptyTrip(); return; }
  const cs = [...(t.checkins || [])].sort((a, b) => a.due.localeCompare(b.due));
  const open = cs.filter(c => !c.done), done = cs.filter(c => c.done), n = new Date();
  const item = c => { const d = toDate(...c.due.split("T")), late = !c.done && d < n;
    return `<div class="card check ${c.done ? "done" : ""}"><button class="box" data-act="toggle-check" data-id="${c.id}" aria-label="Done">${c.done ? "✓" : ""}</button>
      <div class="ct" data-act="edit-check" data-id="${c.id}"><div>${esc(c.text)}</div><div class="when ${late ? "late" : ""}">${c.who && person(c.who) ? esc(person(c.who).name) + " · " : ""}${dayLabel(c.due.slice(0, 10))} ${c.due.slice(11, 16)}${late ? " · overdue" : ""}</div></div></div>`; };
  app.innerHTML = `
    <div class="eyebrow">${esc(t.title)}</div>
    <h1>Check with people</h1>
    <p class="muted small">You get a push at each time. Tick it off once you've confirmed.</p>
    <div class="stack">${open.map(item).join("") || `<div class="empty">Nothing left to check.</div>`}</div>
    <div class="btns"><button class="btn primary" data-act="add-check">+ Add check-in</button><button class="btn" data-act="suggest-checks">Add suggested check-ins</button></div>
    ${done.length ? `<h2>Done</h2><div class="stack">${done.map(item).join("")}</div>` : ""}`;
}

function renderPeople() {
  const ppl = live(D.people).sort((a, b) => a.name.localeCompare(b.name)), pls = live(D.places).sort((a, b) => a.name.localeCompare(b.name));
  app.innerHTML = `
    <h1>People and places</h1>
    <p class="muted small">Every trip uses these. Write things down once, like who can't drive in the dark or when someone usually shops.</p>
    <h2>People</h2>
    <div class="stack">${ppl.map(p => `<div class="card click" data-act="edit-person" data-id="${p.id}"><h3>${esc(p.name)}${p.me ? ` <span class="tag kind">me</span>` : ""}</h3>
      <ul class="lines">${p.noDark ? `<li class="imp">Can't drive in the dark</li>` : ""}${lines(p.important).map(x => `<li class="imp">${esc(x)}</li>`).join("")}${lines(p.notes).map(x => `<li>${esc(x)}</li>`).join("")}${p.askDays ? `<li class="muted">Ask about errands ${p.askDays} days before</li>` : ""}</ul></div>`).join("")}
      <button class="add" data-act="add-person">+ Add person</button></div>
    <h2>Places</h2>
    <div class="stack">${pls.map(p => `<div class="card click" data-act="edit-place" data-id="${p.id}"><h3>${esc(p.name)}</h3>
      <div class="muted small">${esc(p.address) || "No address"}${p.lat != null ? " · location set" : " · no location yet"}</div>
      ${lines(p.notes).length ? `<ul class="lines">${lines(p.notes).map(x => `<li>${esc(x)}</li>`).join("")}</ul>` : ""}</div>`).join("")}
      <button class="add" data-act="add-place">+ Add place</button></div>`;
}

function renderTrips() {
  const today = ymd(new Date()), ts = trips();
  const up = ts.filter(t => (t.end || t.start) >= today), past = ts.filter(t => (t.end || t.start) < today).reverse();
  const card = t => { const cs = t.checkins || [], rw = RW.trips?.[t.id];
    return `<div class="card click" data-act="open-trip" data-id="${t.id}" ${t.id === S.tripId ? `style="border-color:var(--accent)"` : ""}><div class="eyebrow">${esc(range(t))}</div><div style="font-weight:600;margin-top:2px">${esc(t.title)}</div>
    <div class="muted small">${[tripPeople(t).map(p => p.name).join(", "), cs.length ? `${cs.filter(c => c.done).length} of ${cs.length} check-ins done` : "", rw?.items?.length ? `${rw.items.length} roadworks` : ""].filter(Boolean).map(esc).join(" · ")}</div></div>`; };
  app.innerHTML = `
    <h1>Trips</h1>
    <div class="stack" style="margin-top:14px">${up.map(card).join("") || `<div class="muted small">No upcoming trips.</div>`}
      <button class="add" data-act="new-trip">+ New trip</button></div>
    ${past.length ? `<h2>Earlier trips</h2><div class="stack">${past.map(card).join("")}</div>` : ""}
    <h2>Settings</h2>
    <div class="card stack">
      <div class="row"><span>Sync</span><span class="k">${S.token ? esc(syncState.msg || "Connected") : "Not connected"}</span></div>
      <div class="row"><span>Buffer before fixed times</span><span class="k">${buffer()} min</span></div>
      <div class="btns" style="margin:0"><button class="btn" data-act="settings">Change settings</button>${S.token ? `<button class="btn" data-act="sync">Sync now</button>` : ""}
        <button class="btn" data-act="export">Download backup</button><button class="btn" data-act="import">Restore backup</button></div>
    </div>`;
}

function renderOverview() {
  const t = curTrip(), ov = $("#ov");
  $("#ov-btn").hidden = !t;
  if (!t) { ov.hidden = true; return; }
  const food = t.food || {};
  ov.innerHTML = `<div class="eyebrow">${esc(t.title)}</div><dl class="plan">
    <dt>When</dt><dd>${esc(range(t))}</dd>
    <dt>People</dt><dd>${esc([...tripPeople(t).map(p => p.name), ...lines(t.others)].join(", ") || "Not set")}</dd>
    <dt>Food</dt><dd>${esc(FOOD[food.mode] || "Not set")}${food.items?.[0] ? `<br><span class="muted small">${esc(food.items.map(x => x.text).join(", "))}</span>` : ""}</dd>
    <dt>Sleep</dt><dd>${esc(t.sleep || "Not set")}</dd>
    <dt>Back</dt><dd>${esc(t.back || "Not set")}</dd></dl>`;
}
function renderCount() {
  const t = curTrip(), el = $("#cnt"); if (!t) { el.hidden = true; return; }
  const soon = new Date(Date.now() + 864e5), n = (t.checkins || []).filter(c => !c.done && toDate(...c.due.split("T")) < soon).length;
  el.hidden = !n; el.textContent = n;
}

/* ---------- sheet (editor) ---------- */
function openSheet(html, onSave, onDelete) {
  const sh = $("#sheet"), p = $(".panel", sh);
  p.innerHTML = `${html}<div class="btns" style="justify-content:space-between;margin-top:18px">
    <div>${onDelete ? `<button class="btn danger" data-sh="del">Delete</button>` : ""}</div>
    <div class="btns" style="margin:0"><button class="btn" data-sh="cancel">Cancel</button><button class="btn primary" data-sh="save">Save</button></div></div>`;
  p.onchange = null; sh.hidden = false;
  const f = p.querySelector("input,textarea,select"); if (f && matchMedia("(min-width:700px)").matches) f.focus();
  p.onclick = e => {
    const b = e.target.closest("[data-sh]"); if (!b) return;
    if (b.dataset.sh === "cancel") return closeSheet();
    if (b.dataset.sh === "del") { if (b.dataset.sure) { onDelete(); closeSheet(); } else { b.dataset.sure = 1; b.textContent = "Tap again to delete"; } return; }
    if (b.dataset.sh === "save") { const v = {}; $$("[name]", p).forEach(el => v[el.name] = el.type === "checkbox" ? el.checked : el.value.trim());
      if (onSave(v, p) !== false) closeSheet(); }
  };
}
function closeSheet() { $("#sheet").hidden = true; render(); }
$("#sheet").addEventListener("click", e => { if (e.target.id === "sheet") closeSheet(); });
document.addEventListener("keydown", e => { if (e.key === "Escape" && !$("#sheet").hidden) closeSheet(); });
const fld = (label, name, val = "", type = "text", extra = "") => `<div class="f"><label for="f-${name}">${label}</label>${type === "textarea"
  ? `<textarea id="f-${name}" name="${name}" ${extra}>${esc(val)}</textarea>` : `<input id="f-${name}" name="${name}" type="${type}" value="${esc(val)}" ${extra}>`}</div>`;
const sel = (label, name, opts, val) => `<div class="f"><label for="f-${name}">${label}</label><select id="f-${name}" name="${name}">${opts.map(([v, l]) => `<option value="${esc(v)}" ${v === val ? "selected" : ""}>${esc(l)}</option>`).join("")}</select></div>`;
const cb = (label, name, on) => `<label class="cb"><input type="checkbox" name="${name}" ${on ? "checked" : ""}> ${label}</label>`;
let toastT;
function toast(msg, undo) {
  $(".toast")?.remove(); clearTimeout(toastT);
  const el = document.createElement("div"); el.className = "toast"; el.innerHTML = `<span>${esc(msg)}</span>${undo ? `<button>Undo</button>` : ""}`;
  document.body.append(el); if (undo) el.querySelector("button").onclick = () => { undo(); el.remove(); };
  toastT = setTimeout(() => el.remove(), 6000);
}

/* ---------- editors ---------- */
function editTrip(t) {
  const isNew = !t, ppl = live(D.people), pls = live(D.places), today = ymd(new Date());
  t = t || { id: uid(), title: "", start: addDays(today, 7), end: addDays(today, 8), people: ppl.filter(p => p.me).map(p => p.id), route: [], timeline: [], checkins: [], backup: [], food: { mode: "", items: [] } };
  let route = [...(t.route || [])];
  const routeHtml = () => route.map((id, i) => `<div class="row" style="margin-top:6px"><span>${i + 1}. ${esc(place(id)?.name || "?")}</span><button class="btn ghost" data-rm="${i}">Remove</button></div>`).join("") || `<div class="muted small">No places yet. The roadworks check uses these, in order.</div>`;
  openSheet(`<h2 style="margin-top:0">${isNew ? "New trip" : "Edit trip"}</h2>
    ${isNew && trips().length ? sel("Start from an earlier trip (copies people, route, timeline and check-ins)", "copy", [["", "Start blank"], ...trips().reverse().map(x => [x.id, `${x.title} (${dayLabel(x.start)})`])], "") : ""}
    ${fld("Name", "title", t.title, "text", `placeholder="Dinner with gf's parents"`)}
    <div class="f2">${fld("First day", "start", t.start, "date")}${fld("Last day", "end", t.end || t.start, "date")}</div>
    <div class="f"><label>Who's coming</label><div class="picks">${ppl.map(p => `<label><input type="checkbox" data-person="${p.id}" ${(t.people || []).includes(p.id) ? "checked" : ""}>${esc(p.name)}</label>`).join("") || `<span class="muted small">Add people under People first.</span>`}</div></div>
    ${fld("Others there (one per line)", "others", t.others || "", "textarea", `style="min-height:56px" placeholder="Her brother"`)}
    ${fld("Where you sleep", "sleep", t.sleep || "", "text", `placeholder="Mom's spare room"`)}
    ${fld("Getting back", "back", t.back || "", "text", `placeholder="Sun, train 11:30"`)}
    <div class="f"><label>Route</label><div id="route">${routeHtml()}</div>
      ${pls.length ? `<select id="addroute"><option value="">+ Add place to route</option>${pls.map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join("")}</select>` : `<span class="muted small">Add places under People first.</span>`}</div>
    ${fld("Notes", "notes", t.notes || "", "textarea")}`,
    v => {
      if (!v.title) { toast("Give the trip a name"); return false; }
      if (v.end < v.start) v.end = v.start;
      const src = v.copy && D.trips.find(x => x.id === v.copy);
      if (src) {
        const shift = daysBetween(src.start, v.start), sh = d => addDays(d, shift), c = JSON.parse(JSON.stringify(src));
        Object.assign(t, { people: c.people, others: c.others, sleep: c.sleep, back: c.back, route: c.route, backup: c.backup, food: c.food,
          timeline: (c.timeline || []).map(s => ({ ...s, id: uid(), date: sh(s.date) })),
          checkins: (c.checkins || []).map(x => ({ ...x, id: uid(), done: false, due: sh(x.due.slice(0, 10)) + x.due.slice(10) })) });
      }
      Object.assign(t, { title: v.title, start: v.start, end: v.end, notes: v.notes });
      for (const k of ["sleep", "back", "others"]) t[k] = v[k] || (src ? t[k] || "" : "");
      if (!src) { t.people = $$("[data-person]", $("#sheet")).filter(x => x.checked).map(x => x.dataset.person); t.route = route; }
      if (isNew) D.trips.push(t);
      S.tripId = t.id; S.tab = "plan"; saveS(); touch(t);
    },
    isNew ? null : () => { t.deleted = true; touch(t); S.tripId = ""; saveS(); });
  $("#sheet .panel").onchange = e => { if (e.target.id === "addroute" && e.target.value) { route.push(e.target.value); e.target.value = ""; $("#route").innerHTML = routeHtml(); } };
  $("#route").onclick = e => { const b = e.target.closest("[data-rm]"); if (b) { route.splice(+b.dataset.rm, 1); $("#route").innerHTML = routeHtml(); } };
}

function editStep(t, s) {
  const isNew = !s, days = tripDays(t), ppl = tripPeople(t);
  s = s || { id: uid(), date: days[0], time: "12:00", text: "", sub: "", mins: "", fixed: false, kind: "other", driver: "" };
  openSheet(`<h2 style="margin-top:0">${isNew ? "Add step" : "Edit step"}</h2>
    ${fld("What happens", "text", s.text, "text", `placeholder="Pick up sister from work"`)}
    <div class="f2">${sel("Day", "date", [...new Set([...days, s.date])].map(d => [d, dayLabel(d)]), s.date)}${fld("Time", "time", s.time, "time")}</div>
    <div class="f2">${sel("Type", "kind", Object.entries(KINDS), s.kind || "other")}${fld("Takes (min, incl. travel to next)", "mins", s.mins, "number", `min="0" inputmode="numeric"`)}</div>
    ${cb("Fixed time (can't move, like a concert or someone finishing work)", "fixed", s.fixed)}
    ${sel("Who drives", "driver", [["", "Not set"], ...ppl.map(p => [p.id, p.name + (p.noDark ? " (no driving in the dark)" : "")])], s.driver || "")}
    ${fld("Details", "sub", s.sub, "text", `placeholder="Off at 18:15 + 5 min walk"`)}`,
    v => { if (!v.text) { toast("Write what happens"); return false; }
      Object.assign(s, { text: v.text, date: v.date, time: v.time || "12:00", kind: v.kind, mins: v.mins ? Number(v.mins) : "", fixed: v.fixed, driver: v.driver, sub: v.sub });
      if (isNew) (t.timeline = t.timeline || []).push(s); touch(t); },
    isNew ? null : () => { t.timeline = t.timeline.filter(x => x.id !== s.id); touch(t); });
}

function workBack(t) {
  const before = JSON.stringify(t.timeline), buf = buffer(); let changed = 0;
  for (const day of new Set(t.timeline.map(s => s.date))) {
    const st = sortSteps(t.timeline.filter(s => s.date === day));
    for (let j = 0; j < st.length; j++) {
      if (!st[j].fixed) continue;
      let cursor = mins(st[j].time) - buf;
      for (let k = j - 1; k >= 0 && !st[k].fixed && st[k].mins; k--) {
        const start = Math.floor((cursor - st[k].mins) / 5) * 5;
        if (st[k].time !== fromMins(start)) { st[k].time = fromMins(start); changed++; }
        cursor = start;
      }
    }
  }
  if (!changed) { toast("Times already line up. Steps need a length in minutes to be moved."); return; }
  touch(t); render();
  toast(`Moved ${changed} step${changed > 1 ? "s" : ""} to fit the fixed times`, () => { t.timeline = JSON.parse(before); touch(t); render(); });
}

function editCheck(t, c, preset) {
  const isNew = !c, ppl = live(D.people).filter(p => !p.me);
  c = c || { id: uid(), text: "", who: "", due: `${addDays(t.start, -3)}T17:00`, done: false, ...preset };
  openSheet(`<h2 style="margin-top:0">${isNew ? "Add check-in" : "Edit check-in"}</h2>
    ${fld("What to check", "text", c.text, "text", `placeholder="Ask Mom if she can pick up milk"`)}
    ${sel("With whom", "who", [["", "No one in particular"], ...ppl.map(p => [p.id, p.name])], c.who || "")}
    <div class="f2">${fld("Remind me on", "day", c.due.slice(0, 10), "date")}${fld("At", "time", c.due.slice(11, 16), "time")}</div>
    ${isNew ? "" : cb("Done", "done", c.done)}`,
    v => { if (!v.text) { toast("Write what to check"); return false; }
      Object.assign(c, { text: v.text, who: v.who, due: `${v.day}T${v.time || "17:00"}`, done: isNew ? false : v.done });
      if (isNew) (t.checkins = t.checkins || []).push(c); touch(t); },
    isNew ? null : () => { t.checkins = t.checkins.filter(x => x.id !== c.id); touch(t); });
}

function addChecks(t, list) {
  const have = new Set((t.checkins || []).map(c => c.text.toLowerCase())), add = list.filter(c => !have.has(c.text.toLowerCase()));
  if (!add.length) { toast("Those check-ins are already there"); return; }
  t.checkins = [...(t.checkins || []), ...add.map(c => ({ id: uid(), done: false, who: "", ...c }))]; touch(t); render();
  toast(`Added ${add.length} check-in${add.length > 1 ? "s" : ""}`, () => { const ids = new Set(add.map(c => c.text)); t.checkins = t.checkins.filter(c => !ids.has(c.text) || c.done); touch(t); render(); });
}
function suggestChecks(t) {
  const today = ymd(new Date()), d = (n, time) => { let day = addDays(t.start, -n); if (day < today) day = today; return `${day}T${time}`; }, out = [];
  for (const p of tripPeople(t).filter(p => !p.me)) {
    if (p.askDays) out.push({ text: `Ask ${p.name} about errands or anything to bring`, who: p.id, due: d(Number(p.askDays), "17:00") });
    out.push({ text: `Confirm times with ${p.name}`, who: p.id, due: d(2, "17:00") });
  }
  out.push({ text: "Tell the hosts who's coming, when you arrive and when you leave", due: d(5, "17:00") });
  out.push({ text: "Ask who else will be there and what the plans are", due: d(5, "17:05") });
  out.push({ text: "Recheck the timeline, tickets and route", due: d(1, "18:00") });
  out.push({ text: "Pack overnight bag", due: d(1, "20:00") });
  out.push({ text: "What went wrong? Write it in “After the trip”", due: `${t.end || t.start}T20:00` });
  addChecks(t, out);
}
function foodChecks(t) {
  const mode = t.food?.mode, first = sortSteps(t.timeline || [])[0], leave = first ? fromMins(Math.max(mins(first.time) - 90, 8 * 60)) : "12:00", out = [];
  if (mode === "home") { out.push({ text: "Buy food for the trip (add to grocery list)", due: `${addDays(t.start, -2)}T16:00` }); out.push({ text: "Make the food and pack snacks and water", due: `${t.start}T${leave}` }); }
  if (mode === "order") out.push({ text: "Order food ahead", due: `${addDays(t.start, -1)}T18:00` });
  if (mode === "buy") out.push({ text: "Pick where to stop for food on the way", due: `${addDays(t.start, -1)}T18:00` });
  addChecks(t, out);
}
function editFood(t, i) {
  const isNew = i == null, it = isNew ? { text: "", when: "" } : t.food.items[i];
  openSheet(`<h2 style="margin-top:0">${isNew ? "Add food item" : "Edit food item"}</h2>
    ${fld("What", "text", it.text, "text", `placeholder="Sandwiches for 4"`)}${fld("When / where", "when", it.when, "text", `placeholder="Make Sat 14:30"`)}`,
    v => { if (!v.text) return false; t.food = t.food || { mode: "", items: [] }; t.food.items = t.food.items || [];
      if (isNew) t.food.items.push(v); else t.food.items[i] = v; touch(t); },
    isNew ? null : () => { t.food.items.splice(i, 1); touch(t); });
}
function editBackup(t, i) {
  const isNew = i == null, it = isNew ? { if: "", then: "" } : t.backup[i];
  openSheet(`<h2 style="margin-top:0">${isNew ? "Add backup plan" : "Edit backup plan"}</h2>
    ${fld("If", "if", it.if, "text", `placeholder="We miss the train"`)}${fld("Then", "then", it.then, "text", `placeholder="Next one is 30 min later"`)}`,
    v => { if (!v.if) return false; t.backup = t.backup || []; if (isNew) t.backup.push(v); else t.backup[i] = v; touch(t); },
    isNew ? null : () => { t.backup.splice(i, 1); touch(t); });
}
function editReview(t) {
  const targets = [...tripPeople(t).filter(p => !p.me).map(p => ["person:" + p.id, p.name]), ...(t.route || []).map(place).filter(Boolean).map(p => ["place:" + p.id, p.name])];
  openSheet(`<h2 style="margin-top:0">After the trip</h2>
    ${fld("What went wrong or could be easier?", "review", t.review || "", "textarea", `placeholder="Sister is off at 18:15, not 18:00"`)}
    ${targets.length ? `${fld("Lesson to remember next time (optional)", "lesson", "", "text", `placeholder="Off at 18:15 + 5 min walk"`)}${sel("Save the lesson on", "target", [["", "Don't save"], ...targets], "")}` : ""}`,
    v => { t.review = v.review; touch(t);
      if (v.lesson && v.target) { const [kind, id] = v.target.split(":"), o = kind === "person" ? person(id) : place(id);
        if (o) { o.notes = [o.notes, v.lesson].filter(Boolean).join("\n"); touch(o); toast(`Saved on ${o.name}'s card`); } } });
}
function editPerson(p) {
  const isNew = !p; p = p || { id: uid(), name: "", important: "", notes: "", noDark: false, askDays: "", me: false };
  openSheet(`<h2 style="margin-top:0">${isNew ? "Add person" : p.name}</h2>
    ${fld("Name", "name", p.name)}
    ${cb("Can't drive in the dark", "noDark", p.noDark)}
    ${fld("Important to remember (one per line, shown on every trip)", "important", p.important, "textarea", `placeholder="Allergic to nuts"`)}
    ${fld("Notes (one per line)", "notes", p.notes, "textarea", `placeholder="Saturdays off at 18:15, 5 min walk to pick-up"`)}
    ${fld("Ask about errands how many days before?", "askDays", p.askDays, "number", `min="0" inputmode="numeric" placeholder="4"`)}
    ${cb("This is me", "me", p.me)}`,
    v => { if (!v.name) return false; Object.assign(p, { ...v, askDays: v.askDays ? Number(v.askDays) : "" }); if (isNew) D.people.push(p); touch(p); },
    isNew ? null : () => { p.deleted = true; touch(p); });
}
function editPlace(p) {
  const isNew = !p; p = p || { id: uid(), name: "", address: "", lat: null, lon: null, notes: "" };
  openSheet(`<h2 style="margin-top:0">${isNew ? "Add place" : p.name}</h2>
    ${fld("Name", "name", p.name, "text", `placeholder="Mom's house"`)}
    ${fld("Address or town", "address", p.address, "text", `placeholder="Vestergade 1, Odense"`)}
    <div class="btns"><button class="btn" id="geo" type="button">Find location</button><span class="muted small" id="geo-out">${p.lat != null ? `Location: ${p.lat.toFixed(4)}, ${p.lon.toFixed(4)}` : "Needed for roadworks and sunset times"}</span></div>
    <input type="hidden" name="lat" value="${p.lat ?? ""}"><input type="hidden" name="lon" value="${p.lon ?? ""}">
    ${fld("Notes (one per line)", "notes", p.notes, "textarea", `placeholder="Parking behind the house"`)}`,
    v => { if (!v.name) return false; Object.assign(p, { name: v.name, address: v.address, notes: v.notes, lat: v.lat ? Number(v.lat) : null, lon: v.lon ? Number(v.lon) : null });
      if (isNew) D.places.push(p); touch(p); },
    isNew ? null : () => { p.deleted = true; touch(p); });
  $("#geo").onclick = async () => {
    const q = $("#f-address").value.trim() || $("#f-name").value.trim(), out = $("#geo-out"); if (!q) return;
    out.textContent = "Searching…";
    try {
      const r = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=dk,de&q=${encodeURIComponent(q)}`, { headers: { "Accept-Language": "en" } });
      const j = (await r.json())[0];
      if (!j) { out.textContent = "Not found. Try the town name."; return; }
      $("[name=lat]").value = j.lat; $("[name=lon]").value = j.lon; out.textContent = `Found: ${j.display_name.split(",").slice(0, 3).join(",")}`;
    } catch { out.textContent = "Couldn't search. Are you online?"; }
  };
}
function editSettings() {
  openSheet(`<h2 style="margin-top:0">Settings</h2>
    ${fld("GitHub token (syncs your trips between devices)", "token", S.token, "password", `autocomplete="off" placeholder="github_pat_…"`)}
    <p class="muted small">Make a fine-grained token on GitHub for only the <code>Visit-Planner-Data</code> repo with <b>Contents</b> and <b>Actions</b> set to read and write. It stays on this device.</p>
    ${fld("Buffer before fixed times (min)", "buffer", buffer(), "number", `min="0" inputmode="numeric"`)}`,
    v => { const changed = v.token !== S.token; S.token = v.token; saveS();
      if (Number(v.buffer) !== buffer()) { D.settings = { bufferMin: Number(v.buffer) || 0, updated: now() }; saveLocal(); queueSync(); }
      if (changed) syncNow(); });
}

/* ---------- actions ---------- */
document.addEventListener("click", async e => {
  const b = e.target.closest("[data-act]"); if (!b || b.closest("#sheet")) return;
  const t = curTrip(), id = b.dataset.id, act = b.dataset.act;
  if (act === "new-trip") editTrip();
  else if (act === "edit-trip") editTrip(t);
  else if (act === "open-trip") { S.tripId = id; S.tab = "plan"; saveS(); render(); scrollTo(0, 0); }
  else if (act === "add-step") editStep(t);
  else if (act === "edit-step") editStep(t, t.timeline.find(s => s.id === id));
  else if (act === "work-back") workBack(t);
  else if (act === "food-mode") { t.food = t.food || { items: [] }; t.food.mode = b.dataset.mode; touch(t); render(); }
  else if (act === "add-food") editFood(t);
  else if (act === "edit-food") editFood(t, +b.dataset.i);
  else if (act === "food-checks") foodChecks(t);
  else if (act === "add-backup") editBackup(t);
  else if (act === "edit-backup") editBackup(t, +b.dataset.i);
  else if (act === "edit-review") editReview(t);
  else if (act === "add-check") editCheck(t);
  else if (act === "edit-check") editCheck(t, t.checkins.find(c => c.id === id));
  else if (act === "toggle-check") { const c = t.checkins.find(c => c.id === id); c.done = !c.done; touch(t); render(); }
  else if (act === "suggest-checks") suggestChecks(t);
  else if (act === "add-person") editPerson();
  else if (act === "edit-person") editPerson(person(id));
  else if (act === "add-place") editPlace();
  else if (act === "edit-place") editPlace(place(id));
  else if (act === "settings") editSettings();
  else if (act === "sync") syncNow();
  else if (act === "export") {
    const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([JSON.stringify(D, null, 1)], { type: "application/json" }));
    a.download = `visit-planner-${ymd(new Date())}.json`; a.click();
  } else if (act === "import") {
    const inp = document.createElement("input"); inp.type = "file"; inp.accept = ".json,application/json";
    inp.onchange = async () => { try { const j = JSON.parse(await inp.files[0].text()); if (!Array.isArray(j.trips)) throw 0;
      D = mergeData(D, j); saveLocal(); queueSync(); render(); toast("Backup restored"); } catch { toast("That file isn't a Visit Planner backup"); } };
    inp.click();
  } else if (act === "rw-check") {
    try { await gh("/actions/workflows/remind.yml/dispatches", "POST", { ref: "main", inputs: { trip: t.id } });
      toast("Checking the route. Results show up in about a minute."); setTimeout(syncNow, 70000); }
    catch (err) { toast(err.message.includes("refused") ? "The token needs Actions: read and write for this." : err.message); }
  }
});
$$("nav button").forEach(b => b.onclick = () => { S.tab = b.dataset.v; saveS(); render(); scrollTo(0, 0); });
$("#ov-btn").onclick = () => { const ov = $("#ov"); ov.hidden = !ov.hidden; $("#ov-btn").setAttribute("aria-expanded", !ov.hidden); $("#ov-btn").textContent = ov.hidden ? "Overview" : "Close"; };

render();
syncNow();
addEventListener("online", syncNow);
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") syncNow(); });
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
