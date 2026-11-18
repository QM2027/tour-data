import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildPlace, cleanText, extractUrl, festivalEdition, fitWidth, hoursFromIntro, imageSize, makeRedact,
  normalizeKey, parseApi, photographerName, pickPhotos,
} from "../scripts/lib.mjs";

test("normalizeKey accepts the Encoding and Decoding forms", () => {
  assert.equal(normalizeKey(" abc+/d== "), "abc+/d==");
  assert.equal(normalizeKey("abc%2B%2Fd%3D%3D"), "abc+/d==");
  assert.equal(normalizeKey(undefined), "");
});

test("makeRedact hides raw and encoded key", () => {
  const r = makeRedact("ab+c/d==");
  assert.equal(r("x ab+c/d== y ab%2Bc%2Fd%3D%3D z"), "x *** y *** z");
  assert.equal(makeRedact("")("same"), "same");
});

test("parseApi reads success, gateway errors and XML", () => {
  const ok = parseApi(JSON.stringify({ response: { header: { resultCode: "0000", resultMsg: "OK" }, body: { items: { item: { a: 1 } }, totalCount: 1 } } }));
  assert.deepEqual([ok.ok, ok.items, ok.total], [true, [{ a: 1 }], 1]);
  const empty = parseApi(JSON.stringify({ response: { header: { resultCode: "0000" }, body: { items: "", totalCount: 0 } } }));
  assert.deepEqual([empty.ok, empty.items], [true, []]);
  const top = parseApi(JSON.stringify({ resultCode: "99", resultMsg: "UNKNOWN_ERROR" }));
  assert.deepEqual([top.ok, top.code], [false, "99"]);
  const gw = parseApi(JSON.stringify({ OpenAPI_ServiceResponse: { cmmMsgHeader: { returnReasonCode: "12", returnAuthMsg: "NO_OPENAPI_SERVICE_ERROR" } } }));
  assert.deepEqual([gw.ok, gw.code], [false, "12"]);
  const xml = parseApi("<OpenAPI_ServiceResponse><cmmMsgHeader><returnReasonCode>30</returnReasonCode><returnAuthMsg>SERVICE_KEY_IS_NOT_REGISTERED_ERROR</returnAuthMsg></cmmMsgHeader></OpenAPI_ServiceResponse>");
  assert.deepEqual([xml.ok, xml.code, xml.msg], [false, "30", "SERVICE_KEY_IS_NOT_REGISTERED_ERROR"]);
});

test("cleanText strips tags and entities, keeps line breaks", () => {
  assert.equal(cleanText("09:00~18:00<br>(Last admission 17:00)&nbsp;"), "09:00~18:00\n(Last admission 17:00)");
  assert.equal(cleanText("A &amp; B &#39;C&#39; &#x41;"), "A & B 'C' A");
  assert.equal(cleanText("<br><br><br>x"), "x");
  assert.equal(cleanText(""), null);
  assert.equal(cleanText(null), null);
});

test("extractUrl handles anchors, bare and www URLs", () => {
  assert.equal(extractUrl('<a href="http://www.yeomiji.or.kr" target="_blank" title="x">www.yeomiji.or.kr</a>'), "http://www.yeomiji.or.kr");
  assert.equal(extractUrl("www.example.kr"), "https://www.example.kr");
  assert.equal(extractUrl("https://a.kr/b c"), "https://a.kr/b");
  assert.equal(extractUrl("N/A"), null);
  assert.equal(extractUrl(""), null);
});

test("hoursFromIntro picks the fields for the content type", () => {
  assert.deepEqual(hoursFromIntro("76", { usetime: "09:00-18:00", restdate: "Open all year" }), { useTime: "09:00-18:00", restDate: "Open all year" });
  assert.deepEqual(hoursFromIntro(78, { usetimeculture: "10-17", restdateculture: "Mondays" }), { useTime: "10-17", restDate: "Mondays" });
  assert.deepEqual(hoursFromIntro("82", { opentimefood: "11-21", restdatefood: "" }), { useTime: "11-21", restDate: null });
  assert.deepEqual(hoursFromIntro("85", { playtime: "10:00~" }), { useTime: "10:00~", restDate: null });
  assert.deepEqual(hoursFromIntro("99", { usetimex: "a", restdatex: "b" }), { useTime: "a", restDate: "b" });
  assert.deepEqual(hoursFromIntro("76", undefined), { useTime: null, restDate: null });
});

