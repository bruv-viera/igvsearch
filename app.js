/* Rating study for interactive geovisualisations
   Static site. Answers stay in the browser until the participant sends them. */

/* ---------- configuration ---------- */
const EMAIL = "viera.mlilo@tum.de";
// Formspree endpoint. Leave "" to hide the automatic send and use email only.
const SUBMIT_URL = "https://formspree.io/f/mvzewywp";
const STORE = "igv-study-v1";

const $ = id => document.getElementById(id);
const screens = ["intro", "task", "review", "done"];
const show = name => screens.forEach(s => $(s).hidden = (s !== name));

let DATA = null;   // items.json
let PAIRS = [];    // the pairs this participant rates
let state = null;  // {pid, version, startedAt, ratings, comment, idx}
let PAYLOAD = "";  // JSON string, built once at finish

/* ---------- helpers ---------- */

function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function seededShuffle(arr, seed) {          // stable order across a resumed session
  const a = arr.slice();
  let s = seed || 1;
  const rnd = () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
const newPid = () => "p-" + Math.random().toString(36).slice(2, 5);   // e.g. p-se1
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

function buildScale() {
  const box = $("scale");
  box.innerHTML = "";
  DATA.scale.forEach(s => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "opt";
    b.setAttribute("role", "radio");
    b.setAttribute("aria-checked", "false");
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
  setTimeout(() => { if (state.idx < PAIRS.length - 1) go(state.idx + 1); else renderReview(); }, 190);
}

function paintScale() {
  const r = state.ratings[key(PAIRS[state.idx])];
  document.querySelectorAll(".opt").forEach(o =>
    o.setAttribute("aria-checked", r && String(r.rating) === o.dataset.value ? "true" : "false"));
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

  $("progFill").style.width = ((state.idx + 1) / PAIRS.length) * 100 + "%";
  $("progText").textContent = `${state.idx + 1} / ${PAIRS.length}`;
  $("prevBtn").disabled = state.idx === 0;
  $("nextBtn").textContent = state.idx === PAIRS.length - 1 ? "Review →" : "Next →";

  paintScale();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

/* ---------- review ---------- */

function renderReview() {
  const list = $("reviewList");
  list.innerHTML = "";
  PAIRS.forEach((p, i) => {
    const r = state.ratings[key(p)];
    const row = document.createElement("button");
    row.className = "rrow";
    row.innerHTML = `<span class="rrow__q">${p.query_id}</span>` +
      `<span class="rrow__t">${(p.item.title || "(untitled)").replace(/</g, "&lt;")}</span>` +
      (r ? `<span class="rrow__v sw-${r.rating}">${r.rating}</span>`
         : `<span class="rrow__v miss">—</span>`);
    row.addEventListener("click", () => { show("task"); go(i); });
    list.appendChild(row);
  });
  $("commentBox").value = state.comment || "";
  const missing = PAIRS.filter(p => !state.ratings[key(p)]).length;
  $("finishBtn").textContent = missing ? `Finish anyway (${missing} unrated)` : "Finish and send";
  show("review");
  window.scrollTo({ top: 0 });
}

/* ---------- payload ---------- */

function payload() {
  const rated = PAIRS.filter(p => state.ratings[key(p)]).length;
  return {
    study: "igv-relevance-rating",
    participant_id: state.pid,
    set: state.version,               // which questionnaire set was answered
    version: state.version,
    started_at: state.startedAt,
    finished_at: new Date().toISOString(),
    n_pairs: PAIRS.length,
    n_rated: rated,
    comment: state.comment || "",
    ratings: PAIRS.map(p => {
      const r = state.ratings[key(p)];
      return { set: state.version, query_id: p.query_id, igv_id: p.item.igv_id,
               rating: r ? r.rating : null, position: r ? r.position : null,
               rated_at: r ? r.rated_at : null };
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

async function submitToFormspree() {
  if (!SUBMIT_URL) {
    setSend("err", "Please send your answers using one of the options below.", "");
    return;
  }
  setSend("busy", "Sending your answers…", "This usually takes a moment.");
  try {
    const res = await fetch(SUBMIT_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json" },
      body: JSON.stringify({
        participant: state.pid,
        set: state.version,
        rated: payload().n_rated + " of " + PAIRS.length,
        comment: state.comment || "(none)",
        _subject: `IGV rating study — set ${state.version} — ${state.pid}`,
        answers: PAYLOAD
      })
    });
    if (res.ok) {
      setSend("ok", "Thank you.",
              `Reference ${state.pid}, set ${state.version}. Review the the options below.`);
    } else {
      setSend("err", "The automatic send did not go through.",
              "No problem — please use Option A or Option B below instead.");
    }
  } catch (e) {
    setSend("err", "The automatic send could not reach the server.",
            "This can happen on restricted networks. Please use Option A or Option B below.");
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

  const subject = `IGV rating study — set ${state.version} — ${state.pid}`;
  const body = `Hello Viera,\n\nHere are my ratings for the geovisualisation study.\n\n` +
    `Participant: ${state.pid}\nSet: ${state.version}\n` +
    `Rated: ${payload().n_rated} of ${PAIRS.length}\n\n` +
    `--- paste the copied answers below this line ---\n\n`;
  $("mailBtn").href =
    `mailto:${EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;

  // download: keep the anchor in the DOM and revoke late, or the page can be torn down
  $("dlBtn").onclick = ev => {
    ev.preventDefault();
    const blob = new Blob([PAYLOAD], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `igv-ratings_set${state.version}_${state.pid}.json`;
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 2000);
    $("dlOk").hidden = false;
    return false;
  };

  $("retryBtn").onclick = submitToFormspree;

  show("done");
  window.scrollTo({ top: 0 });
  submitToFormspree();
}

/* ---------- confirm dialog ---------- */

function askConfirm() {
  const missing = PAIRS.filter(p => !state.ratings[key(p)]).length;
  const rated = PAIRS.length - missing;
  $("cfBody").textContent = missing
    ? `You have rated ${rated} of ${PAIRS.length} items — ${missing} still unrated. You can go back and finish them, or send as they are.`
    : `You have rated all ${PAIRS.length} items.`;
  $("confirm").hidden = false;
}

/* ---------- start-up ---------- */

function begin(version, resume) {
  state = resume || { pid: newPid(), version, startedAt: new Date().toISOString(),
                      ratings: {}, comment: "", idx: 0 };
  if (!state.comment) state.comment = "";
  PAIRS = buildPairs(state.version, state.pid);
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
  const saved = load();

  if (valid) {
    $("pairCount").textContent = (DATA.versions[v] || []).reduce((t, qid) => {
      const q = DATA.queries.find(x => x.query_id === qid);
      return t + (q ? q.items.length : 0);
    }, 0);
  }
  $("versionNotice").hidden = !!valid;
  $("pidPreview").textContent = saved ? saved.pid : newPid();

  if (saved && Object.keys(saved.ratings).length && (!valid || String(saved.version) === v)) {
    const done = Object.keys(saved.ratings).length;
    $("resumeNote").hidden = false;
    $("resumeNote").innerHTML =
      `You have an unfinished session (${done} rated). ` +
      `<a href="#" id="resumeLink">Continue where you left off</a> · ` +
      `<a href="#" id="freshLink">start over</a>`;
    $("resumeLink").onclick = e => { e.preventDefault(); begin(saved.version, saved); };
    $("freshLink").onclick = e => {
      e.preventDefault();
      if (confirm("Delete your saved answers and start again?")) {
        localStorage.removeItem(STORE); location.reload();
      }
    };
  }

  $("consentBox").addEventListener("change", e => {
    $("startBtn").disabled = !(e.target.checked && valid);
  });
  $("startBtn").addEventListener("click", () => begin(Number(v), null));

  $("prevBtn").addEventListener("click", () => go(state.idx - 1));
  $("nextBtn").addEventListener("click", () =>
    state.idx === PAIRS.length - 1 ? renderReview() : go(state.idx + 1));
  $("reviewBtn").addEventListener("click", () => { state.comment = state.comment || ""; renderReview(); });
  $("backToTask").addEventListener("click", () => {
    state.comment = $("commentBox").value.trim(); save(); show("task"); go(state.idx);
  });

  $("finishBtn").addEventListener("click", askConfirm);
  $("cfCancel").addEventListener("click", () => { $("confirm").hidden = true; });
  $("cfOk").addEventListener("click", () => { $("confirm").hidden = true; finish(); });

  document.addEventListener("keydown", e => {
    if (!$("confirm").hidden && e.key === "Escape") { $("confirm").hidden = true; return; }
    if ($("task").hidden || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key >= "0" && e.key <= "5") { setRating(Number(e.key)); e.preventDefault(); }
    else if (e.key === "ArrowRight") { state.idx === PAIRS.length - 1 ? renderReview() : go(state.idx + 1); }
    else if (e.key === "ArrowLeft") { go(state.idx - 1); }
  });
}

init();
