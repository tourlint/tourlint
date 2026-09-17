// 데모 시연 상품 데이터 (PM-TA-003 · DR-TD-007).
//
// fixtures/products/TP-01~04 에서 생성한다 — 픽스처가 검수 정답셋의 원본이라 데모도
// 같은 데이터를 쓰면 시연과 회귀가 어긋나지 않는다. 손으로 고치지 말고 스크립트로 다시 뽑는다.
// contentId 가 전부 있어 match_status 는 CONFIRMED 로 고정한다 (DR-IN-004)
//
// **출발일만 픽스처와 다르다.** 픽스처는 2026-10 이고 시드는 정확히 5주 뒤인 2026-11 이다 —
// 시연 일정이 과거가 되면 R08 이 「현재 시각 기준」 폴백으로 내려가고 R09 가 예보 범위를
// 벗어난다 (이슈 #429). 7의 배수로만 옮긴다. 요일이 바뀌면 `매주 화요일` 휴무로 나는 차단이
// 사라져 명세 AC 의 29점이 재현되지 않는다. 다시 뽑을 때도 이 값을 유지하고,
// `demo-dates.spec.ts` 가 요일 · 공휴일 · 미래 여부를 묶어 둔다
//
// targetKey · conceptKey 는 **코드**다. 한글 라벨을 담으면 target_profile 이 코드로
// 저장돼 있어 R10 이 어느 행도 못 찾고 판정 대신 확인 불가를 낸다 (이슈 #310)..

export interface DemoItem {
  readonly dayNo: number;
  readonly seq: number;
  readonly startTime: string;
  readonly endTime: string | null;
  readonly endTimeSource: 'INPUT' | 'DWELL_DEFAULT';
  readonly placeLabel: string;
  readonly itemType: string;
  readonly ktoContentId: string;
  readonly contentTypeId: number;
  readonly lclsSystm1: string | null;
  readonly lclsSystm2: string | null;
  readonly lclsSystm3: string | null;
  /** 좌표가 없으면 R08 이 구간을 COORD_MISSING 으로 넘겨 길찾기를 부르지 않는다 */
  readonly mapx: number;
  readonly mapy: number;
}

/**
 * 시연 상품이 시드 직후 서 있을 보드 칸 (UI-S1-010 · PM-TA-003). 심사에서 4칸이 비어 보이지
 * 않게 단계마다 하나 이상 둔다. `stage-of` 의 판정과 같은 신호로 만든다:
 *   PLANNING   planned_at NULL (검수 시작 전) · 검수 실행 없음
 *   REVIEW     planned_at 있음 + 검수했는데 차단이 남음(blocker_cnt > 0)
 *   RELEASABLE planned_at 있음 + 검수 차단 0 · released_at NULL
 *   RELEASED   planned_at 있음 + 검수 차단 0 + released_at 있음
 */
export type DemoStage = 'PLANNING' | 'REVIEW' | 'RELEASABLE' | 'RELEASED';

export interface DemoProduct {
  readonly name: string;
  readonly ldongRegnCd: string;
  readonly ldongSignguCd: string | null;
  readonly startDate: string;
  readonly nights: number;
  readonly targetKey: string | null;
  readonly conceptKey: string | null;
  readonly headCount: number | null;
  readonly transport: string;
  readonly stage: DemoStage;
  readonly items: readonly DemoItem[];
}

