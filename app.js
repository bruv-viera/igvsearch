/* Rating study for interactive geovisualisations (redesigned)
   Static site. Answers stay in the browser until the participant sends them.

   Redesign: 3 queries x 4 items = 12 pairs per participant (9 groups),
   plus EXACTLY 3 short "why" comments -- one randomly chosen item per query. */

/* ---------- configuration ---------- */
const EMAIL = "viera.mlilo@tum.de";
const SUBMIT_URL = "https://formspree.io/f/mvzewywp";
// Google Apps Script web-app URL: does first-come-first-serve group assignment
// AND stores submissions. Leave "" to fall back to the 9 ?v= links + Formspree.
const WEBAPP_URL = "https://script.google.com/macros/s/AKfycbyfP_rs12u0PP249B7PSLZcOwvZgXzvU6XBeu9N7wdDe1ZiYHSxvrCxmTnpPJ46GPr-/exec";
const STORE = "igv-study-v2";

const $ = id => document.getElementById(id);
const screens = ["intro", "task", "review", "done"];
const show = name => screens.forEach(s => $(s).hidden = (s !== name));

let DATA = null;         // items.json
let PAIRS = [];          // the pairs this participant rates
let COMMENT = new Set(); // keys of the items that carry a "why" prompt
let state = null;        // {pid, version, startedAt, ratings, qualitative, comment, idx}
let PAYLOAD = "";

