/**
 * `/docs` 맨 위 소개글. API 문서답게 짧게 — 무엇을 하는 API 인지와 호출 형식만 말한다 (#619).
 */
export const INTRO = `
> 이 문서는 API 호출 형식을 확인하기 위한 문서입니다. 실제로 API를 호출 및 활용할 시 데이터에 변화가 생기므로 확인용으로만 사용 부탁드립니다.

**TourLint** 는 여행사가 만든 관광상품 일정을 한국관광공사 관광정보로 출시 전에 검수하는 서비스입니다.
서비스 주소: [tourlint-web.up.railway.app](https://tourlint-web.up.railway.app/)

- 기본 주소는 \`/api/v1\` 이고, 요청과 응답은 JSON 입니다.
- 로그인(\`POST /api/v1/auth/login\`)하면 세션 쿠키가 발급됩니다. 자물쇠 표시가 있는 API 는 로그인이 필요합니다.
- 오류는 모두 같은 형식입니다.

\`\`\`json
{ "reasonCode": "NOT_FOUND", "message": "상품을 찾을 수 없습니다.", "unit": "PRODUCT", "traceId": "9f2c1a7b3e4d5f60", "occurredAt": "2026-09-20T01:23:45.678Z" }
\`\`\`

출처: ⓒ한국관광공사
`.trim();
