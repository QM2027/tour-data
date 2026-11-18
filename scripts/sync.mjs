#!/usr/bin/env node
// Build the tour data into site/, which the publish workflow deploys to
// https://qm2027.github.io/tour-data/.
//
//   DATA_GO_KR_KEY=… node scripts/sync.mjs [--out dir]
//
// Output (schema 1):
//   index.json       { schema, generatedAt, files, counts, attribution, errors }
//   places.json      { placeId: { contentId, nameEn, address, lat, lng, useTime, restDate, … } }
//   photos.json      { placeId: [ { src, srcSmall, width, height, title, photographer, … } ] }
//   festivals.json   [ { contentId, title, startDate, endDate, edition, datesConfirmed, … } ]
//   img/*.webp       photos mirrored from PhotoKorea / TourAPI, 1200 and 480 px wide
//
// Places come from places.config.json (ids match the site's src/data/places.ts). The previous
// snapshot is the published one (PREVIOUS_URL): anything that fails this run (a place, a photo,
// a whole source) is carried over from it, so one bad call never blanks the site. Never fails
// the run except on a bug; problems are listed in index.json `errors`.

import { execFile } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  ATTRIBUTION, COMMON, ENG, JEJU_LDONG, PHOTO, SCHEMA, SIZES,
  buildFestival, buildPlace, festivalEdition, fitWidth, imageSize, imgPath, makeRedact, normalizeKey,
  parseApi, photographerName, pickPhotos,
} from "./lib.mjs";

const run = promisify(execFile);
const outIdx = process.argv.indexOf("--out");
const OUT = outIdx > 0 ? process.argv[outIdx + 1] : "site";
const PREVIOUS_URL = process.env.PREVIOUS_URL?.replace(/\/$/, "");
const KEY = normalizeKey(process.env.DATA_GO_KR_KEY);
const redact = makeRedact(KEY);
const CONFIG = JSON.parse(await readFile(new URL("../places.config.json", import.meta.url), "utf8"));
const NOW = new Date().toISOString();