/* ---------- helpers ---------- */
function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function seededShuffle(arr, seed) {
  const a = arr.slice();
  let s = seed || 1;
  const rnd = () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
const newPid = () => "p-" + Math.random().toString(36).slice(2, 5);
const key = p => `${p.query_id}::${p.item.igv_id}`;

function save() { try { localStorage.setItem(STORE, JSON.stringify(state)); } catch (e) {} }
function load() { try { return JSON.parse(localStorage.getItem(STORE)); } catch (e) { return null; } }

/* ---------- session ---------- */
function buildPairs(version, pid) {
  const out = [];
  (DATA.versions[String(version)] || []).forEach(qid => {
    const q = DATA.queries.find(x => x.query_id === qid);
    if (!q) return;
    seededShuffle(q.items, hash(pid + qid)).forEach(item => {
      out.push({ query_id: q.query_id, query_text: q.query_text, item });
    });
  });
  return out;
}

// one randomly chosen item per query gets the qualitative prompt (seeded, stable on resume)
function buildCommentKeys(version, pid) {
  const set = new Set();
  const n = DATA.comments_per_query || 1;
  (DATA.versions[String(version)] || []).forEach(qid => {
    const q = DATA.queries.find(x => x.query_id === qid);
    if (!q || !q.items.length) return;
    const order = seededShuffle(q.items, hash(pid + qid + "why"));
    order.slice(0, n).forEach(item => set.add(`${qid}::${item.igv_id}`));
  });
  return set;
}

const groupCount = () => Object.keys(DATA.versions).length;

// first-come-first-serve group from the web-app counter; random fallback if unreachable.
// Uses JSONP because a cross-origin GitHub Pages page cannot read a normal Apps Script
// fetch response (Apps Script sends no CORS headers); a <script> tag is not CORS-bound.
function assignGroup() {
  const rnd = () => 1 + Math.floor(Math.random() * groupCount());
  if (!WEBAPP_URL) return Promise.resolve(rnd());
  return new Promise(resolve => {
    const cb = "__assign" + Date.now();
    const s = document.createElement("script");
    let done = false;
    const finish = g => { if (done) return; done = true;
      try { delete window[cb]; } catch (e) { window[cb] = undefined; }
      s.remove(); resolve(g); };
    window[cb] = d => finish(d && d.group && DATA.versions[String(d.group)] ? Number(d.group) : rnd());
    s.onerror = () => finish(rnd());
    setTimeout(() => finish(rnd()), 8000);   // network/deploy problem -> random group
    s.src = WEBAPP_URL + "?action=assign&callback=" + cb;
    document.body.appendChild(s);
  });
}

function buildScale() {
  const box = $("scale");
  box.innerHTML = "";
  DATA.scale.forEach(s => {
    const b = document.createElement("button");
    b.type = "button"; b.className = "opt";
    b.setAttribute("role", "radio"); b.setAttribute("aria-checked", "false");
    b.dataset.value = s.value;
    b.innerHTML = `<span class="opt__sw sw-${s.value}"></span>` +
                  `<span class="opt__n">${s.value}</span>` +
                  `<span class="opt__t">${s.label}</span>`;
    b.addEventListener("click", () => setRating(s.value));
    box.appendChild(b);
  });
}

function setRating(v) {
  const p = PAIRS[state.idx];
  state.ratings[key(p)] = { query_id: p.query_id, igv_id: p.item.igv_id, rating: v,
                            position: state.idx + 1, rated_at: new Date().toISOString() };
  save();
  paintScale();
  refreshNext();
  // don't auto-skip past an item that still needs a written comment
  if (COMMENT.has(key(p))) return;
  setTimeout(() => { if (state.idx < PAIRS.length - 1) go(state.idx + 1); else renderReview(); }, 190);
}

function paintScale() {
  const r = state.ratings[key(PAIRS[state.idx])];
  document.querySelectorAll(".opt").forEach(o =>
    o.setAttribute("aria-checked", r && String(r.rating) === o.dataset.value ? "true" : "false"));
}

// an item is "complete" when it has a rating (and a comment too, if this item asks for one)
function currentComplete() {
  const p = PAIRS[state.idx];
  const rated = !!state.ratings[key(p)];
  const needComment = COMMENT.has(key(p));
  const hasComment = !!(state.qualitative && state.qualitative[key(p)]);
  return rated && (!needComment || hasComment);
}
function refreshNext() {
  const done = currentComplete();
  $("nextBtn").disabled = !done;
  $("nextBtn").title = done ? ""
    : (COMMENT.has(key(PAIRS[state.idx])) ? "Rate this map and add a comment to continue"
                                          : "Choose a rating to continue");
}

function go(i) {
  state.idx = Math.max(0, Math.min(i, PAIRS.length - 1));
  save();
  const p = PAIRS[state.idx];

  $("qId").textContent = p.query_id;
  $("qText").textContent = p.query_text;
  $("itemTitle").textContent = p.item.title || "(untitled)";
  $("itemDesc").textContent = p.item.description || "";
  $("itemDesc").hidden = !p.item.description;
  $("itemId").textContent = p.item.igv_id;

  const link = $("itemLink");
  if (p.item.url) { link.href = p.item.url; link.hidden = false; } else { link.hidden = true; }

  const img = $("itemImg"), no = $("itemNoImg");
  if (p.item.preview) {
    img.src = p.item.preview;
    img.alt = "Preview of " + (p.item.title || "this geovisualisation");
    img.hidden = false; no.hidden = true;
    img.onerror = () => { img.hidden = true; no.hidden = false; };
  } else { img.hidden = true; no.hidden = false; }

  // qualitative "why" box on the chosen items
  const wrap = $("qWrap"), why = $("whyBox");
  if (COMMENT.has(key(p))) {
    wrap.hidden = false;
    why.value = (state.qualitative && state.qualitative[key(p)]) || "";
  } else {
    wrap.hidden = true;
  }

  $("progFill").style.width = ((state.idx + 1) / PAIRS.length) * 100 + "%";
  $("progText").textContent = `${state.idx + 1} / ${PAIRS.length}`;
  $("prevBtn").disabled = state.idx === 0;
  $("nextBtn").textContent = state.idx === PAIRS.length - 1 ? "Review →" : "Next →";

  paintScale();
  refreshNext();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function saveWhy() {
  const p = PAIRS[state.idx];
  if (!p || !COMMENT.has(key(p))) return;
  state.qualitative = state.qualitative || {};
  state.qualitative[key(p)] = $("whyBox").value.trim();
  save();
  refreshNext();
}

/* ---------- review ---------- */
function commentsMissing() {
  state.qualitative = state.qualitative || {};
  return [...COMMENT].filter(k => !state.qualitative[k]).length;
}

function renderReview() {
  const list = $("reviewList");
  list.innerHTML = "";
  PAIRS.forEach((p, i) => {
    const r = state.ratings[key(p)];
    const row = document.createElement("button");
    row.className = "rrow";
    const tag = COMMENT.has(key(p)) ? ' <span class="mono" style="color:var(--accent)">✎</span>' : "";
    row.innerHTML = `<span class="rrow__q">${p.query_id}</span>` +
      `<span class="rrow__t">${(p.item.title || "(untitled)").replace(/</g, "&lt;")}${tag}</span>` +
      (r ? `<span class="rrow__v sw-${r.rating}">${r.rating}</span>`
         : `<span class="rrow__v miss">—</span>`);
    row.addEventListener("click", () => { show("task"); go(i); });
    list.appendChild(row);
  });
  $("commentBox").value = state.comment || "";
  const missing = PAIRS.filter(p => !state.ratings[key(p)]).length;
  const cmiss = commentsMissing();
  let label = "Finish and send";
  if (missing || cmiss) {
    const bits = [];
    if (missing) bits.push(`${missing} unrated`);
    if (cmiss) bits.push(`${cmiss} comment${cmiss > 1 ? "s" : ""} missing`);
    label = `Finish anyway (${bits.join(", ")})`;
  }
  $("finishBtn").textContent = label;
  show("review");
  window.scrollTo({ top: 0 });
}

/* ---------- payload ---------- */
function payload() {
  const rated = PAIRS.filter(p => state.ratings[key(p)]).length;
  state.qualitative = state.qualitative || {};
  return {
    study: "igv-relevance-rating",
    participant_id: state.pid,
    group: state.version,
    version: state.version,
    started_at: state.startedAt,
    finished_at: new Date().toISOString(),
    n_pairs: PAIRS.length,
    n_rated: rated,
    comment: state.comment || "",
    ratings: PAIRS.map(p => {
      const r = state.ratings[key(p)];
      return { group: state.version, query_id: p.query_id, igv_id: p.item.igv_id,
               rating: r ? r.rating : null, position: r ? r.position : null,
               rated_at: r ? r.rated_at : null };
    }),
    qualitative: [...COMMENT].map(k => {
      const [query_id, igv_id] = k.split("::");
      return { query_id, igv_id, text: state.qualitative[k] || "" };
    })
  };
}

/* ---------- sending ---------- */
function setSend(kind, msg, sub) {
  const box = $("sendStatus");
  box.className = "sendbox sendbox--" + kind;
  $("sendMsg").textContent = msg;
  $("sendSub").textContent = sub || "";
  $("retryBtn").hidden = (kind !== "err");
  $("doneLede").hidden = (kind === "ok");
}

async function submitAnswers() {
  setSend("busy", "Sending your answers…", "This usually takes a moment.");

  const jobs = [];

  // Sink 1 — Apps Script web app (stores a row in the Google Sheet, also the counter).
  // Apps Script sends no CORS headers, so fire it "no-cors": the request is delivered and
  // the row is saved, but the response is opaque (unreadable), so a resolved fetch = "sent".
  if (WEBAPP_URL) {
    jobs.push(
      fetch(WEBAPP_URL, {
        method: "POST", mode: "no-cors",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: PAYLOAD
      }).then(() => true).catch(() => false)
    );
  }

  // Sink 2 — Formspree (email). Readable response, so we know if it truly succeeded.
  if (SUBMIT_URL) {
    jobs.push(
      fetch(SUBMIT_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Accept": "application/json" },
        body: JSON.stringify({
          participant: state.pid, group: state.version,
          rated: payload().n_rated + " of " + PAIRS.length,
          comment: state.comment || "(none)",
          _subject: `IGV rating study — group ${state.version} — ${state.pid}`,
          answers: PAYLOAD
        })
      }).then(r => r.ok).catch(() => false)
    );
  }

  if (!jobs.length) { setSend("err", "Please send your answers using one of the options below.", ""); return; }

  // Send to both at once; succeed if EITHER sink accepted it (duplication guards against loss).
  const results = await Promise.all(jobs);
  if (results.some(Boolean)) {
    setSend("ok", "Thank you.", `Reference ${state.pid}, group ${state.version}. See the options below.`);
  } else {
    setSend("err", "The automatic send did not go through.", "No problem — please use Option A or Option B below instead.");
  }
}

/* ---------- finish ---------- */
function finish() {
  state.comment = $("commentBox").value.trim();
  save();
  PAYLOAD = JSON.stringify(payload(), null, 1);
  $("jsonPeek").textContent = PAYLOAD;
  $("donePid").textContent = state.pid;

  $("copyBtn").onclick = async () => {
    try { await navigator.clipboard.writeText(PAYLOAD); }
    catch (e) {
      const t = document.createElement("textarea");
      t.value = PAYLOAD; document.body.appendChild(t); t.select();
      document.execCommand("copy"); t.remove();
    }
    $("copyOk").hidden = false;
  };

  const subject = `IGV rating study — group ${state.version} — ${state.pid}`;
  const body = `Hello Viera,\n\nHere are my ratings for the geovisualisation study.\n\n` +
    `Participant: ${state.pid}\nGroup: ${state.version}\n` +
    `Rated: ${payload().n_rated} of ${PAIRS.length}\n\n` +
    `--- paste the copied answers below this line ---\n\n`;
  $("mailBtn").href = `mailto:${EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;

  $("dlBtn").onclick = ev => {
    ev.preventDefault();
    const blob = new Blob([PAYLOAD], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `igv-ratings_group${state.version}_${state.pid}.json`;
    a.style.display = "none"; document.body.appendChild(a); a.click();
    setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 2000);
    $("dlOk").hidden = false;
    return false;
  };

  $("retryBtn").onclick = submitAnswers;
  show("done"); window.scrollTo({ top: 0 });
  submitAnswers();
}

/* ---------- confirm dialog ---------- */
function askConfirm() {
  const missing = PAIRS.filter(p => !state.ratings[key(p)]).length;
  const cmiss = commentsMissing();
  const parts = [];
  if (missing) parts.push(`${missing} of ${PAIRS.length} still unrated`);
  if (cmiss) parts.push(`${cmiss} of ${COMMENT.size} short comments not yet written`);
  $("cfBody").textContent = parts.length
    ? `Before you send: ${parts.join(", and ")}. You can go back and finish them, or send as they are.`
    : `You have rated all ${PAIRS.length} items and written all ${COMMENT.size} comments.`;
  $("confirm").hidden = false;
}

/* ---------- start-up ---------- */
function begin(version, resume) {
  state = resume || { pid: newPid(), version, startedAt: new Date().toISOString(),
                      ratings: {}, qualitative: {}, comment: "", idx: 0 };
  if (!state.comment) state.comment = "";
  if (!state.qualitative) state.qualitative = {};
  PAIRS = buildPairs(state.version, state.pid);
  COMMENT = buildCommentKeys(state.version, state.pid);
  $("verLabel").textContent = state.version;
  $("pidLabel").textContent = state.pid;
  buildScale();
  show("task");
  go(state.idx);
}

async function init() {
  try {
    DATA = await (await fetch("items.json", { cache: "no-store" })).json();
  } catch (e) {
    document.body.innerHTML =
      '<div class="wrap" style="padding:60px 24px"><h1>Could not load the study data</h1>' +
      '<p>items.json is missing or unreadable. If you are testing locally, run a small web ' +
      'server (for example <code>python -m http.server</code>) rather than opening the file directly.</p></div>';
    return;
  }

  const v = new URLSearchParams(location.search).get("v");
  const valid = v && DATA.versions[v];
  const autoAssign = !!WEBAPP_URL;      // one shareable link; group chosen on Start
  const saved = load();

  const countPairs = ids => (ids || []).reduce((t, qid) => {
    const q = DATA.queries.find(x => x.query_id === qid);
    return t + (q ? q.items.length : 0);
  }, 0);
  if (valid) $("pairCount").textContent = countPairs(DATA.versions[v]);
  else if (autoAssign) $("pairCount").textContent = countPairs(Object.values(DATA.versions)[0]);

  $("versionNotice").hidden = !!valid || autoAssign;
  $("pidPreview").textContent = saved ? saved.pid : newPid();

  if (saved && Object.keys(saved.ratings || {}).length && (!valid || String(saved.version) === v)) {
    const done = Object.keys(saved.ratings).length;
    $("resumeNote").hidden = false;
    $("resumeNote").innerHTML =
      `You have an unfinished session (${done} rated). ` +
      `<a href="#" id="resumeLink">Continue where you left off</a> · ` +
      `<a href="#" id="freshLink">start over</a>`;
    $("resumeLink").onclick = e => { e.preventDefault(); begin(saved.version, saved); };
    $("freshLink").onclick = e => {
      e.preventDefault();
      if (confirm("Delete your saved answers and start again?")) { localStorage.removeItem(STORE); location.reload(); }
    };
  }

  $("consentBox").addEventListener("change", e => { $("startBtn").disabled = !(e.target.checked && (valid || autoAssign)); });
  $("startBtn").addEventListener("click", async () => {
    if (valid) return begin(Number(v), null);
    $("startBtn").disabled = true; $("startBtn").textContent = "Assigning…";
    const group = await assignGroup();
    begin(group, null);
  });

  $("prevBtn").addEventListener("click", () => { saveWhy(); go(state.idx - 1); });
  $("nextBtn").addEventListener("click", () => {
    saveWhy();
    if (!currentComplete()) { refreshNext(); return; }   // must rate (and comment where asked) first
    state.idx === PAIRS.length - 1 ? renderReview() : go(state.idx + 1);
  });
  $("whyBox").addEventListener("input", saveWhy);
  $("reviewBtn").addEventListener("click", () => { saveWhy(); renderReview(); });
  $("backToTask").addEventListener("click", () => {
    state.comment = $("commentBox").value.trim(); save(); show("task"); go(state.idx);
  });

  $("finishBtn").addEventListener("click", askConfirm);
  $("cfCancel").addEventListener("click", () => { $("confirm").hidden = true; });
  $("cfOk").addEventListener("click", () => { $("confirm").hidden = true; finish(); });

  document.addEventListener("keydown", e => {
    if (!$("confirm").hidden && e.key === "Escape") { $("confirm").hidden = true; return; }
    if ($("task").hidden || e.metaKey || e.ctrlKey || e.altKey) return;
    if (document.activeElement && document.activeElement.id === "whyBox") return; // typing a comment
    if (e.key >= "0" && e.key <= "5") { setRating(Number(e.key)); e.preventDefault(); }
    else if (e.key === "ArrowRight") { saveWhy(); if (currentComplete()) { state.idx === PAIRS.length - 1 ? renderReview() : go(state.idx + 1); } }
    else if (e.key === "ArrowLeft") { saveWhy(); go(state.idx - 1); }
  });
}

init();
