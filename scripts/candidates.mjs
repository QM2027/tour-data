#!/usr/bin/env node
// Builds a photo picker: every PhotoKorea candidate for each place, on one page, so a person can
// choose which photos the site shows. Nothing is changed here: the page copies the choice as JSON,
// which goes into places.config.json as `photoIds` (or `skipPhotos`).
//
//   DATA_GO_KR_KEY=… node scripts/candidates.mjs [--out site]
//
// The publish workflow runs this on push and manual runs: https://qm2027.github.io/tour-data/candidates.html
// Thumbnails are loaded from the Korea Tourism Organization's own server; this page is a review
// tool for the committee, not part of the visitor site.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { COMMON, PHOTO, keywords, makeRedact, normalizeKey, parseApi, photoMonth, photoCandidates } from "./lib.mjs";

const KEY = normalizeKey(process.env.DATA_GO_KR_KEY);
const redact = makeRedact(KEY);
const outIdx = process.argv.indexOf("--out");
const OUT = outIdx > 0 ? process.argv[outIdx + 1] : "site";
const CONFIG = JSON.parse(await readFile(new URL("../places.config.json", import.meta.url), "utf8"));

async function api(op, params) {
  const qs = new URLSearchParams(Object.entries({ ...COMMON, ...params }).map(([k, v]) => [k, String(v)]));
  const res = await fetch(`${PHOTO}/${op}?serviceKey=${encodeURIComponent(KEY)}&${qs}`, { signal: AbortSignal.timeout(20_000) });
  const r = parseApi(await res.text());
  if (!r.ok) throw new Error(redact(`${op}: ${res.status} ${r.code} ${r.msg ?? ""}`));
  return r.items;
}

let current = {};
try {
  current = JSON.parse(await readFile(join(OUT, "photos.json"), "utf8"));
} catch {}

const places = [];
for (const [id, c] of Object.entries(CONFIG)) {
  const kws = keywords(c.photoKeyword);
  if (!kws.length) continue;
  const entry = { id, name: c.name, nameKo: c.nameKo, keywords: kws, skip: !!c.skipPhotos, pinned: c.photoIds ?? null, shown: (current[id] ?? []).map((p) => p.galContentId), photos: [] };
  try {
    const items = [];
    for (const kw of kws) items.push(...(await api("gallerySearchList1", { keyword: kw, numOfRows: 100, pageNo: 1, arrange: "A" })));
    entry.photos = photoCandidates(items, kws, 36).map((it) => ({
      id: String(it.galContentId),
      url: it.galWebImageUrl,
      title: it.galTitle ?? "",
      by: it.galPhotographer ?? "",
      month: photoMonth(it.galPhotographyMonth),
      where: it.galPhotographyLocation ?? "",
    }));
  } catch (e) {
    entry.error = e.message;
  }
  places.push(entry);
}