const errors = [];
const fail = (source, id, e) => {
  const message = redact(e?.message ?? e);
  errors.push({ source, ...(id ? { id } : {}), message });
  console.warn(`::warning::${source}${id ? ` ${id}` : ""}: ${message}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ http

let calls = 0;
/** Items from one data.go.kr operation; retries gateway hiccups, never logs the key. */
async function api(base, op, params) {
  const qs = new URLSearchParams(Object.entries({ ...COMMON, ...params }).map(([k, v]) => [k, String(v)]));
  const url = `${base}/${op}?serviceKey=${encodeURIComponent(KEY)}&${qs}`;
  let last;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await sleep(1500 * attempt);
    calls++;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
      const r = parseApi(await res.text());
      if (r.ok) return r;
      last = new Error(`${op}: ${res.status} ${r.code} ${r.msg ?? ""}`.trim());
      // 22: daily quota used up; 30/31/32: key not registered / expired / wrong domain. No point retrying.
      if (["22", "30", "31", "32", "12", "20"].includes(String(r.code))) break;
    } catch (e) {
      last = new Error(`${op}: ${e?.cause?.code ?? e?.message ?? e}`);
    }
  }
  throw new Error(redact(last.message));
}

async function fetchBuffer(url, timeout = 30_000) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeout) });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/** Runs fn over items, `limit` at a time, in order. */
async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  }));
  return out;
}

// ------------------------------------------------------------------ previous snapshot

async function loadPrevious() {
  const read = async (name) => {
    if (PREVIOUS_URL) return JSON.parse((await fetchBuffer(`${PREVIOUS_URL}/${name}?t=${Date.now()}`)).toString("utf8"));
    return JSON.parse(await readFile(join(OUT, name), "utf8"));
  };
  const prev = { places: {}, photos: {}, festivals: [] };
  try {
    const index = await read("index.json");
    if (index.schema !== SCHEMA) return prev;
    for (const k of ["places", "photos", "festivals"]) {
      try {
        prev[k] = await read(index.files[k]);
      } catch (e) {
        console.log(`sync: previous ${k} unavailable (${e.message})`);
      }
    }
  } catch (e) {
    console.log(`sync: no previous snapshot (${e.message}); starting fresh`);
  }
  return prev;
}

// ------------------------------------------------------------------ images

let cwebp = null;
try {
  await run("cwebp", ["-version"]);
  cwebp = "cwebp";
} catch {
  console.warn("::warning::cwebp not found: photos are carried over from the previous snapshot");
}

const tmp = join(tmpdir(), `tour-data-${process.pid}`);
await mkdir(tmp, { recursive: true });

/** Downloads an image and writes the two webp sizes under img/. */
async function mirror(url, stem) {
  if (!cwebp) throw new Error("cwebp unavailable");
  const buf = await fetchBuffer(url);
  const size = imageSize(buf);
  if (!size) throw new Error(`${url}: not a JPEG/PNG/WebP`);
  const src = join(tmp, stem);
  await writeFile(src, buf);
  let large;
  for (const w of [SIZES.large, SIZES.small]) {
    const fit = fitWidth(size, w);
    const args = ["-quiet", "-q", "72", "-metadata", "none"];
    if (fit.width < size.width) args.push("-resize", String(fit.width), String(fit.height));
    await run(cwebp, [...args, src, "-o", join(OUT, imgPath(stem, w))]);
    large ??= fit;
  }
  return { src: imgPath(stem, SIZES.large), srcSmall: imgPath(stem, SIZES.small), width: large.width, height: large.height };
}

/** Copies a previously mirrored image (both sizes) from the published site. */
async function carry(entry) {
  if (!PREVIOUS_URL) throw new Error("no previous site");
  for (const p of [entry.src, entry.srcSmall]) await writeFile(join(OUT, p), await fetchBuffer(`${PREVIOUS_URL}/${p}`));
  return entry;
}

// ------------------------------------------------------------------ sources

async function syncPlaces(prev) {
  const ids = Object.keys(CONFIG).filter((id) => CONFIG[id].contentId && !CONFIG[id].skipInfo);
  const places = {};
  await pool(ids, 3, async (id) => {
    try {
      const [common] = (await api(ENG, "detailCommon2", { contentId: CONFIG[id].contentId })).items;
      if (!common) throw new Error(`detailCommon2: no item for ${CONFIG[id].contentId}`);
      let intro;
      try {
        [intro] = (await api(ENG, "detailIntro2", { contentId: common.contentid, contentTypeId: common.contenttypeid })).items;
      } catch (e) {
        fail("places", id, e);
        intro = undefined;
      }
      const place = buildPlace(common, intro, NOW);
      // Keep last week's hours if only the intro call failed.
      if (!intro && prev.places[id]) Object.assign(place, { useTime: prev.places[id].useTime, restDate: prev.places[id].restDate });
      places[id] = place;
    } catch (e) {
      fail("places", id, e);
      if (prev.places[id]) places[id] = prev.places[id];
    }
  });
  return Object.fromEntries(ids.filter((id) => places[id]).map((id) => [id, places[id]]));
}

async function syncFestivals(prev) {
  try {
    const items = [];
    for (let page = 1; page <= 5; page++) {
      const r = await api(ENG, "searchFestival2", { eventStartDate: "20260101", lDongRegnCd: JEJU_LDONG, numOfRows: 100, pageNo: page, arrange: "A" });
      items.push(...r.items);
      if (items.length >= r.total || !r.items.length) break;
    }
    const picked = items.map((it) => [it, festivalEdition(it)]).filter(([, y]) => y);
    const prevById = Object.fromEntries(prev.festivals.map((f) => [f.contentId, f]));
    const out = await pool(picked, 3, async ([it, edition]) => {
      let common;
      try {
        [common] = (await api(ENG, "detailCommon2", { contentId: it.contentid })).items;
      } catch (e) {
        fail("festivals", String(it.contentid), e);
      }
      const f = buildFestival(it, edition, common ?? prevById[it.contentid]);
      // Only KOGL Type 1 images may be resized; Type 3 forbids changes, so those are left out.
      if (it.firstimage && String(it.cpyrhtDivCd ?? "").replace(/\s/g, "") === "Type1") {
        const old = prevById[f.contentId]?.image;
        try {
          f.image = old?.sourceUrl === it.firstimage ? await carry(old).catch(() => null) : null;
          f.image ??= { ...(await mirror(it.firstimage, `f${f.contentId}`)), sourceUrl: it.firstimage, license: "KOGL Type 1" };
        } catch (e) {
          fail("festivals", f.contentId, e);
        }
      }
      return f;
    });
    return out.sort((a, b) => (a.startDate ?? "").localeCompare(b.startDate ?? ""));
  } catch (e) {
    fail("festivals", null, e);
    return prev.festivals;
  }
}

async function syncPhotos(prev) {
  const ids = Object.keys(CONFIG).filter((id) => CONFIG[id].photoKeyword && !CONFIG[id].skipPhotos);
  const photos = {};
  await pool(ids, 3, async (id) => {
    try {
      const { items } = await api(PHOTO, "gallerySearchList1", { keyword: CONFIG[id].photoKeyword, numOfRows: 40, pageNo: 1, arrange: "A" });
      const picks = pickPhotos(items, CONFIG[id].photoKeyword, 3);
      const list = [];
      for (const it of picks) {
        const meta = {
          title: it.galTitle ?? null,
          photographer: photographerName(it.galPhotographer),
          month: it.galPhotographyMonth ? `${String(it.galPhotographyMonth).slice(0, 4)}-${String(it.galPhotographyMonth).slice(4, 6)}` : null,
          galContentId: String(it.galContentId),
          modified: String(it.galModifiedtime ?? ""),
          license: "KOGL Type 1",
        };
        const old = prev.photos[id]?.find((p) => p.galContentId === meta.galContentId && p.modified === meta.modified);
        try {
          const files = old ? await carry(old).catch(() => mirror(it.galWebImageUrl, `p${meta.galContentId}`)) : await mirror(it.galWebImageUrl, `p${meta.galContentId}`);
          list.push({ src: files.src, srcSmall: files.srcSmall, width: files.width, height: files.height, ...meta });
        } catch (e) {
          fail("photos", id, e);
        }
      }
      if (list.length) photos[id] = list;
      else if (prev.photos[id]) photos[id] = await Promise.all(prev.photos[id].map(carry)).catch(() => undefined);
    } catch (e) {
      fail("photos", id, e);
      if (prev.photos[id]) photos[id] = await Promise.all(prev.photos[id].map(carry)).catch(() => undefined);
    }
  });
  return Object.fromEntries(ids.filter((id) => photos[id]).map((id) => [id, photos[id]]));
}

// ------------------------------------------------------------------ main

await rm(OUT, { recursive: true, force: true });
await mkdir(join(OUT, "img"), { recursive: true });
const prev = await loadPrevious();

let places, festivals, photos;
if (!KEY) {
  fail("config", null, "DATA_GO_KR_KEY is not set; publishing the previous snapshot");
  places = prev.places;
  festivals = prev.festivals;
  photos = {};
  for (const [id, list] of Object.entries(prev.photos)) photos[id] = await Promise.all(list.map(carry)).catch(() => undefined);
  for (const f of festivals) if (f.image) await carry(f.image).catch(() => delete f.image);
} else {
  [places, festivals, photos] = await Promise.all([syncPlaces(prev), syncFestivals(prev), syncPhotos(prev)]);
}

const files = { places: "places.json", photos: "photos.json", festivals: "festivals.json" };
await writeFile(join(OUT, files.places), JSON.stringify(places));
await writeFile(join(OUT, files.photos), JSON.stringify(photos));
await writeFile(join(OUT, files.festivals), JSON.stringify(festivals));
const index = {
  schema: SCHEMA,
  generatedAt: NOW,
  files,
  counts: {
    places: Object.keys(places).length,
    photos: Object.values(photos).reduce((n, l) => n + (l?.length ?? 0), 0),
    festivals: festivals.length,
    apiCalls: calls,
  },
  attribution: ATTRIBUTION,
  errors,
};
await writeFile(join(OUT, "index.json"), JSON.stringify(index, null, 2));
await rm(tmp, { recursive: true, force: true });
console.log(`sync: ${index.counts.places} places, ${index.counts.photos} photos, ${index.counts.festivals} festivals, ${calls} API calls, ${errors.length} errors`);
