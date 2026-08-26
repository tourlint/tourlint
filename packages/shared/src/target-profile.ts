/**
 * R10 기대 콘텐츠 프로파일 초기값 (`target_profile` · FR-RU-100 ~ 104 · DR-CF-002).
 *
 * 타깃 · 콘셉트 조합마다 「이 정도는 들어 있어야 자연스럽다」는 중분류를 정의한 표다.
 * 일정에 **0건인 유형**이 있으면 R10 이 주의를 낸다.
 *
 * ⚠️ **판매 예측표가 아니다.** 판매량 · 시장 반응 · 흥행을 표현하지 않는다 (FR-RU-104).
 *    구성 정합성만 본다.
 *
 * 값은 2026.08.27 합의로 확정했다. 중분류 코드는 `LCLS_SYSTM2` 59행 기준표에서 43종을 쓴다.
 *
 * ## 왜 조합을 다 채우는가
 *
 * `target_profile` 은 `(계정, 타깃, 콘셉트)` 로 **정확히 일치**하는 행을 찾는다. 드롭다운에
 * 있는 조합인데 행이 없으면 R10 이 그 상품을 영영 확인 불가로 남긴다. 7 × 9 = 63 행을
 * 빠짐없이 둔 이유다. 그래서 열거값은 **상품등록 화면과 같은 것을 써야 한다** — 자유 입력을
 * 받으면 조회가 안 맞는다.
 *
 * ## 왜 셋씩인가
 *
 * FR-RU-102 가 「기대 항목 중 0건인 유형이 있으면 주의」다. 항목이 많을수록 R10 이 자주
 * 뜬다. 셋이면 「그 콘셉트라면 최소 이건」 수준이고, 다섯으로 늘리면 정상 상품도 걸린다.
 *
 * ## 뺀 대분류
 *
 * `AC`(숙박)는 1박 이상이면 항상 있어 판별력이 없고, `C01`(추천코스)은 일정 항목 유형이 아니다.
 */

export const TARGET_KEY = [
  'YOUTH_20S',
  'ADULT_3040',
  'COUPLE',
  'FAMILY_KIDS',
  'SENIOR',
  'GROUP',
  'SOLO',
] as const;
export type TargetKey = (typeof TARGET_KEY)[number];

export const CONCEPT_KEY = [
  'EMOTIONAL',
  'HEALING',
  'GOURMET',
  'ACTIVITY',
  'HERITAGE',
  'SCENERY',
  'CRAFT',
  'FESTIVAL',
  'SHOPPING',
] as const;
export type ConceptKey = (typeof CONCEPT_KEY)[number];

/** 화면 표기. 판정 문장에도 이 이름이 들어간다 */
export const TARGET_LABEL: Readonly<Record<TargetKey, string>> = {
  YOUTH_20S: '20대',
  ADULT_3040: '30~40대',
  COUPLE: '커플',
  FAMILY_KIDS: '가족(아이 동반)',
  SENIOR: '시니어',
  GROUP: '단체·모임',
  SOLO: '나홀로',
};

export const CONCEPT_LABEL: Readonly<Record<ConceptKey, string>> = {
  EMOTIONAL: '감성',
  HEALING: '힐링',
  GOURMET: '미식',
  ACTIVITY: '액티비티',
  HERITAGE: '역사문화',
  SCENERY: '자연경관',
  CRAFT: '체험·공예',
  FESTIVAL: '축제·공연',
  SHOPPING: '쇼핑',
};

export interface TargetProfileSeed {
  readonly targetKey: TargetKey;
  readonly conceptKey: ConceptKey;
  /** 기대 중분류. `LCLS_SYSTM2` 에 있는 코드만 쓴다 */
  readonly expectedLcls2: readonly string[];
  /** 19:00 이후 일정이 있어야 하는가 (FR-RU-101) */
  readonly expectsNight: boolean;
}

