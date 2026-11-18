// Pure helpers for sync.mjs and match.mjs. Network and file access stay in the scripts.

export const SCHEMA = 1;
export const ENG = "https://apis.data.go.kr/B551011/EngService2";
export const PHOTO = "https://apis.data.go.kr/B551011/PhotoGalleryService1";
/** Legal-dong province code for Jeju (replaces the old areaCode 39). */
export const JEJU_LDONG = "50";
export const COMMON = { MobileOS: "ETC", MobileApp: "QM2027", _type: "json" };

export const ATTRIBUTION = {
  text: "Place information and photos: Korea Tourism Organization (TourAPI, PhotoKorea), via data.go.kr.",
  photos: "Photos: Korea Tourism Organization, PhotoKorea (photographer as credited), KOGL Type 1. Resized.",
  licence: "KOGL Type 1 (공공누리 제1유형: 출처표시) — https://www.kogl.or.kr/info/licenseType1.do",
};

// ------------------------------------------------------------------ key handling

/** The portal shows an "Encoding" and a "Decoding" key; accept either and return the decoded one. */
export function normalizeKey(raw) {
  const k = (raw ?? "").trim();
  return /%[0-9A-F]{2}/i.test(k) ? decodeURIComponent(k) : k;
}

/** Replaces every form of the key in a string. Some error bodies echo the key back. */
export function makeRedact(key) {
  if (!key) return (s) => String(s);
  const forms = [...new Set([key, encodeURIComponent(key), new URLSearchParams({ k: key }).toString().slice(2)])];
  return (s) => forms.reduce((t, f) => t.split(f).join("***"), String(s));
}

// ------------------------------------------------------------------ API responses

const asArray = (x) => (x == null || x === "" ? [] : Array.isArray(x) ? x : [x]);

/**
 * data.go.kr answers in several shapes: the service's JSON, a top-level { resultCode } on gateway
 * errors, or the portal's OpenAPI_ServiceResponse (JSON or XML). Returns { ok, code, msg, items, total }.
 */
export function parseApi(text) {
  let j;
  try {
    j = JSON.parse(text);
  } catch {
    const tag = (t) => text.match(new RegExp(`<${t}>([^<]*)</${t}>`))?.[1];
    return { ok: false, code: tag("resultCode") ?? tag("returnReasonCode") ?? "XML", msg: tag("resultMsg") ?? tag("returnAuthMsg") ?? tag("errMsg") ?? text.slice(0, 200), items: [] };
  }
  const gw = j?.OpenAPI_ServiceResponse?.cmmMsgHeader;
  if (gw) return { ok: false, code: gw.returnReasonCode ?? "GW", msg: gw.returnAuthMsg ?? gw.errMsg, items: [] };
  const header = j?.response?.header ?? (j?.resultCode ? j : undefined);
  const code = header?.resultCode;
  const body = j?.response?.body;
  const ok = code === "0000" || code === "00";
  return { ok, code, msg: header?.resultMsg, items: ok ? asArray(body?.items?.item) : [], total: Number(body?.totalCount ?? 0) };
}

// ------------------------------------------------------------------ text

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'" };

/** TourAPI text fields are HTML fragments: <br>, links, entities. Returns plain text with line breaks. */
export function cleanText(s) {
  if (s == null) return null;
  const t = String(s)
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>\s*/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&(#x?[0-9a-f]+|\w+);/gi, (m, e) => {
      if (e[0] === "#") return String.fromCodePoint(e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
      return ENTITIES[e.toLowerCase()] ?? m;
    })
    .split("\n")
    .map((l) => l.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return t || null;
}

/** homepage is usually `<a href="…">…</a>`; sometimes a bare URL or "www.…". */
export function extractUrl(s) {
  if (!s) return null;
  const href = String(s).match(/href\s*=\s*["']([^"']+)["']/i)?.[1];
  let u = (href ?? cleanText(s) ?? "").trim().split(/\s/)[0];
  if (!u) return null;
  if (/^www\./i.test(u)) u = `https://${u}`;
  return /^https?:\/\//i.test(u) ? u : null;
}

// ------------------------------------------------------------------ opening hours

// detailIntro2 names the hours fields after the content type.
const HOURS_FIELDS = {
  76: ["usetime", "restdate"], // tourist attraction
  78: ["usetimeculture", "restdateculture"], // cultural facility
  75: ["usetimeleports", "restdateleports"], // leisure
  79: ["opentime", "restdateshopping"], // shopping
  82: ["opentimefood", "restdatefood"], // food
  85: ["playtime", null], // festival
};

/** { useTime, restDate } from a detailIntro2 item, whatever its content type. */
export function hoursFromIntro(contentTypeId, intro) {
  if (!intro) return { useTime: null, restDate: null };
  let [use, rest] = HOURS_FIELDS[Number(contentTypeId)] ?? [];
  use ??= Object.keys(intro).find((k) => /^(usetime|opentime)/.test(k));
  if (rest === undefined) rest = Object.keys(intro).find((k) => /^restdate/.test(k));
  return { useTime: cleanText(intro[use]), restDate: rest ? cleanText(intro[rest]) : null };
}

// ------------------------------------------------------------------ places

/** One places.json entry from detailCommon2 + detailIntro2 items. */
export function buildPlace(common, intro, fetchedAt) {
  const num = (v) => (v == null || v === "" || Number(v) === 0 ? null : Number(v));
  return {
    contentId: String(common.contentid),
    contentTypeId: String(common.contenttypeid),
    nameEn: cleanText(common.title),
    address: cleanText([common.addr1, common.addr2].filter(Boolean).join(" ")),
    lat: num(common.mapy),
    lng: num(common.mapx),
    ...hoursFromIntro(common.contenttypeid, intro),
    tel: cleanText(common.tel),
    homepage: extractUrl(common.homepage),
    overview: cleanText(common.overview),
    fetchedAt,
  };
}

/** Great-circle distance in metres. */
export function distanceM(a, b) {
  const R = 6371e3, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(h)));
}

