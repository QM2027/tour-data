#!/usr/bin/env node
// Suggests TourAPI contentIds and checks photo keywords for places.config.json.
//
//   DATA_GO_KR_KEY=… node scripts/match.mjs [--all] [--out site/match.json]
//
// `searchKeyword` overrides the English search term. By default only places without a contentId
// (and not skipInfo) are looked up, to spare the
// daily quota. For each: English keyword search plus a 2 km location search, ranked by distance,
// and the top PhotoKorea hits for its photoKeyword. Nothing is changed: copy confident
// contentIds into places.config.json by hand. The publish workflow runs this on push and writes
// the result to https://qm2027.github.io/tour-data/match.json.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { COMMON, ENG, PHOTO, distanceM, keywords, makeRedact, normalizeKey, parseApi, pickPhotos } from "./lib.mjs";

const KEY = normalizeKey(process.env.DATA_GO_KR_KEY);
const redact = makeRedact(KEY);
const ALL = process.argv.includes("--all");
const outIdx = process.argv.indexOf("--out");
const OUT = outIdx > 0 ? process.argv[outIdx + 1] : null;
const CONFIG = JSON.parse(await readFile(new URL("../places.config.json", import.meta.url), "utf8"));

async function api(base, op, params) {
  const qs = new URLSearchParams(Object.entries({ ...COMMON, ...params }).map(([k, v]) => [k, String(v)]));
  const res = await fetch(`${base}/${op}?serviceKey=${encodeURIComponent(KEY)}&${qs}`, { signal: AbortSignal.timeout(20_000) });
  const r = parseApi(await res.text());
  if (!r.ok) throw new Error(redact(`${op}: ${res.status} ${r.code} ${r.msg ?? ""}`));
  return r.items;
}

/** "Hallasan, Yeongsil Trail" → "Yeongsil"; "Sanbangsan & Yongmeori Coast" → "Sanbangsan". */
const keywordOf = (name) => name.replace(/\(.*?\)/g, "").split(/[,&·]/).map((s) => s.trim()).sort((a, b) => b.length - a.length)[0].split(" ")[0];

const ids = Object.keys(CONFIG).filter((id) => !CONFIG[id].skipInfo && (ALL || !CONFIG[id].contentId));
const out = { checkedAt: new Date().toISOString(), places: {} };
if (!KEY) out.error = "DATA_GO_KR_KEY is not set";
else {
  for (const id of ids) {
    const c = CONFIG[id];
    const at = { lat: c.lat, lng: c.lng };
    const entry = { name: c.name, nameKo: c.nameKo, current: c.contentId ?? null, candidates: [], photos: [] };
    const seen = new Map();
    const add = (it, via) => {
      const id2 = String(it.contentid);
      const d = it.mapy ? distanceM(at, { lat: Number(it.mapy), lng: Number(it.mapx) }) : null;
      const prev = seen.get(id2);
      if (prev) return void (prev.via = `${prev.via}+${via}`);
      seen.set(id2, { contentId: id2, contentTypeId: String(it.contenttypeid), title: it.title, distM: d, via });
    };
    try {
      for (const it of await api(ENG, "searchKeyword2", { keyword: c.searchKeyword ?? keywordOf(c.name), numOfRows: 10, pageNo: 1, arrange: "A" })) add(it, "keyword");
    } catch (e) {
      entry.error = e.message;
    }
    try {
      for (const it of await api(ENG, "locationBasedList2", { mapX: c.lng, mapY: c.lat, radius: 2000, numOfRows: 10, pageNo: 1, arrange: "E" })) add(it, "near");
    } catch (e) {
      entry.error = [entry.error, e.message].filter(Boolean).join("; ");
    }
    entry.candidates = [...seen.values()].sort((a, b) => (a.distM ?? 1e9) - (b.distM ?? 1e9)).slice(0, 8);
    if (!c.skipPhotos) {
      entry.photoHits = {};
      for (const kw of keywords(c.photoKeyword)) {
        try {
          const items = await api(PHOTO, "gallerySearchList1", { keyword: kw, numOfRows: 40, pageNo: 1, arrange: "A" });
          entry.photoHits[kw] = items.length;
          entry.photos.push(...pickPhotos(items, kw, 5).map((p) => ({ keyword: kw, title: p.galTitle, where: p.galPhotographyLocation, month: p.galPhotographyMonth, keywords: p.galSearchKeyword, url: p.galWebImageUrl })));
        } catch (e) {
          entry.error = [entry.error, e.message].filter(Boolean).join("; ");
        }
      }
    }
    out.places[id] = entry;
    console.log(`${id}: ${entry.candidates.slice(0, 3).map((x) => `${x.contentId} ${x.title} (${x.distM} m, ${x.via})`).join(" | ") || "no candidates"} · photos ${entry.photos.length}`);
  }
}

if (OUT) {
  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify(out, null, 2));
}