export const TARGET_PROFILE_SEED: readonly TargetProfileSeed[] = [
  // ── 감성 ──
  { targetKey: 'YOUTH_20S', conceptKey: 'EMOTIONAL', expectedLcls2: ['EX02', 'FD05', 'VE01'], expectsNight: true }, // 20대 · 공예체험 카페/ 찻집 랜드마크관광
  { targetKey: 'ADULT_3040', conceptKey: 'EMOTIONAL', expectedLcls2: ['FD05', 'VE07', 'VE01'], expectsNight: true }, // 30~40대 · 카페/ 찻집 전시시설 랜드마크관광
  { targetKey: 'COUPLE', conceptKey: 'EMOTIONAL', expectedLcls2: ['FD05', 'VE01', 'NA02'], expectsNight: true }, // 커플 · 카페/ 찻집 랜드마크관광 자연경관(하천‧해양)
  { targetKey: 'FAMILY_KIDS', conceptKey: 'EMOTIONAL', expectedLcls2: ['VE02', 'VE03', 'FD05'], expectsNight: false }, // 가족(아이 동반) · 테마공원 도시공원 카페/ 찻집
  { targetKey: 'SENIOR', conceptKey: 'EMOTIONAL', expectedLcls2: ['NA02', 'VE07', 'FD01'], expectsNight: false }, // 시니어 · 자연경관(하천‧해양) 전시시설 한식
  { targetKey: 'GROUP', conceptKey: 'EMOTIONAL', expectedLcls2: ['FD05', 'VE01', 'VE05'], expectsNight: false }, // 단체·모임 · 카페/ 찻집 랜드마크관광 복합관광시설
  { targetKey: 'SOLO', conceptKey: 'EMOTIONAL', expectedLcls2: ['FD05', 'VE07', 'VE01'], expectsNight: false }, // 나홀로 · 카페/ 찻집 전시시설 랜드마크관광
  // ── 힐링 ──
  { targetKey: 'YOUTH_20S', conceptKey: 'HEALING', expectedLcls2: ['EX05', 'NA02', 'FD05'], expectsNight: false }, // 20대 · 웰니스관광 자연경관(하천‧해양) 카페/ 찻집
  { targetKey: 'ADULT_3040', conceptKey: 'HEALING', expectedLcls2: ['EX05', 'NA04', 'FD05'], expectsNight: false }, // 30~40대 · 웰니스관광 자연공원 카페/ 찻집
  { targetKey: 'COUPLE', conceptKey: 'HEALING', expectedLcls2: ['EX05', 'NA04', 'NA02'], expectsNight: false }, // 커플 · 웰니스관광 자연공원 자연경관(하천‧해양)
  { targetKey: 'FAMILY_KIDS', conceptKey: 'HEALING', expectedLcls2: ['NA04', 'VE03', 'NA03'], expectsNight: false }, // 가족(아이 동반) · 자연공원 도시공원 자연생태
  { targetKey: 'SENIOR', conceptKey: 'HEALING', expectedLcls2: ['EX05', 'NA04', 'EX04'], expectsNight: false }, // 시니어 · 웰니스관광 자연공원 산사체험
  { targetKey: 'GROUP', conceptKey: 'HEALING', expectedLcls2: ['EX05', 'NA04', 'VE05'], expectsNight: false }, // 단체·모임 · 웰니스관광 자연공원 복합관광시설
  { targetKey: 'SOLO', conceptKey: 'HEALING', expectedLcls2: ['EX05', 'NA04', 'FD05'], expectsNight: false }, // 나홀로 · 웰니스관광 자연공원 카페/ 찻집
  // ── 미식 ──
  { targetKey: 'YOUTH_20S', conceptKey: 'GOURMET', expectedLcls2: ['FD01', 'FD05', 'SH06'], expectsNight: true }, // 20대 · 한식 카페/ 찻집 시장
  { targetKey: 'ADULT_3040', conceptKey: 'GOURMET', expectedLcls2: ['FD01', 'FD02', 'SH06'], expectsNight: true }, // 30~40대 · 한식 외국식 시장
  { targetKey: 'COUPLE', conceptKey: 'GOURMET', expectedLcls2: ['FD01', 'FD05', 'FD02'], expectsNight: true }, // 커플 · 한식 카페/ 찻집 외국식
  { targetKey: 'FAMILY_KIDS', conceptKey: 'GOURMET', expectedLcls2: ['FD01', 'FD03', 'SH06'], expectsNight: false }, // 가족(아이 동반) · 한식 간이음식 시장
  { targetKey: 'SENIOR', conceptKey: 'GOURMET', expectedLcls2: ['FD01', 'SH06', 'FD03'], expectsNight: false }, // 시니어 · 한식 시장 간이음식
  { targetKey: 'GROUP', conceptKey: 'GOURMET', expectedLcls2: ['FD01', 'FD04', 'SH06'], expectsNight: true }, // 단체·모임 · 한식 주점 시장
  { targetKey: 'SOLO', conceptKey: 'GOURMET', expectedLcls2: ['FD01', 'FD03', 'SH06'], expectsNight: false }, // 나홀로 · 한식 간이음식 시장
  // ── 액티비티 ──
  { targetKey: 'YOUTH_20S', conceptKey: 'ACTIVITY', expectedLcls2: ['LS02', 'LS01', 'NA01'], expectsNight: false }, // 20대 · 수상레저스포츠 육상레저스포츠 자연경관(산)
  { targetKey: 'ADULT_3040', conceptKey: 'ACTIVITY', expectedLcls2: ['LS01', 'LS04', 'NA01'], expectsNight: false }, // 30~40대 · 육상레저스포츠 복합레저스포츠 자연경관(산)
  { targetKey: 'COUPLE', conceptKey: 'ACTIVITY', expectedLcls2: ['LS02', 'LS03', 'LS04'], expectsNight: false }, // 커플 · 수상레저스포츠 항공레저스포츠 복합레저스포츠
  { targetKey: 'FAMILY_KIDS', conceptKey: 'ACTIVITY', expectedLcls2: ['VE02', 'LS04', 'LS01'], expectsNight: false }, // 가족(아이 동반) · 테마공원 복합레저스포츠 육상레저스포츠
  { targetKey: 'SENIOR', conceptKey: 'ACTIVITY', expectedLcls2: ['NA04', 'VE03', 'LS01'], expectsNight: false }, // 시니어 · 자연공원 도시공원 육상레저스포츠
  { targetKey: 'GROUP', conceptKey: 'ACTIVITY', expectedLcls2: ['LS04', 'LS01', 'VE10'], expectsNight: false }, // 단체·모임 · 복합레저스포츠 육상레저스포츠 레저스포츠시설
  { targetKey: 'SOLO', conceptKey: 'ACTIVITY', expectedLcls2: ['LS01', 'NA01', 'LS04'], expectsNight: false }, // 나홀로 · 육상레저스포츠 자연경관(산) 복합레저스포츠
  // ── 역사문화 ──
  { targetKey: 'YOUTH_20S', conceptKey: 'HERITAGE', expectedLcls2: ['HS01', 'VE07', 'EX01'], expectsNight: false }, // 20대 · 역사유적지 전시시설 전통체험
  { targetKey: 'ADULT_3040', conceptKey: 'HERITAGE', expectedLcls2: ['HS01', 'HS02', 'VE04'], expectsNight: false }, // 30~40대 · 역사유적지 역사유물 도시.지역문화관광
  { targetKey: 'COUPLE', conceptKey: 'HERITAGE', expectedLcls2: ['HS01', 'VE04', 'VE07'], expectsNight: false }, // 커플 · 역사유적지 도시.지역문화관광 전시시설
  { targetKey: 'FAMILY_KIDS', conceptKey: 'HERITAGE', expectedLcls2: ['HS01', 'VE09', 'EX01'], expectsNight: false }, // 가족(아이 동반) · 역사유적지 교육시설 전통체험
  { targetKey: 'SENIOR', conceptKey: 'HERITAGE', expectedLcls2: ['HS01', 'HS03', 'HS02'], expectsNight: false }, // 시니어 · 역사유적지 종교성지 역사유물
  { targetKey: 'GROUP', conceptKey: 'HERITAGE', expectedLcls2: ['HS01', 'HS02', 'VE04'], expectsNight: false }, // 단체·모임 · 역사유적지 역사유물 도시.지역문화관광
  { targetKey: 'SOLO', conceptKey: 'HERITAGE', expectedLcls2: ['HS01', 'HS02', 'VE07'], expectsNight: false }, // 나홀로 · 역사유적지 역사유물 전시시설
  // ── 자연경관 ──
  { targetKey: 'YOUTH_20S', conceptKey: 'SCENERY', expectedLcls2: ['NA01', 'NA02', 'NA03'], expectsNight: false }, // 20대 · 자연경관(산) 자연경관(하천‧해양) 자연생태
  { targetKey: 'ADULT_3040', conceptKey: 'SCENERY', expectedLcls2: ['NA01', 'NA02', 'NA04'], expectsNight: false }, // 30~40대 · 자연경관(산) 자연경관(하천‧해양) 자연공원
  { targetKey: 'COUPLE', conceptKey: 'SCENERY', expectedLcls2: ['NA02', 'NA01', 'VE01'], expectsNight: false }, // 커플 · 자연경관(하천‧해양) 자연경관(산) 랜드마크관광
  { targetKey: 'FAMILY_KIDS', conceptKey: 'SCENERY', expectedLcls2: ['NA03', 'NA04', 'NA02'], expectsNight: false }, // 가족(아이 동반) · 자연생태 자연공원 자연경관(하천‧해양)
  { targetKey: 'SENIOR', conceptKey: 'SCENERY', expectedLcls2: ['NA01', 'NA04', 'NA02'], expectsNight: false }, // 시니어 · 자연경관(산) 자연공원 자연경관(하천‧해양)
  { targetKey: 'GROUP', conceptKey: 'SCENERY', expectedLcls2: ['NA01', 'NA02', 'VE05'], expectsNight: false }, // 단체·모임 · 자연경관(산) 자연경관(하천‧해양) 복합관광시설
  { targetKey: 'SOLO', conceptKey: 'SCENERY', expectedLcls2: ['NA01', 'NA02', 'NA03'], expectsNight: false }, // 나홀로 · 자연경관(산) 자연경관(하천‧해양) 자연생태
  // ── 체험·공예 ──
  { targetKey: 'YOUTH_20S', conceptKey: 'CRAFT', expectedLcls2: ['EX02', 'EX01', 'EX07'], expectsNight: false }, // 20대 · 공예체험 전통체험 기타체험
  { targetKey: 'ADULT_3040', conceptKey: 'CRAFT', expectedLcls2: ['EX02', 'EX03', 'EX01'], expectsNight: false }, // 30~40대 · 공예체험 농.산.어촌 체험 전통체험
  { targetKey: 'COUPLE', conceptKey: 'CRAFT', expectedLcls2: ['EX02', 'EX05', 'EX01'], expectsNight: false }, // 커플 · 공예체험 웰니스관광 전통체험
  { targetKey: 'FAMILY_KIDS', conceptKey: 'CRAFT', expectedLcls2: ['EX03', 'EX02', 'EX01'], expectsNight: false }, // 가족(아이 동반) · 농.산.어촌 체험 공예체험 전통체험
  { targetKey: 'SENIOR', conceptKey: 'CRAFT', expectedLcls2: ['EX01', 'EX03', 'EX04'], expectsNight: false }, // 시니어 · 전통체험 농.산.어촌 체험 산사체험
  { targetKey: 'GROUP', conceptKey: 'CRAFT', expectedLcls2: ['EX03', 'EX02', 'EX06'], expectsNight: false }, // 단체·모임 · 농.산.어촌 체험 공예체험 산업관광
  { targetKey: 'SOLO', conceptKey: 'CRAFT', expectedLcls2: ['EX02', 'EX07', 'EX01'], expectsNight: false }, // 나홀로 · 공예체험 기타체험 전통체험
  // ── 축제·공연 ──
  { targetKey: 'YOUTH_20S', conceptKey: 'FESTIVAL', expectedLcls2: ['EV01', 'EV02', 'VE06'], expectsNight: true }, // 20대 · 축제 공연 공연시설
  { targetKey: 'ADULT_3040', conceptKey: 'FESTIVAL', expectedLcls2: ['EV01', 'EV02', 'EV03'], expectsNight: true }, // 30~40대 · 축제 공연 행사
  { targetKey: 'COUPLE', conceptKey: 'FESTIVAL', expectedLcls2: ['EV01', 'VE06', 'FD05'], expectsNight: true }, // 커플 · 축제 공연시설 카페/ 찻집
  { targetKey: 'FAMILY_KIDS', conceptKey: 'FESTIVAL', expectedLcls2: ['EV01', 'EV03', 'VE02'], expectsNight: false }, // 가족(아이 동반) · 축제 행사 테마공원
  { targetKey: 'SENIOR', conceptKey: 'FESTIVAL', expectedLcls2: ['EV01', 'EV02', 'VE06'], expectsNight: false }, // 시니어 · 축제 공연 공연시설
  { targetKey: 'GROUP', conceptKey: 'FESTIVAL', expectedLcls2: ['EV01', 'EV03', 'VE08'], expectsNight: true }, // 단체·모임 · 축제 행사 행사시설
  { targetKey: 'SOLO', conceptKey: 'FESTIVAL', expectedLcls2: ['EV01', 'EV02', 'VE07'], expectsNight: false }, // 나홀로 · 축제 공연 전시시설
  // ── 쇼핑 ──
  { targetKey: 'YOUTH_20S', conceptKey: 'SHOPPING', expectedLcls2: ['SH05', 'SH06', 'SH02'], expectsNight: true }, // 20대 · 전문매장/상가 시장 쇼핑몰
  { targetKey: 'ADULT_3040', conceptKey: 'SHOPPING', expectedLcls2: ['SH02', 'SH05', 'SH06'], expectsNight: false }, // 30~40대 · 쇼핑몰 전문매장/상가 시장
  { targetKey: 'COUPLE', conceptKey: 'SHOPPING', expectedLcls2: ['SH05', 'SH02', 'FD05'], expectsNight: true }, // 커플 · 전문매장/상가 쇼핑몰 카페/ 찻집
  { targetKey: 'FAMILY_KIDS', conceptKey: 'SHOPPING', expectedLcls2: ['SH02', 'SH03', 'SH06'], expectsNight: false }, // 가족(아이 동반) · 쇼핑몰 대형마트 시장
  { targetKey: 'SENIOR', conceptKey: 'SHOPPING', expectedLcls2: ['SH06', 'SH03', 'SH01'], expectsNight: false }, // 시니어 · 시장 대형마트 백화점
  { targetKey: 'GROUP', conceptKey: 'SHOPPING', expectedLcls2: ['SH06', 'SH04', 'SH02'], expectsNight: false }, // 단체·모임 · 시장 면세점 쇼핑몰
  { targetKey: 'SOLO', conceptKey: 'SHOPPING', expectedLcls2: ['SH05', 'SH06', 'SH07'], expectsNight: false }, // 나홀로 · 전문매장/상가 시장 기타쇼핑시설
];
