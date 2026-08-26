/**
 * 신분류체계 중분류 59행 기준표 (EI-KT-001 · DR-CF-001).
 *
 * 공사 `lclsSystmCode2` 를 대분류 10종에 대해 각각 불러 모은 것이다 (2026.08.27 실호출,
 * 11콜). 관광지 원문이 아니라 코드 기준표라 무저장 원칙 대상이 아니다.
 *
 * **이 표가 세 곳의 선행 조건이다** — 중분류별 기본 체류시간(FR-IN-011), 실내 · 야외
 * 매핑(FR-RU-090), 기대 콘텐츠 프로파일의 `expected_lcls2`(FR-RU-100). 셋 다 59행을
 * 전제하는데 그전까지는 픽스처가 실제로 쓰는 것만 담고 있었다.
 *
 * ⚠️ **이름을 임의로 줄여 적지 않는다.** 공사가 주는 이름 그대로다. 이전에 주석으로
 *    「자연공원」 · 「박물관 · 기념관」 처럼 적어 뒀는데 실제 이름은 「도시공원」 ·
 *    「전시시설」 이었다. 코드는 맞았고 이름만 틀렸다.
 */

export interface LclsSystm2 {
  readonly name: string;
  /** 대분류 코드 (2자) */
  readonly parent: string;
}

export const LCLS_SYSTM1: Readonly<Record<string, string>> = {
  AC: '숙박',
  C01: '추천코스',
  EV: '축제/공연/행사',
  EX: '체험관광',
  FD: '음식',
  HS: '역사관광',
  LS: '레저스포츠',
  NA: '자연관광',
  SH: '쇼핑',
  VE: '문화관광',
};

export const LCLS_SYSTM2: Readonly<Record<string, LclsSystm2>> = {
  // AC 숙박
  AC01: { name: '호텔', parent: 'AC' },
  AC02: { name: '콘도미니엄', parent: 'AC' },
  AC03: { name: '펜션/민박', parent: 'AC' },
  AC04: { name: '모텔', parent: 'AC' },
  AC05: { name: '캠핑', parent: 'AC' },
  AC06: { name: '호스텔', parent: 'AC' },
  // C01 추천코스
  C0112: { name: '가족코스', parent: 'C01' },
  C0113: { name: '나홀로코스', parent: 'C01' },
  C0114: { name: '힐링코스', parent: 'C01' },
  C0115: { name: '도보코스', parent: 'C01' },
  C0116: { name: '캠핑코스', parent: 'C01' },
  C0117: { name: '맛코스', parent: 'C01' },
  // EV 축제/공연/행사
  EV01: { name: '축제', parent: 'EV' },
  EV02: { name: '공연', parent: 'EV' },
  EV03: { name: '행사', parent: 'EV' },
  // EX 체험관광
  EX01: { name: '전통체험', parent: 'EX' },
  EX02: { name: '공예체험', parent: 'EX' },
  EX03: { name: '농.산.어촌 체험', parent: 'EX' },
  EX04: { name: '산사체험', parent: 'EX' },
  EX05: { name: '웰니스관광', parent: 'EX' },
  EX06: { name: '산업관광', parent: 'EX' },
  EX07: { name: '기타체험', parent: 'EX' },
  // FD 음식
  FD01: { name: '한식', parent: 'FD' },
  FD02: { name: '외국식', parent: 'FD' },
  FD03: { name: '간이음식', parent: 'FD' },
  FD04: { name: '주점', parent: 'FD' },
  FD05: { name: '카페/ 찻집', parent: 'FD' },
  // HS 역사관광
  HS01: { name: '역사유적지', parent: 'HS' },
  HS02: { name: '역사유물', parent: 'HS' },
  HS03: { name: '종교성지', parent: 'HS' },
  HS04: { name: '안보관광지', parent: 'HS' },
  // LS 레저스포츠
  LS01: { name: '육상레저스포츠', parent: 'LS' },
  LS02: { name: '수상레저스포츠', parent: 'LS' },
  LS03: { name: '항공레저스포츠', parent: 'LS' },
  LS04: { name: '복합레저스포츠', parent: 'LS' },
  // NA 자연관광
  NA01: { name: '자연경관(산)', parent: 'NA' },
  NA02: { name: '자연경관(하천‧해양)', parent: 'NA' },
  NA03: { name: '자연생태', parent: 'NA' },
  NA04: { name: '자연공원', parent: 'NA' },
  NA05: { name: '기타자연관광', parent: 'NA' },
  // SH 쇼핑
  SH01: { name: '백화점', parent: 'SH' },
  SH02: { name: '쇼핑몰', parent: 'SH' },
  SH03: { name: '대형마트', parent: 'SH' },
  SH04: { name: '면세점', parent: 'SH' },
  SH05: { name: '전문매장/상가', parent: 'SH' },
  SH06: { name: '시장', parent: 'SH' },
  SH07: { name: '기타쇼핑시설', parent: 'SH' },
  // VE 문화관광
  VE01: { name: '랜드마크관광', parent: 'VE' },
  VE02: { name: '테마공원', parent: 'VE' },
  VE03: { name: '도시공원', parent: 'VE' },
  VE04: { name: '도시.지역문화관광', parent: 'VE' },
  VE05: { name: '복합관광시설', parent: 'VE' },
  VE06: { name: '공연시설', parent: 'VE' },
  VE07: { name: '전시시설', parent: 'VE' },
  VE08: { name: '행사시설', parent: 'VE' },
  VE09: { name: '교육시설', parent: 'VE' },
  VE10: { name: '레저스포츠시설', parent: 'VE' },
  VE11: { name: '교통시설', parent: 'VE' },
  VE12: { name: '기타문화관광지', parent: 'VE' },
};

/** 중분류 코드가 기준표에 있는가. 없으면 판정에 쓰지 않는다 */
export function isKnownLcls2(code: string | null): boolean {
  return code !== null && code in LCLS_SYSTM2;
}

/** 그 대분류의 중분류 코드들 */
export function lcls2Of(parent: string): readonly string[] {
  return Object.entries(LCLS_SYSTM2).filter(([, v]) => v.parent === parent).map(([k]) => k);
}