export const DEMO_PRODUCTS: readonly DemoProduct[] = [
  {
    name: "강릉 역사·힐링 2박 3일",
    ldongRegnCd: "51",
    ldongSignguCd: "150",
    startDate: "2026-11-12",
    nights: 2,
    targetKey: "SENIOR",
    conceptKey: "HERITAGE",
    headCount: 20,
    transport: "CAR",
    stage: "RELEASED",
    items: [
      { dayNo: 1, seq: 1, startTime: "10:00", endTime: "11:30", endTimeSource: "INPUT", placeLabel: "강릉 경포대", itemType: "SIGHT", ktoContentId: "125790", contentTypeId: 12, lclsSystm1: "HS", lclsSystm2: "HS01", lclsSystm3: "HS011200", mapx: 128.896483966593, mapy: 37.7955136762197 },
      { dayNo: 1, seq: 2, startTime: "12:00", endTime: "13:00", endTimeSource: "INPUT", placeLabel: "가람집옹심이", itemType: "MEAL", ktoContentId: "2868839", contentTypeId: 39, lclsSystm1: "FD", lclsSystm2: "FD01", lclsSystm3: "FD010100", mapx: 128.9393320379, mapy: 37.7611934162 },
      { dayNo: 1, seq: 3, startTime: "13:30", endTime: "15:00", endTimeSource: "INPUT", placeLabel: "강릉 오죽헌·시립박물관", itemType: "SIGHT", ktoContentId: "129784", contentTypeId: 14, lclsSystm1: "VE", lclsSystm2: "VE07", lclsSystm3: "VE070100", mapx: 128.87966210169768, mapy: 37.779138874844655 },
      { dayNo: 1, seq: 4, startTime: "15:30", endTime: "16:30", endTimeSource: "INPUT", placeLabel: "강릉 농산물도매시장", itemType: "SIGHT", ktoContentId: "1756581", contentTypeId: 38, lclsSystm1: "SH", lclsSystm2: "SH06", lclsSystm3: "SH060200", mapx: 128.9182652483, mapy: 37.7367152805 },
      { dayNo: 1, seq: 5, startTime: "17:30", endTime: null, endTimeSource: "DWELL_DEFAULT", placeLabel: "강릉강변스테이", itemType: "LODGING", ktoContentId: "4074363", contentTypeId: 32, lclsSystm1: "AC", lclsSystm2: "AC06", lclsSystm3: "AC060200", mapx: 128.9076948798, mapy: 37.7557793623 },
      { dayNo: 2, seq: 1, startTime: "10:00", endTime: "11:00", endTimeSource: "INPUT", placeLabel: "강릉 한복 문화 창작소", itemType: "SIGHT", ktoContentId: "3379937", contentTypeId: 14, lclsSystm1: "VE", lclsSystm2: "VE12", lclsSystm3: "VE120300", mapx: 128.90058574629984, mapy: 37.75876088749246 },
      { dayNo: 2, seq: 2, startTime: "12:00", endTime: "13:00", endTimeSource: "INPUT", placeLabel: "감천골", itemType: "MEAL", ktoContentId: "3536478", contentTypeId: 39, lclsSystm1: "FD", lclsSystm2: "FD01", lclsSystm3: "FD010100", mapx: 128.9130203491, mapy: 37.7666922663 },
      { dayNo: 2, seq: 3, startTime: "14:00", endTime: "15:30", endTimeSource: "INPUT", placeLabel: "강릉 녹색도시체험센터", itemType: "SIGHT", ktoContentId: "2465063", contentTypeId: 12, lclsSystm1: "EX", lclsSystm2: "EX06", lclsSystm3: "EX061000", mapx: 128.9065001770321, mapy: 37.7879160027723 },
      { dayNo: 2, seq: 4, startTime: "17:30", endTime: null, endTimeSource: "DWELL_DEFAULT", placeLabel: "강릉관광호텔", itemType: "LODGING", ktoContentId: "3540781", contentTypeId: 32, lclsSystm1: "AC", lclsSystm2: "AC01", lclsSystm3: "AC010100", mapx: 128.8947280147, mapy: 37.7517436388 },
      { dayNo: 3, seq: 1, startTime: "09:30", endTime: "10:30", endTimeSource: "INPUT", placeLabel: "강릉 남산공원", itemType: "SIGHT", ktoContentId: "3022373", contentTypeId: 12, lclsSystm1: "VE", lclsSystm2: "VE03", lclsSystm3: "VE030400", mapx: 128.8934279040127, mapy: 37.74732001026134 },
      { dayNo: 3, seq: 2, startTime: "12:00", endTime: "13:00", endTimeSource: "INPUT", placeLabel: "감자적본부", itemType: "MEAL", ktoContentId: "2868869", contentTypeId: 39, lclsSystm1: "FD", lclsSystm2: "FD01", lclsSystm3: "FD010100", mapx: 128.9396208746, mapy: 37.7620461009 },
      { dayNo: 3, seq: 3, startTime: "14:00", endTime: "15:00", endTimeSource: "INPUT", placeLabel: "강릉 굴산사지", itemType: "SIGHT", ktoContentId: "125769", contentTypeId: 12, lclsSystm1: "HS", lclsSystm2: "HS01", lclsSystm3: "HS010700", mapx: 128.8918046506, mapy: 37.7072681694 },
    ],
  },
  {
    name: "강릉 경계 검증 2박 3일",
    ldongRegnCd: "51",
    ldongSignguCd: "150",
    startDate: "2026-11-19",
    nights: 2,
    targetKey: "SENIOR",
    conceptKey: "HERITAGE",
    headCount: 15,
    transport: "CAR",
    stage: "REVIEW",
    items: [
      { dayNo: 1, seq: 1, startTime: "09:00", endTime: "10:30", endTimeSource: "INPUT", placeLabel: "강릉 녹색도시체험센터", itemType: "SIGHT", ktoContentId: "2465063", contentTypeId: 12, lclsSystm1: "EX", lclsSystm2: "EX06", lclsSystm3: "EX061000", mapx: 128.9065001770321, mapy: 37.7879160027723 },
      { dayNo: 1, seq: 2, startTime: "12:00", endTime: "13:00", endTimeSource: "INPUT", placeLabel: "가람집옹심이", itemType: "MEAL", ktoContentId: "2868839", contentTypeId: 39, lclsSystm1: "FD", lclsSystm2: "FD01", lclsSystm3: "FD010100", mapx: 128.9393320379, mapy: 37.7611934162 },
      { dayNo: 1, seq: 3, startTime: "16:45", endTime: "17:45", endTimeSource: "INPUT", placeLabel: "강릉 오죽헌·시립박물관", itemType: "SIGHT", ktoContentId: "129784", contentTypeId: 14, lclsSystm1: "VE", lclsSystm2: "VE07", lclsSystm3: "VE070100", mapx: 128.87966210169768, mapy: 37.779138874844655 },
      { dayNo: 1, seq: 4, startTime: "18:00", endTime: null, endTimeSource: "DWELL_DEFAULT", placeLabel: "강릉강변스테이", itemType: "LODGING", ktoContentId: "4074363", contentTypeId: 32, lclsSystm1: "AC", lclsSystm2: "AC06", lclsSystm3: "AC060200", mapx: 128.9076948798, mapy: 37.7557793623 },
      { dayNo: 2, seq: 1, startTime: "09:00", endTime: "10:00", endTimeSource: "INPUT", placeLabel: "강릉 한복 문화 창작소", itemType: "SIGHT", ktoContentId: "3379937", contentTypeId: 14, lclsSystm1: "VE", lclsSystm2: "VE12", lclsSystm3: "VE120300", mapx: 128.90058574629984, mapy: 37.75876088749246 },
      { dayNo: 2, seq: 2, startTime: "15:30", endTime: "16:30", endTimeSource: "INPUT", placeLabel: "감자유원지", itemType: "MEAL", ktoContentId: "2941250", contentTypeId: 39, lclsSystm1: "FD", lclsSystm2: "FD01", lclsSystm3: "FD010100", mapx: 128.8973878845, mapy: 37.7563490042 },
      { dayNo: 2, seq: 3, startTime: "18:00", endTime: null, endTimeSource: "DWELL_DEFAULT", placeLabel: "강릉관광호텔", itemType: "LODGING", ktoContentId: "3540781", contentTypeId: 32, lclsSystm1: "AC", lclsSystm2: "AC01", lclsSystm3: "AC010100", mapx: 128.8947280147, mapy: 37.7517436388 },
      { dayNo: 3, seq: 1, startTime: "10:00", endTime: "11:00", endTimeSource: "INPUT", placeLabel: "강릉 경포대", itemType: "SIGHT", ktoContentId: "125790", contentTypeId: 12, lclsSystm1: "HS", lclsSystm2: "HS01", lclsSystm3: "HS011200", mapx: 128.896483966593, mapy: 37.7955136762197 },
      { dayNo: 3, seq: 2, startTime: "17:30", endTime: "18:30", endTimeSource: "INPUT", placeLabel: "강릉 농산물도매시장", itemType: "SIGHT", ktoContentId: "1756581", contentTypeId: 38, lclsSystm1: "SH", lclsSystm2: "SH06", lclsSystm3: "SH060200", mapx: 128.9182652483, mapy: 37.7367152805 },
    ],
  },
  {
    name: "강릉 감성 1박 2일",
    ldongRegnCd: "51",
    ldongSignguCd: "150",
    startDate: "2026-11-17",
    nights: 1,
    targetKey: "YOUTH_20S",
    conceptKey: "EMOTIONAL",
    headCount: 12,
    transport: "CAR",
    stage: "RELEASABLE",
    items: [
      { dayNo: 1, seq: 1, startTime: "10:00", endTime: "11:30", endTimeSource: "INPUT", placeLabel: "강릉 경포대", itemType: "SIGHT", ktoContentId: "125790", contentTypeId: 12, lclsSystm1: "HS", lclsSystm2: "HS01", lclsSystm3: "HS011200", mapx: 128.896483966593, mapy: 37.7955136762197 },
      { dayNo: 1, seq: 2, startTime: "12:00", endTime: "13:00", endTimeSource: "INPUT", placeLabel: "가람집옹심이", itemType: "MEAL", ktoContentId: "2868839", contentTypeId: 39, lclsSystm1: "FD", lclsSystm2: "FD01", lclsSystm3: "FD010100", mapx: 128.9393320379, mapy: 37.7611934162 },
      { dayNo: 1, seq: 3, startTime: "12:30", endTime: "14:00", endTimeSource: "INPUT", placeLabel: "강릉 오죽헌·시립박물관", itemType: "SIGHT", ktoContentId: "129784", contentTypeId: 14, lclsSystm1: "VE", lclsSystm2: "VE07", lclsSystm3: "VE070100", mapx: 128.87966210169768, mapy: 37.779138874844655 },
      { dayNo: 1, seq: 4, startTime: "19:00", endTime: null, endTimeSource: "DWELL_DEFAULT", placeLabel: "강릉강변스테이", itemType: "LODGING", ktoContentId: "4074363", contentTypeId: 32, lclsSystm1: "AC", lclsSystm2: "AC06", lclsSystm3: "AC060200", mapx: 128.9076948798, mapy: 37.7557793623 },
      { dayNo: 2, seq: 1, startTime: "09:00", endTime: "10:00", endTimeSource: "INPUT", placeLabel: "강릉 경포벚꽃축제", itemType: "SIGHT", ktoContentId: "695592", contentTypeId: 15, lclsSystm1: "EV", lclsSystm2: "EV01", lclsSystm3: "EV010200", mapx: 128.895500767487, mapy: 37.7942610311229 },
      { dayNo: 2, seq: 2, startTime: "12:00", endTime: "12:30", endTimeSource: "INPUT", placeLabel: "감천골", itemType: "MEAL", ktoContentId: "3536478", contentTypeId: 39, lclsSystm1: "FD", lclsSystm2: "FD01", lclsSystm3: "FD010100", mapx: 128.9130203491, mapy: 37.7666922663 },
      { dayNo: 2, seq: 3, startTime: "13:00", endTime: "14:00", endTimeSource: "INPUT", placeLabel: "갈골한과체험전시관", itemType: "SIGHT", ktoContentId: "3539725", contentTypeId: 14, lclsSystm1: "VE", lclsSystm2: "VE07", lclsSystm3: "VE070300", mapx: 128.8433165066, mapy: 37.8245592109 },
      { dayNo: 2, seq: 4, startTime: "15:00", endTime: "16:00", endTimeSource: "INPUT", placeLabel: "강릉 농산물도매시장", itemType: "SIGHT", ktoContentId: "1756581", contentTypeId: 38, lclsSystm1: "SH", lclsSystm2: "SH06", lclsSystm3: "SH060200", mapx: 128.9182652483, mapy: 37.7367152805 },
    ],
  },
  {
    name: "강릉 실패 격리 검증 1박 2일",
    ldongRegnCd: "51",
    ldongSignguCd: "150",
    startDate: "2026-11-26",
    nights: 1,
    targetKey: "SENIOR",
    conceptKey: "HERITAGE",
    headCount: 10,
    transport: "CAR",
    stage: "PLANNING",
    items: [
      { dayNo: 1, seq: 1, startTime: "10:00", endTime: "11:30", endTimeSource: "INPUT", placeLabel: "강릉 경포대", itemType: "SIGHT", ktoContentId: "125790", contentTypeId: 12, lclsSystm1: null, lclsSystm2: "HS01", lclsSystm3: null, mapx: 128.896483966593, mapy: 37.7955136762197 },
      { dayNo: 1, seq: 2, startTime: "12:00", endTime: "13:00", endTimeSource: "INPUT", placeLabel: "감천골", itemType: "MEAL", ktoContentId: "3536478", contentTypeId: 39, lclsSystm1: null, lclsSystm2: "FD01", lclsSystm3: null, mapx: 128.9130203491, mapy: 37.7666922663 },
      { dayNo: 1, seq: 3, startTime: "13:30", endTime: "15:00", endTimeSource: "INPUT", placeLabel: "강릉 오죽헌·시립박물관", itemType: "SIGHT", ktoContentId: "129784", contentTypeId: 14, lclsSystm1: null, lclsSystm2: "VE07", lclsSystm3: null, mapx: 128.87966210169768, mapy: 37.779138874844655 },
      { dayNo: 1, seq: 4, startTime: "15:30", endTime: "16:30", endTimeSource: "INPUT", placeLabel: "강릉 농산물도매시장", itemType: "SIGHT", ktoContentId: "1756581", contentTypeId: 38, lclsSystm1: null, lclsSystm2: "SH06", lclsSystm3: null, mapx: 128.9182652483, mapy: 37.7367152805 },
      { dayNo: 1, seq: 5, startTime: "17:30", endTime: null, endTimeSource: "DWELL_DEFAULT", placeLabel: "강릉강변스테이", itemType: "LODGING", ktoContentId: "4074363", contentTypeId: 32, lclsSystm1: null, lclsSystm2: "AC06", lclsSystm3: null, mapx: 128.9076948798, mapy: 37.7557793623 },
      { dayNo: 2, seq: 1, startTime: "10:00", endTime: "11:00", endTimeSource: "INPUT", placeLabel: "강릉 남산공원", itemType: "SIGHT", ktoContentId: "3022373", contentTypeId: 12, lclsSystm1: null, lclsSystm2: "VE03", lclsSystm3: null, mapx: 128.8934279040127, mapy: 37.74732001026134 },
      { dayNo: 2, seq: 2, startTime: "12:00", endTime: "13:00", endTimeSource: "INPUT", placeLabel: "감자적본부", itemType: "MEAL", ktoContentId: "2868869", contentTypeId: 39, lclsSystm1: null, lclsSystm2: "FD01", lclsSystm3: null, mapx: 128.9396208746, mapy: 37.7620461009 },
      { dayNo: 2, seq: 3, startTime: "14:00", endTime: "15:00", endTimeSource: "INPUT", placeLabel: "강릉 굴산사지", itemType: "SIGHT", ktoContentId: "125769", contentTypeId: 12, lclsSystm1: null, lclsSystm2: "HS01", lclsSystm3: null, mapx: 128.8918046506, mapy: 37.7072681694 },
    ],
  },
];
