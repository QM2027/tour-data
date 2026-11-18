# tour-data

Korea Tourism Organization data for the QM2027 site, fetched from data.go.kr by GitHub Actions and
published to GitHub Pages at https://qm2027.github.io/tour-data/. Nothing generated is committed;
the site reads the published files.

## Published files

| File | Contents |
| --- | --- |
| `index.json` | `{ schema: 1, generatedAt, files, counts, attribution, errors }`. Start here. |
| `places.json` | `{ placeId: { contentId, contentTypeId, nameEn, address, lat, lng, useTime, restDate, tel, homepage, overview, fetchedAt } }` from TourAPI English (`detailCommon2` + `detailIntro2`). `useTime` / `restDate` are the opening hours and closing days as plain text (line breaks kept). |
| `photos.json` | `{ placeId: [ { src, srcSmall, width, height, title, photographer, month, galContentId, modified, license } ] }`, up to 3 per place from PhotoKorea. `src` (≤1200 px) and `srcSmall` (≤480 px) are webp paths relative to `/tour-data/`; `width`/`height` are for `src`. |
| `festivals.json` | `[ { contentId, title, startDate, endDate, edition, datesConfirmed, address, lat, lng, overview, homepage, image? } ]`: Jeju festivals whose run overlaps 1 March – 15 April. TourAPI keeps one item per festival and updates its dates each year, so `edition: 2026, datesConfirmed: false` means the 2027 dates aren't announced yet. |
| `img/*.webp` | Mirrored photos, so visitors' browsers never call a third party and the files survive offline and after the conference. |
| `match.json` | Push/manual runs only: contentId suggestions and photo keyword checks for places without a contentId. |

`placeId`s are the ids in the site's `src/data/places.ts`, listed in `places.config.json`:

```json
{ "yeomiji": { "name": "…", "nameKo": "…", "lat": 33.2, "lng": 126.4, "contentId": "264xxx", "photoKeyword": "여미지식물원" } }
```

`skipInfo` leaves a place out of `places.json`; `skipPhotos` leaves it out of `photos.json`. To match a
new place, add it without `contentId`, push, read `match.json`, and copy the right `contentId` in.

## Schedule and failures

- Push to `main` or **Run workflow**: publish now (and write `match.json`).
- Weekly, Mondays 03:00 UTC.
- The previous published snapshot is the fallback: a place, photo or whole source that fails is
  carried over from it, and the problem is listed in `index.json` `errors`. Without the key the
  previous snapshot is republished as is.
- About 120 API calls per run, well inside the development quota (1,000 calls a day per service).

## Key

`DATA_GO_KR_KEY`: the data.go.kr general key, Encoding or Decoding form, as an Actions secret
(organization secret shared with this repository and `weather-data`). It is never committed or
printed; error bodies that echo it are redacted. Services used: 한국관광공사_영문 관광정보서비스_GW
(`EngService2`) and 한국관광공사_관광사진 정보_GW (`PhotoGalleryService1`).

## Licence and attribution

PhotoKorea photos are KOGL Type 1 (공공누리 제1유형: attribution required; changes and commercial use
allowed), so they are resized and re-encoded. Credit them where shown, for example:

> Photo: Korea Tourism Organization, PhotoKorea (photographer) · KOGL Type 1

TourAPI festival images are published only when marked Type 1; Type 3 (no changes) images are left
out. Text from TourAPI: "Source: Korea Tourism Organization (TourAPI)". The same strings are in
`index.json` `attribution`. Photos may not be used in a way that defames a subject, infringes
personal rights, or as a corporate logo/identity.

## After the conference

The site copies a final snapshot of these files into its own repository, then this workflow is
disabled and the repository archived. Nothing here needs to stay online.

## Local run

```sh
node --test
DATA_GO_KR_KEY=… node scripts/sync.mjs --out /tmp/tour   # needs cwebp for photos
DATA_GO_KR_KEY=… node scripts/match.mjs --all
```