const data = JSON.stringify({ generatedAt: new Date().toISOString(), places }).replace(/</g, "\\u003c");

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Photo picker</title>
<style>
  :root { --bg: #fff; --fg: #111; --muted: #666; --line: #e2e2e2; --surface: #f5f5f5; --accent: #d9480f; color-scheme: light dark; }
  @media (prefers-color-scheme: dark) { :root { --bg: #0e0e0e; --fg: #ececec; --muted: #9a9a9a; --line: #2b2b2b; --surface: #191919; --accent: #ff7a3d; } }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--fg); font: 15px/1.45 system-ui, sans-serif; }
  header { position: sticky; top: 0; z-index: 2; background: var(--bg); border-bottom: 1px solid var(--line); padding: 12px 16px; display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
  header h1 { font-size: 16px; margin: 0; }
  header p { margin: 0; color: var(--muted); font-size: 13px; flex: 1 1 300px; }
  button { font: inherit; border: 1px solid var(--fg); background: var(--bg); color: var(--fg); border-radius: 6px; padding: 6px 12px; cursor: pointer; }
  button.primary { background: var(--fg); color: var(--bg); }
  main { padding: 0 16px 80px; max-width: 1400px; margin: 0 auto; }
  section { border-bottom: 1px solid var(--line); padding: 20px 0; }
  section h2 { font-size: 17px; margin: 0; }
  .meta { color: var(--muted); font-size: 13px; margin: 2px 0 10px; display: flex; gap: 12px; flex-wrap: wrap; align-items: center; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 8px; }
  .ph { position: relative; padding: 0; border: 2px solid transparent; border-radius: 6px; overflow: hidden; background: var(--surface); text-align: left; }
  .ph img { display: block; width: 100%; aspect-ratio: 3 / 2; object-fit: cover; }
  .ph .cap { display: block; padding: 4px 6px; font-size: 11px; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .ph[aria-pressed="true"] { border-color: var(--accent); }
  .ph .n { position: absolute; top: 6px; left: 6px; min-width: 24px; height: 24px; border-radius: 12px; background: var(--accent); color: #fff; font-weight: 700; display: none; align-items: center; justify-content: center; font-size: 13px; }
  .ph[aria-pressed="true"] .n { display: flex; }
  .ph .was { position: absolute; top: 6px; right: 6px; font-size: 11px; background: rgba(0,0,0,.6); color: #fff; padding: 1px 6px; border-radius: 4px; }
  label { display: inline-flex; gap: 6px; align-items: center; }
  input[type=text] { font: inherit; padding: 4px 8px; border: 1px solid var(--line); border-radius: 6px; background: var(--bg); color: var(--fg); min-width: 220px; }
  .none section[data-none="true"] .grid { opacity: .35; }
  #out { position: fixed; inset: auto 16px 16px; max-height: 40vh; overflow: auto; background: var(--surface); border: 1px solid var(--line); border-radius: 8px; padding: 12px; display: none; white-space: pre-wrap; font: 12px/1.4 ui-monospace, monospace; }
</style>
</head>
<body class="none">
<header>
  <h1>Photo picker</h1>
  <p>Tap photos in the order you want them (up to 3 per place; the first is the one on the card). "Shown now" marks the current pick. Then copy the result and send it to whoever maintains tour-data.</p>
  <button class="primary" id="copy">Copy choices</button>
  <button id="reset">Clear all</button>
</header>
<main id="main"></main>
<pre id="out"></pre>
<script>
const DATA = ${data};
const KEY = "photo-picker-v1";
let state = {};
try { state = JSON.parse(localStorage.getItem(KEY) || "{}"); } catch {}
const save = () => { try { localStorage.setItem(KEY, JSON.stringify(state)); } catch {} };
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const main = document.getElementById("main");

for (const p of DATA.places) {
  if (!state[p.id]) state[p.id] = { pick: p.pinned ?? [], none: p.skip, keyword: "" };
  const s = document.createElement("section");
  s.innerHTML = \`<h2>\${esc(p.name)} <span lang="ko">\${esc(p.nameKo || "")}</span></h2>
    <div class="meta"><span>\${p.photos.length} candidates · searched: \${p.keywords.map(esc).join(", ")}</span>
    <label><input type="checkbox" data-none> None of these fit</label>
    <label>Try another keyword <input type="text" data-kw placeholder="e.g. 용머리해안"></label>
    \${p.error ? '<span style="color:var(--accent)">' + esc(p.error) + "</span>" : ""}</div>
    <div class="grid"></div>\`;
  const grid = s.querySelector(".grid");
  for (const ph of p.photos) {
    const b = document.createElement("button");
    b.className = "ph";
    b.dataset.id = ph.id;
    b.title = [ph.title, ph.by, ph.month, ph.where].filter(Boolean).join(" · ");
    b.innerHTML = \`<img loading="lazy" src="\${esc(ph.url)}" alt="\${esc(ph.title)}"><span class="n"></span>\${p.shown.includes(ph.id) ? '<span class="was">Shown now</span>' : ""}<span class="cap">\${esc(ph.title)} · \${esc(ph.month || "")}</span>\`;
    b.onclick = () => {
      const pick = state[p.id].pick;
      const i = pick.indexOf(ph.id);
      if (i >= 0) pick.splice(i, 1);
      else if (pick.length < 3) pick.push(ph.id);
      else return;
      render(); save();
    };
    grid.append(b);
  }
  const none = s.querySelector("[data-none]");
  none.checked = state[p.id].none;
  none.onchange = () => { state[p.id].none = none.checked; render(); save(); };
  const kw = s.querySelector("[data-kw]");
  kw.value = state[p.id].keyword || "";
  kw.oninput = () => { state[p.id].keyword = kw.value.trim(); save(); };
  s.dataset.place = p.id;
  main.append(s);
}

function render() {
  for (const s of main.children) {
    const st = state[s.dataset.place];
    s.dataset.none = st.none;
    for (const b of s.querySelectorAll(".ph")) {
      const i = st.pick.indexOf(b.dataset.id);
      b.setAttribute("aria-pressed", i >= 0);
      b.querySelector(".n").textContent = i >= 0 ? i + 1 : "";
    }
  }
}
render();

document.getElementById("copy").onclick = async () => {
  const out = {};
  for (const p of DATA.places) {
    const st = state[p.id];
    const e = {};
    if (st.none) e.none = true;
    else if (st.pick.length) e.photoIds = st.pick;
    if (st.keyword) e.keyword = st.keyword;
    if (Object.keys(e).length) out[p.id] = e;
  }
  const text = JSON.stringify(out, null, 1);
  const pre = document.getElementById("out");
  pre.textContent = text;
  pre.style.display = "block";
  try { await navigator.clipboard.writeText(text); pre.textContent = "Copied.\\n\\n" + text; } catch {}
};
document.getElementById("reset").onclick = () => {
  if (!confirm("Clear every choice on this page?")) return;
  for (const p of DATA.places) state[p.id] = { pick: [], none: false, keyword: "" };
  for (const kw of document.querySelectorAll("[data-kw]")) kw.value = "";
  for (const c of document.querySelectorAll("[data-none]")) c.checked = false;
  render(); save();
};
</script>
</body>
</html>
`;

await mkdir(OUT, { recursive: true });
await writeFile(join(OUT, "candidates.html"), html);
console.log(`candidates: ${places.length} places, ${places.reduce((n, p) => n + p.photos.length, 0)} photos${KEY ? "" : " (no key: empty)"}`);
