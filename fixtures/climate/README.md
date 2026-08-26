# 평년 강수일수 시드 원본

`climate_normal` 표를 만든 원본 파일이다 (EI-WX-004 · 이슈 #7).

## 어디서 받았나

기상자료개방포털 → 기후통계분석 > 기상현상일수 > 강수일수 > **기간조회**
(`https://data.kma.go.kr/stcs/grnd/grndRnDayList.do?pgmNo=156&menuNo=552`). 로그인 없이 받는다.

| 설정 | 값 |
|---|---|
| 자료구분 | 월 |
| 구분 | 지점 |
| 기간 | 1991 년 ~ 2020 년, 01 월 ~ 12 월 |
| 지역/지점 | 지점 하나 (한 번에 하나만 조회된다) |

받은 파일의 `평균` 행이 곧 평년값이다 — 조회 기간 30년의 누년평균.

기후평년값 화면(`normals/anal6.do`)에는 강수일수가 없다. 요소가 기온 · 풍속 · 강수량뿐이다.

## 넣는 법

```
node scripts/seed_climate_normal.mjs fixtures/climate/<파일>.csv --dry
DATABASE_URL=... node scripts/seed_climate_normal.mjs fixtures/climate/<파일>.csv
```

## 인코딩

EUC-KR 로 온다. 로더가 알아서 읽는다 (`scripts/climate-csv.mjs`).

## 지금 있는 지점

- 강릉(105) — 강원 `42` · `51`

나머지 시도는 `packages/shared/src/climate-station.ts` 참조. 없는 시도는 R09 가 D+11 이상을
확인 불가로 남긴다 — 인접 지역 값으로 대신 채우지 않는다.
