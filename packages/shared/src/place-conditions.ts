/**
 * 장소 「자세히」의 무장애 · 반려동물 조건 이름표 (UI-S2-040 · EI-KT-022 · 023 · #850).
 *
 * 상세 응답(`detailWithTour2` · `detailPetTour2`)의 필드 이름을 화면 말로 옮긴다. 값은 공사
 * 원문 그대로 보이고 저장하지 않는다(DB 명세서 6-4). 표의 순서가 화면의 순서다.
 */

export interface ConditionRow {
  readonly label: string;
  readonly value: string;
}

/** 무장애 여행 정보 상세 — 이동 · 시설 · 시각 · 청각 · 영유아 순 */
export const ACCESSIBLE_FIELD_LABEL: Readonly<Record<string, string>> = {
  wheelchair: '휠체어',
  route: '접근로',
  exit: '출입통로',
  elevator: '엘리베이터',
  restroom: '화장실',
  parking: '장애인 주차',
  publictransport: '대중교통',
  ticketoffice: '매표소',
  auditorium: '관람석',
  room: '객실',
  handicapetc: '지체장애 기타',
  helpdog: '보조견 동반',
  guidehuman: '안내요원',
  audioguide: '오디오 가이드',
  bigprint: '큰 활자 안내물',
  brailepromotion: '점자 안내물',
  braileblock: '점자블록',
  guidesystem: '유도 안내 설비',
  blindhandicapetc: '시각장애 기타',
  signguide: '수어 안내',
  videoguide: '자막 영상 안내',
  hearingroom: '청각장애 객실',
  hearinghandicapetc: '청각장애 기타',
  promotion: '안내물',
  stroller: '유모차',
  lactationroom: '수유실',
  babysparechair: '유아용 의자',
  infantsfamilyetc: '영유아 가족 기타',
};

/** 반려동물 동반여행 상세 — 동반 조건 · 필요 사항 · 시설 순 */
export const PET_FIELD_LABEL: Readonly<Record<string, string>> = {
  acmpyTypeCd: '동반 구분',
  acmpyPsblCpam: '동반 가능 동물',
  acmpyNeedMtr: '동반 시 필요 사항',
  relaAcdntRiskMtr: '사고 대비 사항',
  etcAcmpyInfo: '기타 동반 정보',
  relaPosesFclty: '구비 시설',
  relaFrnshPrdlst: '비치 품목',
  relaPurcPrdlst: '구매 품목',
  relaRntlPrdlst: '대여 품목',
};

/**
 * 비어 있지 않은 **아는** 항목만 표의 순서대로. 모르는 키는 싣지 않는다 — 영어 필드 이름이
 * 화면에 나가면 내부 코드다(UI-CM-040). 값이 없으면 빈 목록이고, 화면은 그때 한 줄로 줄인다.
 */
export function conditionRows(
  fields: Readonly<Record<string, unknown>> | null | undefined,
  labels: Readonly<Record<string, string>>,
): ConditionRow[] {
  if (fields === null || fields === undefined) return [];
  const rows: ConditionRow[] = [];
  for (const [key, label] of Object.entries(labels)) {
    const raw = fields[key];
    const value = typeof raw === 'string' ? raw.trim() : typeof raw === 'number' ? String(raw) : '';
    if (value !== '') rows.push({ label, value });
  }
  return rows;
}