// ------------------------------------------------------------------ festivals

/** Window around the conference (21–27 March), as MMDD. */
export const FESTIVAL_WINDOW = { from: "0301", to: "0415" };
export const CONFERENCE_YEAR = 2027;

/**
 * Whether a festival's listed run overlaps the window in its own year, and which year that is.
 * TourAPI keeps one item per festival and updates its dates each year, so an item still showing
 * 2026 dates means the 2027 edition isn't announced yet.
 */
export function festivalEdition(item, window = FESTIVAL_WINDOW) {
  const s = String(item.eventstartdate ?? ""), e = String(item.eventenddate ?? s);
  if (!/^\d{8}$/.test(s) || !/^\d{8}$/.test(e)) return null;
  for (let y = Number(s.slice(0, 4)); y <= Number(e.slice(0, 4)); y++) {
    if (s <= `${y}${window.to}` && e >= `${y}${window.from}`) return y;
  }
  return null;
}

const isoDate = (d) => (d && /^\d{8}$/.test(d) ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` : null);

export function buildFestival(item, edition, common) {
  const num = (v) => (v == null || v === "" || Number(v) === 0 ? null : Number(v));
  return {
    contentId: String(item.contentid),
    title: cleanText(item.title),
    startDate: isoDate(String(item.eventstartdate)),
    endDate: isoDate(String(item.eventenddate)),
    edition,
    datesConfirmed: edition >= CONFERENCE_YEAR,
    address: cleanText([item.addr1, item.addr2].filter(Boolean).join(" ")),
    lat: num(item.mapy),
    lng: num(item.mapx),
    overview: cleanText(common?.overview),
    homepage: extractUrl(common?.homepage),
  };
}

// ------------------------------------------------------------------ photos

const squash = (s) => String(s ?? "").replace(/[\s·.,()]/g, "");

/** photoKeyword may be one keyword or a list to try in order. */
export const keywords = (k) => (Array.isArray(k) ? k : k ? [k] : []);

/**
 * Up to n PhotoKorea items for a place: on Jeju and titled with the keyword (newest first), then
 * ones only tagged with it; one per image.
 */
export function pickPhotos(items, keyword, n = 3) {
  const k = squash(keyword);
  const onJeju = (it) => /제주|서귀포/.test(`${it.galPhotographyLocation ?? ""} ${it.galSearchKeyword ?? ""} ${it.galTitle ?? ""}`);
  const rank = (it) => (squash(it.galTitle).includes(k) ? 0 : squash(it.galSearchKeyword).includes(k) ? 1 : 2);
  const seen = new Set();
  return items
    .filter((it) => it.galWebImageUrl && onJeju(it) && rank(it) < 2)
    .sort((a, b) => rank(a) - rank(b) || String(b.galPhotographyMonth ?? "").localeCompare(String(a.galPhotographyMonth ?? "")))
    .filter((it) => !seen.has(it.galWebImageUrl) && seen.add(it.galWebImageUrl))
    .slice(0, n);
}

/** "201004" → "2010-04"; "202200" (month unknown) → "2022". */
export function photoMonth(s) {
  const m = String(s ?? "").match(/^(\d{4})(\d{2})/);
  if (!m) return null;
  return m[2] === "00" ? m[1] : `${m[1]}-${m[2]}`;
}

/** Photographer credit without the agency prefix ("한국관광공사 김지호" → "김지호"). */
export function photographerName(s) {
  const t = cleanText(s) ?? "";
  return t.replace(/^한국관광공사\s*/, "") || null;
}

export const SIZES = { large: 1200, small: 480 };
export const imgPath = (stem, w) => `img/${stem}-${w}.webp`;

/** Width and height of a JPEG, PNG or WebP buffer, or null. */
export function imageSize(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  // PNG: IHDR right after the signature.
  if (b.length > 24 && b.readUInt32BE(0) === 0x89504e47) return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  // JPEG: walk markers to the first SOFn.
  if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) { i++; continue; }
      const m = b[i + 1];
      if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7) || m === 0xff) { i += m === 0xff ? 1 : 2; continue; }
      const len = b.readUInt16BE(i + 2);
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
      i += 2 + len;
    }
    return null;
  }
  // WebP: RIFF....WEBP then VP8 / VP8L / VP8X.
  if (b.length > 30 && b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP") {
    const chunk = b.toString("ascii", 12, 16);
    if (chunk === "VP8 ") return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
    if (chunk === "VP8L") {
      const v = b.readUInt32LE(21);
      return { width: (v & 0x3fff) + 1, height: ((v >> 14) & 0x3fff) + 1 };
    }
    if (chunk === "VP8X") return { width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3) };
  }
  return null;
}

/** Output size when shrinking to at most `max` wide (never enlarging). */
export function fitWidth({ width, height }, max) {
  if (width <= max) return { width, height };
  return { width: max, height: Math.round((height * max) / width) };
}