test("buildPlace maps detailCommon2", () => {
  const p = buildPlace({ contentid: 1, contenttypeid: "76", title: "Yeomiji", addr1: "93 Jungmungwangwang-ro", addr2: "", mapx: "126.41", mapy: "33.25", tel: "", homepage: "www.y.kr", overview: "A<br>B" }, { usetime: "9-18" }, "t");
  assert.deepEqual(p, { contentId: "1", contentTypeId: "76", nameEn: "Yeomiji", address: "93 Jungmungwangwang-ro", lat: 33.25, lng: 126.41, useTime: "9-18", restDate: null, tel: null, homepage: "https://www.y.kr", overview: "A\nB", fetchedAt: "t" });
});

test("festivalEdition finds overlap with the March window in the item's year", () => {
  assert.equal(festivalEdition({ eventstartdate: "20270312", eventenddate: "20270315" }), 2027);
  assert.equal(festivalEdition({ eventstartdate: "20260320", eventenddate: "20260405" }), 2026);
  assert.equal(festivalEdition({ eventstartdate: "20260410", eventenddate: "20260420" }), 2026);
  assert.equal(festivalEdition({ eventstartdate: "20260501", eventenddate: "20260510" }), null);
  assert.equal(festivalEdition({ eventstartdate: "20261201", eventenddate: "20270302" }), 2027);
  assert.equal(festivalEdition({ eventstartdate: "x" }), null);
});

test("pickPhotos keeps Jeju matches, newest first, no duplicates", () => {
  const items = [
    { galTitle: "산방산", galPhotographyLocation: "제주도", galPhotographyMonth: "201004", galWebImageUrl: "a" },
    { galTitle: "산방산 유채꽃", galPhotographyLocation: "제주특별자치도 서귀포시", galPhotographyMonth: "202303", galWebImageUrl: "b" },
    { galTitle: "산방산", galPhotographyLocation: "제주도", galPhotographyMonth: "201004", galWebImageUrl: "a" },
    { galTitle: "북한산", galPhotographyLocation: "서울", galPhotographyMonth: "202401", galWebImageUrl: "c" },
    { galTitle: "용머리해안", galSearchKeyword: "산방산, 제주도", galPhotographyMonth: "201901", galWebImageUrl: "d" },
    { galTitle: "산방산", galPhotographyLocation: "제주도" },
  ];
  assert.deepEqual(pickPhotos(items, "산방산").map((p) => p.galWebImageUrl), ["b", "d", "a"]);
  assert.deepEqual(pickPhotos(items, "4.3평화공원"), []);
});

test("photographerName drops the agency prefix", () => {
  assert.equal(photographerName("한국관광공사 김지호"), "김지호");
  assert.equal(photographerName("Kim"), "Kim");
  assert.equal(photographerName(""), null);
});

test("imageSize reads JPEG, PNG and WebP headers", () => {
  // Minimal JPEG: SOI, APP0 (len 16), SOF0 with height 300, width 400.
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, ...Buffer.alloc(14)]);
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0x2c, 0x01, 0x90, 0x03, ...Buffer.alloc(9)]);
  assert.deepEqual(imageSize(Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof])), { width: 400, height: 300 });
  const png = Buffer.alloc(33);
  png.writeUInt32BE(0x89504e47, 0);
  png.writeUInt32BE(640, 16);
  png.writeUInt32BE(480, 20);
  assert.deepEqual(imageSize(png), { width: 640, height: 480 });
  const webp = Buffer.alloc(32);
  webp.write("RIFF", 0, "ascii");
  webp.write("WEBPVP8X", 8, "ascii");
  webp.writeUIntLE(1199, 24, 3);
  webp.writeUIntLE(799, 27, 3);
  assert.deepEqual(imageSize(webp), { width: 1200, height: 800 });
  assert.equal(imageSize(Buffer.from("nope")), null);
});

test("fitWidth shrinks but never enlarges", () => {
  assert.deepEqual(fitWidth({ width: 2400, height: 1600 }, 1200), { width: 1200, height: 800 });
  assert.deepEqual(fitWidth({ width: 800, height: 600 }, 1200), { width: 800, height: 600 });
});
