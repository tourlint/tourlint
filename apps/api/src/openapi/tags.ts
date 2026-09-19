/**
 * `/docs` 의 묶음과 순서. 서비스를 쓰는 순서 그대로다 — 로그인 → 상품 · 일정 → 장소 연결 →
 * 검수 → 수정안 → 리포트 · 출시 → 레이더.
 *
 * 태그 정렬을 끄고 이 배열 순서를 쓴다. 설명은 한 줄, 누구나 아는 말로 (#619).
 */
export const TAGS = [
  { name: '서비스 상태', description: '서버 상태 확인' },
  { name: '인증', description: '회원가입과 로그인. 로그인하면 세션 쿠키가 발급됩니다.' },
  { name: '상품', description: '관광상품 만들기 · 조회 · 수정 · 삭제' },
  { name: '일정', description: '엑셀 · CSV · 글로 일정 불러오기와 일정 항목 편집' },
  { name: '관광지 연결', description: '일정의 장소를 한국관광공사 관광지와 연결' },
  { name: '장소 찾기', description: '지역별 관광지 · 행사 · 걷기 길 조회' },
  { name: '검수', description: '일정 검수 요청과 결과 조회' },
  { name: '수정안', description: '문제를 고치는 수정안 미리보기 · 적용 · 되돌리기' },
  { name: '리포트 · 출시', description: 'PDF 리포트와 출시 승인' },
  { name: '레이더', description: '출시 후 관광정보 변경 알림과 관심 지역 소식' },
  { name: '검수 기준', description: '표준 기준 · 회사 기준과 검수 규칙 설명' },
  { name: '코드 · 호출량', description: '지역 · 분류 코드와 외부 API 호출량' },
] as const;

export type TagName = (typeof TAGS)[number]['name'];
