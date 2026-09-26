<callout icon="🔌" color="blue_bg">
	# TourLint API · 백엔드 설계
	**내부 REST API 계약 · 모듈 구조 · 규칙엔진 · 외부 어댑터 · 오류 코드 체계**
	본 문서는 `서비스 기획서`와 `통합 요구사항 명세서`(서비스 범위 · 용어 정의 · 기능 · 화면 · 권한 · 데이터 · 비기능 · 외부 연동 · 예외처리)만을 근거로 전면 재작성되었습니다.
</callout>
<table fit-page-width="true" header-row="true">
<tr>
<td>문서</td>
<td>API · 백엔드 설계 v2.71</td>
</tr>
<tr>
<td>작성일</td>
<td>2026.08.31</td>
</tr>
<tr>
<td>목적</td>
<td>프론트·백엔드 병렬 개발을 위해 내부 API 계약과 처리 흐름을 고정</td>
</tr>
<tr>
<td>선행 문서</td>
<td>DB 명세서 / 기능 요구사항 (FR) / 권한 요구사항 (PM) / 외부 연동 요구사항 (EI) / 예외처리 요구사항 (EX) / 비기능 요구사항 (NF)</td>
</tr>
<tr color="red_bg">
<td>최상위 제약</td>
<td>**브라우저에서 외부 API를 직접 호출하지 않는다. 모든 외부 호출은 서버 어댑터 경유** (PM-SC-002 · EI-CM-001·003)</td>
</tr>
</table>
<table_of_contents/>
---
# 1. 설계 제약
기능 요구사항보다 우선하는 5개 설계 제약이 API 설계에도 그대로 적용됩니다.
<table fit-page-width="true" header-row="true">
<tr>
<td>제약</td>
<td>API 설계에서의 귀결</td>
</tr>
<tr>
<td>① 표시는 항상 실시간, 저장은 판정 근거뿐</td>
<td>관광지 정보 응답은 **DB에서 읽지 않고 요청 시점에 공사 API를 호출**해 구성한다 (DR-PR-004)</td>
</tr>
<tr>
<td>② AI는 정규화, 규칙엔진이 판정</td>
<td>LLM 호출 경로는 F01 구조화 · F03 정규화와 에이전트 셋(장소 찾기 제안 · 확인 질문 정리 · 오늘 할 일 정리, 4-11)**뿐**. **등급·점수·충돌 판정 경로에 LLM이 없다** (EI-LM-001). 에이전트는 제안만 하고 그 문장을 `finding.message` 에 저장하지 않는다. 설명문 생성은 결정론성 때문에 쓰지 않는다</td>
</tr>
<tr>
<td>③ 모르는 것은 모른다고 말한다</td>
<td>외부 호출 실패는 200 + `UNVERIFIED` finding으로 응답. **500으로 던지지 않는다** (EX-CM-003)</td>
</tr>
<tr>
<td>④ 예측하지 않고 관측한다</td>
<td>판매량·흥행 예측 필드를 어떤 응답에도 두지 않는다 (FR-RU-104 · FR-MO-055)</td>
</tr>
<tr>
<td>⑤ 비표출 콘텐츠 미노출</td>
<td>`showflag = 0` 콘텐츠의 명칭·주소·이미지가 **API 응답에도 포함되지 않는다** (PM-NG-009)</td>
</tr>
</table>
---
# 2. 아키텍처
## 2-1. 논리 구성
```plain text
                   [ 웹 프론트엔드 ]
                  Next.js + TypeScript
                           │  HTTPS / JSON
                   [ 관광상품 관리 API ]
                 NestJS 10 + TypeScript 단일 모놀리스
                           │
   ┌───────────────┬───────┴────────┬──────────────────┐
   │               │                │                  │
[일정 구조화]  [매칭 어댑터]   [검수 규칙엔진]    [작업 스케줄러]
 LLM 파서      KTO 클라이언트   R01~R10 결정론적    검수 큐 소비
   │               │            판정              경량 배치
   │        [ 호출 예산 관리자 ]                   타임아웃 감시
   │               │
   │     ┌─────────┴──────────┐
   │  한국관광공사 OpenAPI   외부 API
   │     (실시간 호출)     카카오모빌리티 · 기상청
   │
   └───────────────┬────────────────────────────────┘
                   │
             [ PostgreSQL ]
   상품 · 일정 · 검수실행 · 판정 · 지문 · 호출로그
        ※ 관광지 원문 테이블 없음
```
<callout icon="🏗" color="gray_bg">
	**단일 모놀리스 안에서 모듈만 분리합니다.** 2인 7주 규모에 마이크로서비스는 부적합하며, 검수 실행은 **DB 테이블 + 스케줄러**로 처리하고 별도 메시지 브로커를 두지 않습니다 (NF-MT-010 · NF-CP-012).
</callout>
## 2-2. 패키지 구조
```plain text
tourlint/                      pnpm 워크스페이스 · Node 22+
├── apps/api                   NestJS 10 + TypeScript
│   └── src
│       ├── common             domain.exception · all-exceptions.filter (오류 생성 단일 지점)
│       │
│       ├── engine             판정 엔진. external · persistence 를 import 하지 않는다
│       │   ├── rules          r01-operating ~ r10-target · types · rule 인터페이스
│       │   ├── normalize      운영정보 해석기 (preprocess · parse · closed · hours · merge)
│       │   ├── fingerprint    지문 생성 · 비교 (build · compare)
│       │   ├── itinerary      dwell — 체류시간 보완
│       │   ├── calendar       dates · holidays (공휴일 표)
│       │   ├── signals        수요 신호 T1 · T2 · T3 산출
│       │   └── score.ts       등급 · 출시 준비도
│       │
│       ├── audit              검수 실행 조율 (F04~F09)
│       │   ├── audit.controller     검수 요청 · 폴링 · 결과 · finding · 패치
│       │   ├── audit.service        큐 등록 · 중복 방지 · 예산 게이트 · 확정 · 되돌리기
│       │   ├── audit-runner         파이프라인 오케스트레이션
│       │   ├── rule-registry        규칙 목록
│       │   ├── patch-local · patch-remote      수정안 생성
│       │   ├── patch-conflict · patch-apply    충돌 검사 · 일괄 반영 (순수 함수)
│       │   ├── patch-snapshot                  스냅샷 · 미리보기 토큰
│       │   └── audit-job · product repository
│       │
│       ├── auth               회원가입 · 로그인 · 세션 쿠키 · 인증 가드
│       ├── product            상품 · 일정 항목 · 출시 승인 · 검수 시작(handoff)
│       ├── match              장소 검색 · 확정 · 직접 정한 곳 (F02)
│       ├── content            관광지 상세 실시간 조회 (GET /contents/{id})
│       ├── catalog            법정동 · 분류체계 코드
│       ├── upload             엑셀 · CSV 업로드 · 자연어 구조화 미리보기 (F01)
│       ├── plan               기획 조회 (F17, 신설) — 종류 칩 · 장소 담기 · 행사 · 걷기 길 · 장소 정보 한 줄
│       │                      external 은 쓰되 engine/rules 는 부르지 않는다 (FR-PL-021)
│       ├── agent              AI 에이전트 (F18, 신설) — 장소 찾기 · 전화로 물어볼 내용 · 오늘 할 일
│       │                      agent-runner(도구 호출 반복 · 상한) · agent-guard(도구 결과 밖 값 버림). 읽기 도구만
│       ├── report             PDF 리포트 생성 · 5분 메모리 보관 (F11)
│       ├── radar              레이더 요약 · 변경 · 수요 신호 · 관심 지역 새 소식 · 알림 (F13 · F14)
│       ├── batch              변경 감지 배치 · 신호 배치 · 영향 상품 탐색 (F12)
│       ├── settings           검수 기준 — 표준 요약 · 회사 기준 · 변경 이력 · 관심 키워드 · 관심 지역 (F16)
│       ├── usage              호출 예산 · 호출 이력 집계 (F15)
│       ├── demo               데모 상품 초기 상태 복원 (POST /demo/reset)
│       │
│       ├── persistence        db (pg 풀 · 트랜잭션)
│       │   ├── audit-result.repository       audit_run · finding · content_fingerprint
│       │   ├── patch-application.repository  일정 쓰기 · 패치 이력
│       │   └── api-call-log.repository
│       │
│       ├── external           외부 어댑터 (EI-CM-003)
│       │   ├── kto            transport(서비스별 베이스 URL, 7-2) · envelope · client · content-view · errors · factory
│       │   ├── kakao          KakaoMobilityClient (R08 이동시간 · 장소 정보 한 줄의 걸리는 시간)
│       │   ├── kma            grid · client — 위경도 → 격자 · 단기 · 중기 예보 (R09 우천)
│       │   ├── llm            anthropic.provider · client · 스키마 검증 · 도구 호출 반복(에이전트)
│       │   ├── http-client    연결 3초 · 응답 10초 분리
│       │   ├── budget-guard   예산 80% / 100% 게이트 · provider 별 인스턴스 (8-2)
│       │   └── api-call-log   전 호출 계측
│       │
│       ├── health · root      GET /health — 배포 후 확인 목록 · GET / — 안내
│       └── seed               데모 계정 · 시연 상품 시드 CLI (PM-TA-008)
│
├── apps/web                   Next.js 16 + React 19
└── packages/shared            사유코드 43종 · 등급 · 표준 시드(R10 63행 · 체류시간 · 실내외) · 기획 · 에이전트 응답 타입
```
<callout icon="⚖️" color="blue_bg">
	**판정 엔진이 ****`audit`**** 밑이 아니라 ****`engine`**** 으로 분리돼 있습니다.**
	`audit` 은 조율(큐 · 외부 조회 · 저장)이고 `engine` 은 판정입니다. `engine/rules` 는 `external` 을 의존하지 않으며, 판정에 필요한 데이터는 `AuditRunner`가 미리 모아 `ItineraryContext`로 넘깁니다. 규칙 평가는 **메모리 상에서만** 수행합니다 (NF-PF-014).
	경계를 디렉터리로 그은 이유는 **eslint 가 그 선을 강제할 수 있어서**입니다 — `engine/rules` 안에서 `external/**` 과 `*.repository` import, `Date` 전역, `Date.now`, `Math.random` 이 전부 오류로 막힙니다. 이 경계가 판정 결정론성(NF-MT-001)의 구조적 보장이며, 사람 리뷰가 아니라 린터가 지킵니다.
</callout>
---
# 3. API 공통 규약
## 3-1. 기본 규칙
<table fit-page-width="true" header-row="true">
<tr>
<td>항목</td>
<td>규칙</td>
</tr>
<tr>
<td>Base URL</td>
<td>`/api/v1`</td>
</tr>
<tr>
<td>프로토콜</td>
<td>HTTPS 전용. HTTP는 HTTPS로 리다이렉트 (NF-SC-001)</td>
</tr>
<tr>
<td>Content-Type</td>
<td>`application/json; charset=utf-8` (업로드만 `multipart/form-data`)</td>
</tr>
<tr>
<td>인증</td>
<td>세션 쿠키. `HttpOnly` `Secure` `SameSite=Lax` (NF-SC-002)</td>
</tr>
<tr>
<td>시각 표기</td>
<td>일시는 KST 기준 ISO 8601 (`2026-09-15T14:32:07+09:00`), 날짜는 `YYYY-MM-DD`, 시각은 `HH:mm` (TM-015)</td>
</tr>
<tr>
<td>공사 필드명</td>
<td>응답에 공사 값을 실을 때는 **원본 표기 유지** (`contentid` `modifiedtime` 등, TM-011)</td>
</tr>
<tr>
<td>자체 필드명</td>
<td>영문 표기 대조표 준수 (`product` `finding` `severity` `readinessScore`). JSON 키는 lowerCamelCase</td>
</tr>
<tr>
<td>페이지네이션</td>
<td>`page`(0부터) · `size`(기본 20 · 최대 100) · `sort`. 응답은 `content` `page` `size` `totalElements` `totalPages`. **검수 1건에 딸린 목록은 페이징하지 않습니다** — 5-6 finding 목록은 `content` `totalElements`, 5-7 확인 필요 목록은 `items` `totalCount` 입니다</td>
</tr>
<tr>
<td>멱등성</td>
<td>조회는 멱등. **패치 확정 · 출시 승인 등 상태 변경 요청은 자동 재시도하지 않는다** (EX-CM-008)</td>
</tr>
<tr>
<td>실시간 통신</td>
<td>**SSE · WebSocket 미사용.** 진행 상태는 2초 간격 폴링 (FR-AU-022)</td>
</tr>
<tr>
<td>계약 변경</td>
<td>요청 · 응답에 필드를 더하는 것은 자유. **빼거나 뜻을 바꾸면 이 문서를 먼저 고친다**</td>
</tr>
</table>
## 3-2. 오류 응답 형식
모든 오류는 아래 단일 형식으로 응답합니다.
```json
{
  "reasonCode": "PATCH_CONFLICT",
  "message": "선택한 수정안 중 2건이 같은 일정을 서로 다르게 바꿉니다. 둘 중 하나를 해제한 뒤 확정해 주세요.",
  "unit": "REQUEST",
  "fieldErrors": [
    { "field": "selectedPatches[1]", "message": "findingId 9104와 충돌합니다" }
  ],
  "traceId": "0f9c2a1e7b3d4c58",
  "occurredAt": "2026-09-15T14:32:07+09:00"
}
```
<table fit-page-width="true" header-row="true">
<tr>
<td>필드</td>
<td>설명</td>
</tr>
<tr>
<td>`reasonCode`</td>
<td>사유 코드 43종 중 하나. **화면에 그대로 노출하지 않는다** (G-015 · EX-MS-002)</td>
</tr>
<tr>
<td>`message`</td>
<td>사용자 표시 문구. **무엇이 · 왜 · 다음에 무엇을** 세 요소 포함 (EX-MS-001)</td>
</tr>
<tr>
<td>`unit`</td>
<td>처리 단위 8종 — `FRAGMENT` `CONTENT` `RULE` `ITEM` `PRODUCT` `REQUEST` `BATCH` `SEGMENT` (EX-CM-001)</td>
</tr>
<tr>
<td>`fieldErrors`</td>
<td>입력 검증 실패 상세 (선택)</td>
</tr>
<tr>
<td>`traceId`</td>
<td>서버 로그 상관관계 추적용</td>
</tr>
</table>
<callout icon="🚫" color="red_bg">
	**오류 응답에 스택 트레이스·쿼리문·내부 경로·인증키를 포함하지 않습니다** (NF-SC-009 · EX-CM-006 · PM-SC-003).
	외부 서비스 장애 메시지에는 제공자를 특정하지 않고 "일시적으로 조회할 수 없습니다" 형태로 안내합니다. 단 판정 근거 영역에는 외부 참고 출처를 정상 표기합니다 (EX-MS-003).
</callout>
## 3-3. HTTP 상태 코드 정책
<table fit-page-width="true" header-row="true">
<tr>
<td>상태</td>
<td>사용처</td>
<td>대표 `reasonCode`</td>
</tr>
<tr>
<td>200 OK</td>
<td>조회 · 갱신 성공. **외부 호출 실패로 확인 불가가 생긴 경우도 200**. 에이전트가 일부만 끝냈거나 하나도 못 끝낸 경우도 200 에 `incomplete` 를 채운다(4-11)</td>
<td>–</td>
</tr>
<tr>
<td>201 Created</td>
<td>상품 · 일정 항목 · 리포트 생성. 업로드 · 메모 읽기(`POST /api/v1/uploads/*`)도 저장 없이 201 로 결과를 돌려주며, 파일 · 글 전체 거부도 201 의 `rejected` 로 싣는다(4-3)</td>
<td>`rejected.code` — `UPLOAD_FORMAT_INVALID` `UPLOAD_LIMIT_EXCEEDED` `DAY_COUNT_MISMATCH` `NL_STRUCTURE_FAILED`</td>
</tr>
<tr>
<td>202 Accepted</td>
<td>**검수 요청 · 패치 확정** — 작업 ID 반환 후 비동기 처리</td>
<td>–</td>
</tr>
<tr>
<td>204 No Content</td>
<td>삭제 · 무시 해제</td>
<td>–</td>
</tr>
<tr>
<td>400 Bad Request</td>
<td>입력 형식 오류 · 상한 초과</td>
<td>`UPLOAD_FORMAT_INVALID`(확장자 · 내용 · MIME · 파서 실패) `SETTING_NOT_STRICTER` `DISMISS_REASON_REQUIRED` `INPUT_INVALID`(전용 코드가 없는 입력 형식 오류 · 깨진 JSON 본문)</td>
</tr>
<tr>
<td>401 Unauthorized</td>
<td>미인증 · 세션 만료</td>
<td>`NOT_AUTHENTICATED`</td>
</tr>
<tr color="red_bg">
<td>403 Forbidden</td>
<td>**전면 금지 동작 시도** (차단 무시 · 차단 상태 출시 승인)</td>
<td>`FORBIDDEN_ACTION`</td>
</tr>
<tr color="orange_bg">
<td>404 Not Found</td>
<td>없는 리소스 **및 타 계정 리소스** — 존재 여부를 흘리지 않기 위해 403이 아니라 404</td>
<td>`NOT_FOUND`</td>
</tr>
<tr>
<td>409 Conflict</td>
<td>수정안 충돌 · 스냅샷 불일치 · 되돌리기 불가</td>
<td>`PATCH_CONFLICT` `PATCH_STALE` `UNDO_UNAVAILABLE`</td>
</tr>
<tr>
<td>413 Payload Too Large</td>
<td>업로드 안전망(20MB) 초과 — 받기 전에 막는다. 5MB 에서 20MB 사이는 201 의 `rejected`</td>
<td>`UPLOAD_LIMIT_EXCEEDED`</td>
</tr>
<tr>
<td>422 Unprocessable</td>
<td>선행 조건 미충족</td>
<td>`PLACE_UNRESOLVED` `DAY_COUNT_MISMATCH`</td>
</tr>
<tr>
<td>429 Too Many Requests</td>
<td>호출 빈도 제한 · 같은 에이전트 동시 실행 · 예산 소진</td>
<td>`RATE_LIMIT_EXCEEDED` `BUDGET_EXHAUSTED` `KTO_QUOTA_EXCEEDED`</td>
</tr>
<tr>
<td>500 Internal</td>
<td>분류되지 않은 서버 오류. **최후 수단**</td>
<td>`INTERNAL_ERROR`</td>
</tr>
<tr>
<td>503 Service Unavailable</td>
<td>`/health` 실패 상태</td>
<td>–</td>
</tr>
</table>
<callout icon="🔍" color="orange_bg">
	**타 계정 리소스에 404를 쓰는 이유** — 403은 "그 ID의 리소스가 존재한다"는 정보를 흘립니다. 식별자 추측만으로 타 계정 데이터의 존재 여부를 알아낼 수 없어야 합니다 (PM-DA-003·004 · EX-SY-003. 근거는 S등급이나 예외처리 문서에서 **M으로 상향 확정**).
</callout>
## 3-4. 호출 빈도 제한
<table fit-page-width="true" header-row="true">
<tr>
<td>대상</td>
<td>제한</td>
<td>근거</td>
</tr>
<tr>
<td>검수 실행 요청</td>
<td>계정당 분당 5회 — 다시 검수(`audit-jobs`)와 검수 시작(`handoff`)을 한 창으로 센다. **공개된 테스트 계정은 세지 않는다**(심사위원 여럿이 한 계정으로 같은 가이드를 따라가 남의 클릭으로 막힌다 — 로그인 시도와 같은 기준). 배치가 거는 재검수는 세지 않는다. 창은 프로세스 메모리에 둔다(API 인스턴스 1개 전제)</td>
<td>NF-SC-010 · EX-SY-008</td>
</tr>
<tr>
<td>로그인 시도</td>
<td>계정 단위 — 한 계정에 10분 동안 10번 틀리면 그 창이 끝날 때까지 맞는 비밀번호여도 429 · `Retry-After`. **공개된 테스트 계정은 세지 않는다**(비밀번호가 공개돼 대입할 이유가 없고, 잠그면 같이 쓰는 심사위원 전원이 막힌다). IP 는 쓰지 않는다 — 화면이 API 공개 주소로 넘겨 모든 사용자가 같은 IP 로 보인다. 공개된 테스트 계정은 로그인에 성공할 때마다 그 계정 알림의 확인 처리(`read_at`)를 되돌린다 — 무시한 알림은 그대로 둔다(UI-CM-008 · #840)</td>
<td>NF-SC-010</td>
</tr>
<tr>
<td>리포트 생성</td>
<td>계정당 분당 5회. 공개된 테스트 계정은 세지 않는다</td>
<td>NF-SC-010</td>
</tr>
<tr>
<td>장소 담기 · 장소 정보 한 줄 조회 (`/plan/*` · `place-facts`)</td>
<td>분당 상한을 두지 않는다 — 종류 칩 · 카드 펼침 · 줄마다 부르므로 짧은 시간에 수십 번이 정상이고, 공사 호출은 예산 게이트가 막는다. 예산 100% 에서 검수와 같은 게이트 — 429 `BUDGET_EXHAUSTED`</td>
<td>NF-SC-010 · FR-PL-018</td>
</tr>
<tr>
<td>에이전트 실행 (`place-suggestions` · `check-questions` · `radar/today`)</td>
<td>계정당 같은 에이전트 분당 5회 · **같은 에이전트는 계정당 동시 1회** — 도는 중에 온 요청은 새로 돌리지 않고 429 `RATE_LIMIT_EXCEEDED`(끝나는 시각을 몰라 `Retry-After` 없음). 예산 100% 에서 검수와 같은 게이트 — 429 `BUDGET_EXHAUSTED`</td>
<td>NF-SC-010 · FR-AG-002</td>
</tr>
<tr>
<td>진행 상태 폴링</td>
<td>제한 없음 (2초 간격 전제, p95 300ms 목표)</td>
<td>NF-PF-003</td>
</tr>
</table>
상한을 넘은 요청은 429 `RATE_LIMIT_EXCEEDED` 로 거절하고 `Retry-After`(초)를 붙인다. 상태는 바뀌지 않는다 (EX-SY-008 · EX-AG-004).
---
# 4. 엔드포인트 전체 목록
## 4-1. 인증 · 계정
<table fit-page-width="true" header-row="true">
<tr>
<td>Method</td>
<td>Path</td>
<td>설명</td>
<td>요구사항</td>
</tr>
<tr>
<td>POST</td>
<td>`/api/v1/auth/signup-code`</td>
<td>공개 인증코드 요청. email → verificationId · expiresAt · resendAfterSeconds. 계정·세션 미생성. 발송 한도 초과 429 및 Retry-After, 발송 실패·미설정 503.</td>
<td>FR-CM-001 · PM-AC-008 · EI-MA</td>
</tr>
<tr>
<td>POST</td>
<td>`/api/v1/auth/signup`</td>
<td>회원가입. email · password · verificationId · code 필수. 이메일에 연결된 미만료 인증코드를 확인하고 같은 트랜잭션에서 코드 소비·계정·기본 설정 생성. 중복은 상세 사유 없이 거부. 성공 시 기존 세션 쿠키 발급.</td>
<td>FR-CM-001 · EX-SY-007</td>
</tr>
<tr>
<td>POST</td>
<td>`/api/v1/auth/login`</td>
<td>로그인. **아이디 없음과 비밀번호 불일치를 구분하지 않고 동일 메시지**</td>
<td>FR-CM-002 · EX-SY-004</td>
</tr>
<tr>
<td>POST</td>
<td>`/api/v1/auth/logout`</td>
<td>로그아웃 · 세션 무효화</td>
<td>FR-CM-002</td>
</tr>
<tr>
<td>GET</td>
<td>`/api/v1/auth/me`</td>
<td>현재 계정 정보 (이메일 · 데모 계정 여부)</td>
<td>PM-AC-004</td>
</tr>
</table>
## 4-2. 상품 (F01 · FR-CM)
<table fit-page-width="true" header-row="true">
<tr>
<td>Method</td>
<td>Path</td>
<td>설명</td>
<td>요구사항</td>
</tr>
<tr>
<td>GET</td>
<td>`/api/v1/products`</td>
<td>상품 목록. 홈(내 상품) 보드용 — 출시 준비도 · 등급별 건수 · 알림 수 포함. 행마다 `plannedAt` · `releasedAt` 으로 칸(기획 중 · 검수 중 · 출시할 수 있음 · 출시함)을 나눈다. 알림 수는 셋이다 — `unreadNotifications`(확인하지 않은 알림) · `activeNotifications`(무시하지 않은 알림) · `risksSinceAudit`(알림 뒤에 다시 검수하지 않은 바뀐 정보, 목록의 `latestAudit.executedAt` 과 견준다). 무시한 알림은 세지 않고 여행이 끝난 상품은 셋 다 0 이다(FR-MO-018). `startedBy` 는 기획을 시작한 방법(`plan_origin.startedBy` — MANUAL · UPLOAD · TEXT · SIGNAL)이고 기록이 없는 상품은 `null` 이다 — 보드의 기획 중 카드가 쓴다(UI-S1-010)</td>
<td>FR-CM-005 · FR-PL-001</td>
</tr>
<tr>
<td>POST</td>
<td>`/api/v1/products`</td>
<td>상품 생성 (기본정보 + 상품 성격 + 이동수단). 만든 상품은 **기획 중**(`plannedAt: null`)이다. 본문에 기획 출처 `planOrigin` — 시작 방식 · 신호 종류 · 지역 코드 · 기간 · contentid 만, 원문 없음. 관광지를 고른 줄(`content`)은 장소명을 저장하지 않는다 — 비워도 되고 보내도 버리며 표시할 때 찾는다(DR-PR-001 · DR-IN-013)</td>
<td>FR-CM-006 · FR-IN-004·007·008 · FR-PL-001 · 020</td>
</tr>
<tr>
<td>GET</td>
<td>`/api/v1/products/{productId}`</td>
<td>상품 상세 + 일정 전체 + 최신 검수 요약 + `plannedAt` · `planOrigin` · `composition`(항목 출처별 건수)</td>
<td>FR-CM-006 · FR-PL-020</td>
</tr>
<tr>
<td>PATCH</td>
<td>`/api/v1/products/{productId}`</td>
<td>상품 기본정보 수정. `startDate` 변경 = **출발일 옮기기 — 일정 항목의 시각은 바꾸지 않는다**</td>
<td>FR-CM-006 · FR-PL-014 · PM-NG-011</td>
</tr>
<tr>
<td>DELETE</td>
<td>`/api/v1/products/{productId}`</td>
<td>상품 삭제 (종속 데이터 연쇄 삭제). 확인 단계 필수</td>
<td>FR-CM-006 · DR-LC-002 · EX-MS-006</td>
</tr>
<tr>
<td>POST</td>
<td>`/api/v1/products/{productId}/handoff`</td>
<td>**검수 시작.** `planned_at` 기록 · 첫 검수 요청. 본문 `{excludePending?}` — true 면 남은 PENDING 을 EXCLUDED 로 두고 넘긴다(검수 시작 창의 "이대로 검수 시작"), 아니면 PENDING 이 남았을 때 422 `PLACE_UNRESOLVED` 와 `pendingCount`</td>
<td>FR-PL-001 · EX-AU-001</td>
</tr>
<tr color="red_bg">
<td>POST</td>
<td>`/api/v1/products/{productId}/release`</td>
<td>**출시 승인. 지금 일정의 검수 결과(아래 「현재 결과」)에 차단이 1건 이상이면 403 ****`FORBIDDEN_ACTION`****으로 거부.** 수정안 반영 뒤 재검수 전이거나, 되돌린 일정은 깨끗해도 가장 최근 실행(트리거 기준)에 차단이 있으면 다시 검수하도록 403</td>
<td>PM-NG-002 · EX-AU-008 · DR-IN-007</td>
</tr>
</table>
**요청 · 응답 모양**
```json
POST /api/v1/products                추가 "planOrigin": { "startedBy": "MANUAL|UPLOAD|TEXT|CLONE|SIGNAL", "signal"?: { "type": "T2", "regnCd", "signguCd", "from", "to", "contentId"? } }
                                     days[].items[] 마다 "origin": "MANUAL|UPLOAD|TEXT|PICKER" (없거나 다른 값이면 MANUAL · PICKER 줄은 matched_by 를 비운다 · FR-PL-020), "excluded"?: true (직접 정한 곳 EXCLUDED · content 가 있으면 무시 · UI-S2-021) | { "walkId" } (걷기 길 — place 는 비워도 되고 보내도 저장하지 않는다 · UI-S2-048 · DR-MD-005)
POST /api/v1/products/{id}/handoff   본문 { "excludePending"?: true }  → 202 { "productId", "plannedAt", "jobId", "excludedCount" } | 422 PLACE_UNRESOLVED { "pendingCount": 2 } | 429 BUDGET_EXHAUSTED · RATE_LIMIT_EXCEEDED(3-4)   (true 면 남은 PENDING 을 EXCLUDED 로 바꾸고 넘긴다 · 한 트랜잭션. 검수 요청이 거절되면 아무것도 바뀌지 않고 상품은 기획 중에 남는다)
PATCH /api/v1/products/{id}          "startDate" 변경 = 출발일 옮기기. 항목 시각은 바꾸지 않는다
GET /api/v1/products/{id}            추가 "plannedAt", "planOrigin", "composition": { "manual": 5, "picker": 2, "excluded": 1 }
                                     days[].items[] 마다 "lcls2", "endTimeSource": "INPUT|DWELL_DEFAULT|DWELL_FALLBACK" (끝 시간 미리보기 · 「기본값 적용」 표시용, 판정에 쓰지 않는다 · FR-IN-011), "walkId" (걷기 길 식별자 · 아니면 null. 편집 화면이 고칠 수 없는 걷기 길 줄로 연다 · UI-S2-048), "contentTypeId" (고른 곳의 유형 코드 · 아니면 null. 편집 화면이 저장된 고른 곳을 ✓ 로 열고 다시 찾지 않는다 · UI-S2-025)
GET /api/v1/products                 행마다 추가 "plannedAt", "releasedAt" (보드 분류용 — 차단 건수 · 안 읽은 알림은 기존 `latestAudit.counts.blocker` · `unreadNotifications` 를 쓴다)
```
## 4-3. 일정 항목 (F01)
<table fit-page-width="true" header-row="true">
<tr>
<td>Method</td>
<td>Path</td>
<td>설명</td>
<td>요구사항</td>
</tr>
<tr>
<td>GET</td>
<td>`/api/v1/products/{productId}/items`</td>
<td>일정 항목 목록 (일차 · 순번 정렬)</td>
<td>FR-IN-009</td>
</tr>
<tr>
<td>POST</td>
<td>`/api/v1/products/{productId}/items`</td>
<td>일정 항목 추가. 본문 확장 — `afterItemId`(넣을 위치, 없으면 맨 뒤) · `content{contentId, contentTypeId, lcls1, lcls2, lcls3, mapx, mapy}` 면 CONFIRMED · `excluded{walkId}` 면 EXCLUDED(걷기 길 · 직접 정한 곳, 코스 이름은 보내지 않는다) · `origin`(`MANUAL` · `UPLOAD` · `TEXT` · `PICKER`, 없으면 `MANUAL` · FR-PL-020) · `excluded: true` 면 장소명을 둔 채 EXCLUDED(직접 정한 곳 · UI-S2-021). 걷기 길(`excluded{walkId}`)과 고른 곳(`content{…}`)은 `startTime` · `endTime` 을 주면 그 시각으로 넣는다(편집 화면 · UI-S2-048 · FR-IN-014 — 끝을 비우면 기본 체류시간 보완 대상) — 없으면 아래처럼 채운다. **시각 자동 채움** — 시작 = 앞 항목 종료 + 이동시간, 잴 수 없으면 앞 항목 종료 시각 그대로. 기존 항목의 시각은 바꾸지 않는다. 식당 · 카페 · 숙소는 식사 · 휴식 · 숙박 유형(숙박은 끝 비움). 상품에 항목이 45건이면 어느 본문이든 400 `INPUT_INVALID` 로 거부한다(상품 저장 · 넣는 수정안 확정도 같다)</td>
<td>FR-IN-014 · FR-PL-013 · PM-NG-011 · NF-CP-010</td>
</tr>
<tr>
<td>PATCH</td>
<td>`/api/v1/items/{itemId}`</td>
<td>시간 · 장소명 · 유형 수정</td>
<td>FR-IN-014</td>
</tr>
<tr>
<td>DELETE</td>
<td>`/api/v1/items/{itemId}`</td>
<td>일정 항목 삭제</td>
<td>FR-IN-014</td>
</tr>
<tr>
<td>PUT</td>
<td>`/api/v1/products/{productId}/items/order`</td>
<td>순서 일괄 변경 (드래그 결과 저장)</td>
<td>FR-IN-014</td>
</tr>
<tr>
<td>POST</td>
<td>`/api/v1/uploads/schedule`</td>
<td>엑셀 · CSV 파일(multipart `file`)을 읽어 **편집용 결과**(`nights` · `items` · `errors` · `rejected`)를 201 로 돌려준다. 저장하지 않는다 — 화면이 편집한 뒤 상품 저장(`POST /api/v1/products` 의 `days[].items[]`)으로 저장한다. 상품에 딸리지 않는 경로라 등록 전에도 부른다</td>
<td>FR-IN-002·015</td>
</tr>
<tr>
<td>POST</td>
<td>`/api/v1/uploads/schedule-text`</td>
<td>메모(자연어) `{ text }` → LLM 구조화 → 같은 모양의 **편집용 결과**를 201 로 돌려준다. 저장하지 않는다</td>
<td>FR-IN-003·013</td>
</tr>
<tr>
<td>GET</td>
<td>`/api/v1/uploads/template`</td>
<td>지정 양식 파일(.xlsx) 내려받기</td>
<td>FR-IN-002</td>
</tr>
</table>
**요청 · 응답 모양**
```json
POST /api/v1/products/{id}/items     기존 { dayNo, start, end, place, itemType } 에 더해
  { "dayNo": 1, "afterItemId": 17 | null, "itemType": "SIGHT", "origin": "PICKER",
    "placeLabel": null,
    "content": { "contentId": "125769", "contentTypeId": 12, "lcls1": "VE", "lcls2": "VE01", "lcls3": "VE0101", "mapx": 128.89, "mapy": 37.79 } }
  → CONFIRMED 항목. start = 앞 항목 end + 이동시간(잴 수 있으면, 카카오 1콜) 아니면 앞 항목 end, end = start + 표준 체류시간(DWELL_MINUTES_SEED). 식당 · 카페 · 숙소는 itemType MEAL · REST · LODGING(숙박은 end 비움)
  { "dayNo": 1, "afterItemId": 17, "itemType": "SIGHT", "origin": "PICKER", "excluded": { "walkId": "…" } }
  → EXCLUDED 항목 (걷기 길 · 직접 정한 곳). place_label 은 비우고 walk_id 만 저장한다 — 코스 이름은 보내지도 저장하지도 않는다 (DR-MD-005). 이름은 표시할 때 찾는다 (5-12 콜아웃)
```
<callout icon="📥" color="yellow_bg">
	**업로드 상한과 거부 규칙**
	업로드 · 메모 붙여넣기는 저장하지 않고 편집용 결과를 201 로 돌려준다. **파일 · 글 전체를 거부할 때도 201 이고** 사유는 결과의 `rejected`(`code` · `message`)에 담는다 — 화면은 `message` 만 보인다
	파일 5MB · 500행 초과 → 파싱 전에 `rejected` `UPLOAD_LIMIT_EXCEEDED`
	유효 일정 항목 45건 초과 → `rejected` `UPLOAD_LIMIT_EXCEEDED` + 상품 분할 안내 (NF-CP-003)
	자연어 입력 4,000자 초과 → `rejected` `UPLOAD_LIMIT_EXCEEDED` (화면은 글자 수를 보이고 넘으면 보내지 않는다 · NF-CP-006)
	양식 헤더를 못 찾음 · 필수 컬럼 누락 → `rejected` `UPLOAD_FORMAT_INVALID` (없는 컬럼을 짚는다)
	일부 행 형식 오류 → **201 + 정상 행 유지 + 실패 행 번호 · 사유 반환**(`errors[]` · 사유코드는 싣지 않는다 · 전체 거부 아님)
	박수와 일자별 일정 수 불일치 → 업로드 · 저장은 막지 않는다. 검수 시작이 422 `DAY_COUNT_MISMATCH` 로 거부한다 (EX-IN-005). 파일에 4일차 이상이 있으면 `rejected` `DAY_COUNT_MISMATCH` 로 파일 전체를 거부한다
	메모에서 항목을 하나도 못 만듦 · LLM 을 쓸 수 없음 · 빈 글 → `rejected` `NL_STRUCTURE_FAILED`
	확장자가 .xlsx · .csv 가 아님 · 내용이 형식과 다름(xlsx 는 `PK` 로 시작, CSV 는 NUL 없는 글자) · MIME 이 이미지 · PDF 처럼 명백히 다름 · 파서가 못 읽음 → 400 `UPLOAD_FORMAT_INVALID`
	파일이 없음 · 메모 본문 `text` 가 문자열이 아님 → 400 `INPUT_INVALID`
	20MB 초과(업로드 안전망) → 413 `UPLOAD_LIMIT_EXCEEDED`
	업로드 파일은 파싱 후 폐기하며 서버에 영구 저장하지 않습니다 (NF-SC-006).
</callout>
## 4-4. 관광지 매칭 · 공사 코드 프록시 (F02)
<table fit-page-width="true" header-row="true">
<tr>
<td>Method</td>
<td>Path</td>
<td>설명</td>
<td>요구사항</td>
</tr>
<tr>
<td>GET</td>
<td>`/api/v1/contents/search`</td>
<td>장소명으로 공사 키워드 검색 프록시. 파라미터 `keyword` `regnCd` `signguCd` `page` `size`. 호출처는 화면 2 편집기 행(장소 칸 자동완성)</td>
<td>FR-IN-020 · PM-SC-002 · FR-PL-004</td>
</tr>
<tr>
<td>POST</td>
<td>`/api/v1/items/{itemId}/match`</td>
<td>`contentid` 확정. 확정 시점의 실시간 정보를 함께 반환. 호출처는 화면 2 편집기 행(자동완성) · 기획 에이전트 카드. 본문에 `matchedBy`(`USER` · `AGENT`) — 1곳 자동 확정은 서버가 `AUTO` 로 남긴다</td>
<td>FR-IN-027·028 · FR-AG-012</td>
</tr>
<tr>
<td>POST</td>
<td>`/api/v1/items/{itemId}/exclude`</td>
<td>"직접 정한 곳으로 두기"(옛 "해당 없음") 처리. 항목은 유지하고 `EXCLUDED`로 전환. 호출처는 화면 2 편집기 행 · 기획 에이전트 카드. 본문 `{placeLabel?}` — 이름을 저장하지 않은 고른 곳(장소 담기 · 등록 화면에서 고른 줄)은 이 이름(사용자가 친 글)으로 직접 정한 곳이 되고, 없으면 400 `INPUT_INVALID` 다. 이름이 있는 줄은 그 이름을 그대로 둔다(DR-PR-001 · DR-IN-013)</td>
<td>FR-IN-024·025 · FR-AG-012</td>
</tr>
<tr>
<td>GET</td>
<td>`/api/v1/contents/{contentId}`</td>
<td>관광지 상세 실시간 조회. **DB에서 읽지 않는다**. `with=accessible,pet` 을 주면 요청한 조건 축(무장애 · 반려동물)을 각 1콜로 붙인다 — 서비스를 못 부르면 그 필드만 `null`. `cpyrhtDivCd`(`Type1` · `Type3` · 없으면 `null`)를 실어 화면이 Type3 공사 원문 배지에 "변경금지"를 붙인다 (FR-CM-011)</td>
<td>DR-PR-004 · FR-IN-030 · FR-PL-012</td>
</tr>
<tr>
<td>GET</td>
<td>`/api/v1/ldong-codes`</td>
<td>법정동 코드. 파라미터 없으면 시도 목록, `regnCd` 주면 시군구 목록</td>
<td>FR-IN-005·006</td>
</tr>
<tr>
<td>GET</td>
<td>`/api/v1/lcls-codes`</td>
<td>분류체계 대분류 목록. 파라미터 없음 — 부팅 때(실패하면 첫 요청 때) `lclsSystmCode2` 를 불러 메모리에 둔 것으로 응답한다. 중분류 기준표는 `packages/shared` 상수(`LCLS_SYSTM2`)이고 이 경로로 내보내지 않는다</td>
<td>EI-KT-015</td>
</tr>
</table>
**요청 · 응답 모양**
```json
POST /api/v1/items/{itemId}/match     기존 본문에 "matchedBy": "USER" | "AGENT"  (1곳 자동 확정은 서버가 AUTO 로 남긴다)
```
<callout icon="📍" color="blue_bg">
	**`/contents/search`****는 지역을 받으면 그 지역 안에서만 찾습니다.** 지역은 `regnCd` · `signguCd` 로 받고, 응답의 `regionFilterApplied` 는 지역을 줬는지를 알립니다. 화면은 결과 건수와 무관하게 늘 상품 지역을 붙여 부르고 해제 수단을 두지 않으며, 적용 중인 지역을 후보 목록 머리("강릉시에서 찾은 곳 N곳")에 적습니다 (FR-IN-023 · EX-MC-003).
	검색 호출 자체가 실패하면 항목을 `PENDING`으로 두고 재시도 수단을 제공합니다. **검수 제외로 자동 전환하지 않습니다** (EX-MC-004).
</callout>
## 4-5. 검수 (F04 ~ F07)
<table fit-page-width="true" header-row="true">
<tr>
<td>Method</td>
<td>Path</td>
<td>설명</td>
<td>요구사항</td>
</tr>
<tr color="orange_bg">
<td>POST</td>
<td>`/api/v1/products/{productId}/audit-jobs`</td>
<td>**검수 실행 요청. 202 + 작업 ID 즉시 반환** (p95 500ms). 본문에 `triggerType`</td>
<td>FR-AU-021 · NF-PF-002</td>
</tr>
<tr>
<td>GET</td>
<td>`/api/v1/audit-availability`</td>
<td>지금 검수를 시작할 수 있는지 — `{ "available", "reasonCode", "resumesAt" }`. 검수 요청과 같은 예산 문(`USER_AUDIT`)을 소모 없이 본다. 다 썼으면 `available: false` · `BUDGET_EXHAUSTED` · 다시 열리는 때(한국 시간 다음 날 0시). 호출 수 · 소진율은 주지 않는다(#532)</td>
<td>UI-ST-007 · EX-QT-002 · FR-OP-004</td>
</tr>
<tr color="orange_bg">
<td>GET</td>
<td>`/api/v1/audit-jobs/{jobId}`</td>
<td>**진행 상태 폴링 (2초 간격).** 상태 · 진행률 · 완료 시 `auditRunId`</td>
<td>FR-AU-022·023 · NF-PF-003</td>
</tr>
<tr>
<td>GET</td>
<td>`/api/v1/audit-runs/{runId}`</td>
<td>검수 결과 요약 — 등급별 건수 · 출시 준비도 · 총 감점 · 검수 근거 · 적용 기준(`settingSnapshot`)</td>
<td>FR-AU-040~050·065 · FR-OP-023</td>
</tr>
<tr>
<td>GET</td>
<td>`/api/v1/audit-runs/{runId}/findings`</td>
<td>finding 목록. 파라미터 `severity` `ruleCode` `dismissed` `sort`</td>
<td>FR-AU-060·066·067</td>
</tr>
<tr>
<td>GET</td>
<td>`/api/v1/audit-runs/{runId}/unverified`</td>
<td>확인 필요 목록 — 관광지명 · 사유 · 공사 원문 · 문의처 · 홈페이지 · 일정 위치</td>
<td>FR-AU-080·081</td>
</tr>
<tr>
<td>POST</td>
<td>`/api/v1/findings/{findingId}/dismiss`</td>
<td>무시 처리. 본문 `{reason}` 필수(200자 이내) — 없으면 400 `DISMISS_REASON_REQUIRED`. **`severity = BLOCKER`****이면 403 ****`FORBIDDEN_ACTION`**</td>
<td>PM-NG-001 · EX-AU-009 · FR-AU-068 · EX-AU-012</td>
</tr>
<tr>
<td>DELETE</td>
<td>`/api/v1/findings/{findingId}/dismiss`</td>
<td>무시 해제</td>
<td>FR-AU-069</td>
</tr>
<tr>
<td>POST</td>
<td>`/api/v1/findings/{findingId}/confirm`</td>
<td>확인 필요 항목 "확인했어요" 체크. **확인 결과 값은 받지도 저장하지도 않는다**</td>
<td>FR-AU-083·084 · PM-NG-006</td>
</tr>
<tr>
<td>GET</td>
<td>`/api/v1/rules`</td>
<td>**규칙 목록 — 10개 코드 · 명칭 · 기본 등급 · 버전 · 외부 데이터 필요 여부** · 쓰는 데이터 · 기준값 · 문장 예시 · 회사 기준 여부 (검수 기준 탭의 규칙 설명, 5-10)</td>
<td>FR-RU 6장 공통 AC · FR-OP-025</td>
</tr>
<tr>
<td>GET</td>
<td>`/api/v1/products/{productId}/audit-runs`</td>
<td>검수 실행 이력 목록 (전후 비교 선택용). 실행마다 `isCurrent` — 지금 일정의 결과이면 true. 결과 화면은 이 실행부터 연다. `activeJobId` — 지금 도는 검수 작업 번호(없거나 기한을 넘겨 멈춘 작업이면 `null`). 결과 화면이 다시 열려도 이 작업을 이어 폴링한다 (UI-ST-003)</td>
<td>FR-PA-045</td>
</tr>
</table>
**요청 · 응답 모양**
```json
POST /api/v1/findings/{id}/dismiss   본문 { "reason": "고객 요청 사항" }  (필수 · 200자 이내)
  400 DISMISS_REASON_REQUIRED
GET /api/v1/audit-runs/{runId}       추가 "settingSnapshot": { "standardVersion": "2026.09", "r07SpanHours": 6, "r07MealMinutes": 90 }
R07 finding.message 예: "12:00 점심 60분은 회사 기준 90분보다 짧습니다. TourLint 표준 60분은 충족합니다."
리포트 머리글: "적용 기준 TourLint 표준 2026.09 · 회사 기준 1건(식사 90분) · 무시 1건 — 고객 요청 사항"
```
<callout icon="🚫" color="red_bg">
	**존재해서는 안 되는 엔드포인트**
	`PATCH /audit-runs/{runId}` · `DELETE /audit-runs/{runId}` · `PATCH /findings/{id}` (판정 내용 수정)
	과거 검수 실행 결과는 불변 기록이므로 **수정 요청 경로 자체가 존재하지 않아야 합니다** (PM-NG-004 · EX-AU-010). DB 트리거로도 이중 차단합니다.
</callout>
## 4-6. 패치 (F08 ~ F10)
<table fit-page-width="true" header-row="true">
<tr>
<td>Method</td>
<td>Path</td>
<td>설명</td>
<td>요구사항</td>
</tr>
<tr>
<td>POST</td>
<td>`/api/v1/products/{productId}/patch-preview`</td>
<td>선택한 수정안 통합 검토. **일정을 바꾸지 않고** 전후 대조 + 충돌 검사 결과 반환</td>
<td>FR-PA-004·005·007</td>
</tr>
<tr color="orange_bg">
<td>POST</td>
<td>`/api/v1/products/{productId}/patch-applications`</td>
<td>**패치 확정. 일괄 반영 후 전 규칙 재검수 1회를 자동 실행하고 202 + 작업 ID 반환**</td>
<td>FR-PA-020·022·025</td>
</tr>
<tr>
<td>GET</td>
<td>`/api/v1/patch-applications/{id}`</td>
<td>패치 적용 이력 상세</td>
<td>FR-PA-028</td>
</tr>
<tr>
<td>POST</td>
<td>`/api/v1/patch-applications/{id}/revert`</td>
<td>되돌리기. **직전 1건이 아니면 409 ****`UNDO_UNAVAILABLE`**</td>
<td>FR-PA-026 · EX-PA-006</td>
</tr>
<tr>
<td>GET</td>
<td>`/api/v1/products/{productId}/comparison`</td>
<td>전후 비교. `patchApplicationId` 생략 시 직전 패치 한 쌍</td>
<td>FR-PA-040·045</td>
</tr>
</table>
<callout icon="⚠️" color="orange_bg">
	**패치 확정 거부 조건** (2026.08.23 · F09 구현에서 ③~⑤ 추가)
	① `PATCH_CONFLICT` (409) — 선택한 수정안 사이에 충돌이 있으면 확정을 차단하고 **어느 두 수정안이 충돌하는지 지목**합니다. 시스템이 자동으로 하나를 해제하지 않습니다 (FR-PA-006).
	② `PATCH_STALE` (409) — 미리보기 이후 일정이 다른 경로로 변경되었으면 거부하고 재검토를 유도합니다. 오래된 스냅샷 기준 덮어쓰기를 막습니다 (EX-PA-002).
	③ `PATCH_STALE` (409) — 선택한 수정안의 **대상 일정이 사라졌으면** 통째로 거부합니다. 미리보기는 못 넣은 것을 알려 주기만 하면 되지만, 확정에서 나머지만 반영하면 사용자가 고르지 않은 조합이 일정이 됩니다.
	④ `PATCH_STALE` (409) — **검수가 진행 중이면** 받지 않습니다. `uq_job_active` 때문에 이때 만든 재검수 요청은 진행 중인 작업을 그대로 돌려받는데, 그 작업은 **패치 전 일정**을 보고 있어 바뀐 일정의 재검수가 영영 돌지 않습니다. 사유코드 41종에 "진행 중"이 없어 확정의 전제가 흔들린 경우로 묶습니다.
	⑤ `BUDGET_EXHAUSTED` (429) — 재검수에 쓸 호출 예산이 없으면 **쓰기 전에** 거부합니다. 다 쓴 뒤 재검수를 못 돌리면 검수 결과 없는 일정만 남습니다.
	반영은 **단일 트랜잭션**이며 도중 실패 시 전체 원상 복구합니다. 부분 반영 상태를 허용하지 않습니다 (EX-PA-003).
</callout>
## 4-7. 리포트 (F11)
<table fit-page-width="true" header-row="true">
<tr>
<td>Method</td>
<td>Path</td>
<td>설명</td>
<td>요구사항</td>
</tr>
<tr>
<td>POST</td>
<td>`/api/v1/audit-runs/{runId}/reports`</td>
<td>PDF 리포트 생성 (서버 사이드 렌더링). 201 + `reportId`. **지금 일정의 검수 실행만**(보통 가장 최근 실행, 되돌렸으면 반영 전 실행) 대상이며 아니면 409 `REPORT_FAILED`. 머리글에 적용 기준(`settingSnapshot` 의 표준 버전 · 회사 기준)과 무시 항목 · 사유를 찍는다</td>
<td>FR-PA-060·064·066</td>
</tr>
<tr>
<td>GET</td>
<td>`/api/v1/reports/{reportId}/download`</td>
<td>PDF 다운로드. **인증 필수. 공개 링크를 발급하지 않는다**</td>
<td>PM-DA-007</td>
</tr>
</table>
<callout icon="🗂" color="orange_bg">
	**`reportId`**** 는 테이블 행이 아닙니다** (2026.08.29 · F11 구현)
	DB 명세서 6-4 가 PDF 를 서버에 남기지 못하게 하고 `report` 테이블은 물리 테이블 20종에 없습니다. `POST` 가 렌더까지 끝내고 결과를 **프로세스 메모리에 5분** 들고 있으며 `reportId` 는 그 보관 키입니다. `GET .../download` 는 그것을 스트리밍하고, 수명이 지났거나 소유자가 아니면 404 입니다 (존재 여부 비노출).
	두 단계를 합치지 않은 이유는 PM-DA-007 의 인수조건이 "리포트 다운로드 URL 을 로그아웃 상태에서 열면" 이라 열어 볼 URL 이 있어야 하기 때문입니다. 매번 재생성하지 않는 이유는 공사 재조회가 다운로드마다 나가기 때문입니다.
	⚠️ 인스턴스를 늘리면 만든 곳과 받는 곳이 갈려 깨집니다. 다중화 시 이 절을 다시 봅니다.
</callout>
<callout icon="📄" color="gray_bg">
	**지금 일정의 검수 실행만 리포트로 만듭니다** (2026.08.29 · F11 구현, 2026.09.20 #551 보강)
	`audit_run` 에는 일정 스냅샷이 없어 일정표(FR-PA-061 ③)와 검수 제외 항목 건수(FR-PA-064)는 조회 시점의 `itinerary_item` 을 읽어야 나옵니다. 과거 실행으로 리포트를 만들면 **그때의 판정과 지금의 일정**이 한 문서에 섞입니다. 수정안을 되돌리면 가장 최근 실행(반영 후)이 오히려 지금 일정과 다르므로, 기준은 가장 최근 실행이 아니라 아래 「현재 결과」입니다.
	거절은 409 `REPORT_FAILED` 이며 다시 검수한 뒤 내려받도록 안내합니다. 사유코드 43종에 "최신이 아님" 이 없어 재시도 유도가 붙은 리포트 생성 거절(EX-AU-011)로 묶었습니다.
</callout>
## 4-8. 수요·변경 레이더 (F12 ~ F14)
<table fit-page-width="true" header-row="true">
<tr>
<td>Method</td>
<td>Path</td>
<td>설명</td>
<td>요구사항</td>
</tr>
<tr>
<td>GET</td>
<td>`/api/v1/radar/summary`</td>
<td>레이더 요약 — 변경 콘텐츠 건수 · T1 · T2 · 영향 상품 수 · 마지막 배치 상태 · `lastBatchAt` · `nextBatchAt`(다음 배치 시각 — 평일 `batch_time`, 배치가 꺼져 있으면 `null`)</td>
<td>FR-MO-050 · NF-OB-004</td>
</tr>
<tr>
<td>GET</td>
<td>`/api/v1/radar/changes`</td>
<td>변경 감지 내역. 지문 비교값(변경 전 → 후)과 판독 결과 변화 포함</td>
<td>FR-MO-006·058</td>
</tr>
<tr>
<td>GET</td>
<td>`/api/v1/radar/signals`</td>
<td>수요 신호 T1 · T2. **`productId`**** 필수** — T2 조회 창이 그 상품의 여행일에서 나옵니다. `t1.keywordHits` 는 요청 계정의 관심 키워드와 이름이 맞는 곳의 `{keyword, contentIds}` 이며, 이름은 화면이 `GET /contents/{id}` 로 그때 조회합니다. 맞는 곳이 없으면 빈 배열, 배치가 아직 보지 않은 키워드(등록한 뒤 첫 배치 전)는 `contentIds: null` 입니다. T1 건수는 키워드로 거르지 않습니다</td>
<td>FR-RU-110~122 · FR-MO-053</td>
</tr>
<tr>
<td>GET</td>
<td>`/api/v1/radar/signals/detail`</td>
<td>수요 신호가 가리키는 곳 (`productId` · `type=T1|T2`). 세는 조회를 한 번 더 불러 이름 · 날짜를 표시용으로만 돌려준다 — 저장하지 않는다. 조회량이 찼거나 조회가 실패하면 `items` 가 비고 `unavailable` 에 이유가 온다</td>
<td>FR-RU-121 · UI-S7-006</td>
</tr>
<tr>
<td>GET</td>
<td>`/api/v1/radar/region-signals/detail`</td>
<td>관심 지역 카드의 건수가 가리키는 곳 (`regnCd` · `signguCd?` · `month` · `type=T1|T2`). **요청 계정의 관심 지역만** 답한다 — 아니면 404 `NOT_FOUND`. 이름은 표시용으로만 돌려주고 저장하지 않는다</td>
<td>FR-MO-060 · UI-S7-015</td>
</tr>
<tr>
<td>GET</td>
<td>`/api/v1/radar/region-signals`</td>
<td>관심 지역 새 소식 — 계정이 등록한 관심 지역(시군구 + 달)마다 `t1`(가장 최근 30일) · `t2`(그 달) · `t3`. `t1` · `t2` 에는 요청 계정의 `keywordHits` 가 붙습니다(지역 카드의 "'커피' 행사 1"). T3 는 지난해 같은 달 방문자 수(날마다 현지인 · 외지인 · 외국인을 더해 반올림) · 기준 월 · 출처 · 산출 시각이며 인기 · 예측으로 표현하지 않습니다. 산출 전은 `null` 이고, 지난해 코드와 이어지지 않는 지역의 `t3` 는 늘 `null` 입니다</td>
<td>FR-MO-059 · 060</td>
</tr>
<tr>
<td>POST</td>
<td>`/api/v1/radar/region-signals/refresh`</td>
<td>관심 지역 신호를 지금 산출하고 `region-signals` 와 같은 모양으로 돌려줍니다. **배치가 꺼진 기간에만** 쓰며, 켜져 있으면 403 `FORBIDDEN_ACTION`. 검수와 같은 예산 게이트(100%) — 국문 관광정보 예산이 다 찼으면 부르기 전에 429 `BUDGET_EXHAUSTED`, 방문자수 예산만 막히면 `t3` 만 `null`. 지역당 최대 3콜(T1 · T2, T3 는 같은 달 지역을 묶어 1콜)이고 오늘 이미 센 T1 · T2 와 이미 있는 T3 는 다시 부르지 않습니다</td>
<td>FR-MO-059</td>
</tr>
<tr>
<td>GET</td>
<td>`/api/v1/notifications`</td>
<td>알림 목록. `kind=RISK|OPPORTUNITY` · `unread=true`. **문장은 저장하지 않고 볼 때 사실로 만듭니다**(DB 명세서 4-5) — `schedule`(그 곳이 일정에 든 일차 · 시각) · `changes`(알림 **직전** 검수와 알림 **뒤 첫** 검수의 판독 결과 차이, 예 `운영시간 09:00~18:00 → 09:00~17:00`) · `current`(비교할 이전 검수가 없을 때의 지금 판독값) · `modifiedOn`(관광정보 수정일) · `eventPeriod` · `overlapDays`(행사와 겹치는 여행 일차). `what` · `impact` 는 이 사실로 조립하며, 없는 사실은 없다고 말합니다. 새 소식은 `opportunity`(`slot` · `slotMissing` · `precheck` · 이동시간을 잰 곳 `travelSource`)로 넣을 자리와 사전 확인을, 바뀐 정보는 `verdictDiff`(알림 직전 검수와 알림 뒤 첫 검수에서 그 곳 판정의 `added` · `removed` · `changed`, 두 검수 중 하나라도 그 곳을 안 봤으면 `null`)를 싣습니다(UI-S7-008 · FR-RU-061). 행마다 `placeName` — 사용자가 일정에 적은 이름이 먼저이고, 일정에 없는 곳만 **표시 시점에 읽어** 붙입니다(저장하지 않음 · 메모리 10분 캐시 · 한 쪽의 서로 다른 콘텐츠 수만큼 공통정보 1콜). 표출이 중단된 곳(FR-AU-071)과 못 읽은 곳은 `null` 이고, 이름은 최대 6곳씩 동시에 읽고, 실패하거나 2.5초 안에 안 끝난 곳만 `null` 로 둔 채 목록을 내보냅니다(읽은 이름은 그대로 붙고, 남은 조회는 뒤에서 끝나 캐시를 채웁니다)</td>
<td>FR-MO-033·035</td>
</tr>
<tr>
<td>POST</td>
<td>`/api/v1/notifications/{id}/read`</td>
<td>확인 처리. 레이더가 알림 카드를 보일 때 처음 보는 것마다 부른다 — 헤더 건수(`radar/summary` 의 `unread`)와 상품 목록의 `unreadNotifications` 가 여기서 줄어든다</td>
<td>FR-CM-005</td>
</tr>
<tr>
<td>POST</td>
<td>`/api/v1/notifications/{id}/dismiss`</td>
<td>무시. **비표출 전환 알림이면 403 ****`FORBIDDEN_ACTION`**</td>
<td>FR-MO-037 · PM-NG-010 · EX-MO-010</td>
</tr>
</table>
**요청 · 응답 모양**
```json
GET /api/v1/radar/summary            추가 "nextBatchAt", "lastBatchAt"
GET /api/v1/radar/signals?productId= 추가 "t1": { ..., "keywordHits": [ { "keyword": "온천", "contentIds": ["123","456"] }, { "keyword": "바다", "contentIds": null } ] }
                                     (요청 계정의 키워드로 거른 것만. null = 배치가 아직 안 본 키워드. 이름은 화면이 GET /contents/{id} 로 그때 조회)
GET /api/v1/radar/region-signals     [ { "region": { "regnCd": "51", "signguCd": "150" }, "month": "2026-10",
                                         "t1": { ..., "keywordHits": [...] } | null, "t2": { ..., "keywordHits": [...] } | null,
                                         "t3": { "count": 412300, "basisMonth": "2025-10", "source": "빅데이터 지역별 방문자수", "computedAt": "..." } | null } ]
POST /api/v1/radar/region-signals/refresh   배치가 꺼진 기간에만(켜져 있으면 403 FORBIDDEN_ACTION) · 검수와 같은 예산 게이트 · 429 BUDGET_EXHAUSTED · 응답은 region-signals 와 같다
```
<callout icon="📡" color="blue_bg">
	**T1 · T2 · T3 는 배치가 미리 산출합니다** (2026.08.30 결정 · DB 명세서 v1.9, T3 · 관심 지역은 2026.09.15)
	조회 시점에 공사를 부르면 레이더 화면을 열 때마다 예산이 나갑니다. `SignalBatchJob` 이 변경 감지 배치에 이어 돌면서 지역 · 구간별로 `demand_signal` 에 넣고, **조회 경로(****`summary`**** · ****`changes`**** · ****`signals`**** · ****`region-signals`****)는 공사 호출이 0건**입니다.
	같은 창은 한 번만 부릅니다 — 상품 열 개가 모두 강릉이면 T1 창이 같습니다. T2 는 여행일에서 나오므로 지역이 같아도 일정이 다르면 창이 다릅니다.
	관심 지역(시군구 + 달)은 같은 배치가 창을 더해 T1 · 그 달의 T2 · T3(지난해 같은 달 방문자 수)를 산출합니다. 배치가 꺼진 기간에만 `region-signals/refresh` 가 사용자 요청으로 산출합니다.
	관심 키워드 일치는 그 지역 상품을 가진 계정들의 키워드 합집합으로 배치가 판정해 `demand_signal.by_keyword` 에 키워드 → contentid 로만 남기고(제목 미저장), 조회 때 요청 계정의 키워드로 거릅니다 (FR-RU-112 · DR-PR-009).
	**산출 전은 ****`null`**** 이고 0 이 아닙니다.** 0 은 「세어 보니 없었다」이고 `null` 은 「아직 안 세어 봤다」입니다. 화면이 둘을 구분해야 합니다.
</callout>
<callout icon="🔍" color="gray_bg">
	**`radar/changes`**** 의 판독 결과 변화는 있을 때만 실립니다** (FR-MO-006 · 2026.08.30)
	「휴무일 월 → 월·화」 형태는 `content_fingerprint.normalized_json` 을 전후로 맞대 만듭니다. 그 값은 **검수 실행에만 딸려 있어** 재검수가 돌아 지문이 두 번 이상 쌓인 콘텐츠에만 있습니다. 없으면 `readableChanges` 가 빈 배열이고 `hasReadableDiff` 가 `false` 입니다 — **빈 배열을 「바뀐 것 없음」으로 읽으면 안 됩니다.**
	지문 비교값(FR-MO-058)은 알림에 저장돼 있어 항상 실리되, 조건 2 · 3 은 지문 이력이 없어 둘 다 `null` 입니다.
</callout>
<callout icon="🔁" color="blue_bg">
	**검수 결과 화면의 "지금 재검수"는 별도 엔드포인트가 아닙니다.** `POST /products/{id}/audit-jobs` 에 `triggerType: "MANUAL"` 로 요청하며, 사용자가 누른 요청이라 **예산 100%까지 허용**됩니다 (자동 배치는 80%에서 중지, FR-OP-003 · FR-MO-017). 레이더 바뀐 정보 카드 · 오늘 할 일의 "다시 검수"는 그 결과 화면으로 보내는 링크입니다.
</callout>
## 4-9. 운영 — 예산 · 검수 기준 · 헬스 (F15 · F16)
<table fit-page-width="true" header-row="true">
<tr>
<td>Method</td>
<td>Path</td>
<td>설명</td>
<td>요구사항</td>
</tr>
<tr>
<td>GET</td>
<td>`/api/v1/usage/budget`</td>
<td>오늘 호출량 · 예산 대비 소진율 · **오퍼레이션별 상위 5개**. 집계값만 반환. 국문 관광정보(`provider = 'KTO'`) 예산 기준. 운영자 조회용이며 사용자 화면에는 두지 않는다(#532)</td>
<td>FR-OP-005 · PM-DA-006</td>
</tr>
<tr>
<td>GET</td>
<td>`/api/v1/usage/calls`</td>
<td>일자별·오퍼레이션별 호출 이력 집계. 활용 증빙용. 새 서비스 5종 · LLM 은 provider 별로 나눠 센다. **개별 호출의 인증키·파라미터 미노출**</td>
<td>FR-OP-007 · NF-OB-002 · PM-SC-005</td>
</tr>
<tr>
<td>GET</td>
<td>`/api/v1/settings`</td>
<td>검수 기준 조회 — 표준 요약(버전 · 가중치 · R04 임계치 · R07 표준값) · 회사 기준(R07 두 값 · 변경 이력) · 관심 키워드 · 관심 지역 · 다음 배치 시각</td>
<td>FR-OP-020 · 021</td>
</tr>
<tr>
<td>PUT</td>
<td>`/api/v1/settings`</td>
<td>회사 기준 · 관심 키워드 · 관심 지역 저장. 본문 `{r07SpanHours?, r07MealMinutes?, watchKeywords?, watchRegions?}`. 회사 기준이 표준보다 느슨하면(연속 일정 6시간 초과 · 식사 60분 미만) 400 `SETTING_NOT_STRICTER`. 바꾼 회사 기준은 변경 이력에 남는다. **다음 검수부터 적용, 과거 점수 소급 변경 없음**</td>
<td>FR-OP-022 · 026 · DR-CF-006 · 008 · EX-SY-011</td>
</tr>
<tr>
<td>GET</td>
<td>`/health`</td>
<td>**인증 없이 접근 가능.** 애플리케이션 + DB 연결 상태. 내부 정보 비노출. `checks.ktoReachable`(`unknown` · `ok` · `failed` · `not-checked`) — 실호출 모드에서 부팅 예열이 공사에 닿기 전에는 **503** 이라 배포 검사를 통과하지 못하고 옛 인스턴스가 남습니다. 예열이 다 실패해도 뒤에서 다시 시도하며(20초 × 15번, 그 뒤 10분 간격) 한 번 닿으면 503 으로 돌아가지 않습니다. 픽스처 모드 · 키 없는 부팅은 가르지 않습니다</td>
<td>NF-AV-004</td>
</tr>
<tr>
<td>POST</td>
<td>`/api/v1/demo/reset`</td>
<td>**데모 상품 초기 상태 복원.** 데모 계정(`is_demo`) 전용 — 데모 계정의 상품 · 검수 이력 · 알림을 삭제하고 리포지토리의 시드 정의로 재생성. 일반 계정 호출은 403 `FORBIDDEN_ACTION`</td>
<td>PM-TA-003 · DR-TD-007</td>
</tr>
</table>
**요청 · 응답 모양**
```json
GET /api/v1/settings
{ "standard": { "version": "2026.09",
                "weights": { "BLOCKER": 25, "ERROR": 10, "WARNING": 4, "UNVERIFIED": 3 },
                "r04Threshold": 3, "r07SpanHours": 6, "r07MealMinutes": 60 },
  "company":  { "r07SpanHours": 6, "r07MealMinutes": 90, "updatedAt": "2026-09-14T02:10:00+09:00",
                "history": [ { "at": "...", "field": "r07MealMinutes", "from": 60, "to": 90 } ] },
  "watchKeywords": ["온천"],
  "watchRegions":  [ { "regnCd": "51", "signguCd": "150", "month": "2026-10" } ],
  "ops": { "batchTime": "05:00", "nextBatchAt": "2026-09-15T05:00:00+09:00" } }

PUT /api/v1/settings          본문 { "r07SpanHours"?, "r07MealMinutes"?, "watchKeywords"?, "watchRegions"? }
  400 SETTING_NOT_STRICTER    회사 기준이 표준보다 느슨할 때 (7시간 · 30분 등)
삭제: PUT /settings/global · GET/PUT /settings/dwell · /settings/indoor-outdoor · /settings/profiles · GET /settings/lcls (라우트와 DB 표 3종 모두 릴리즈 2 에서 지웠다)
표준 3표(체류시간 · 실내외 · R10 63행)는 화면이 @tourlint/shared 를 직접 읽는다. 0콜

GET /api/v1/rules             기존 응답에 규칙마다 추가
  "dataSources": ["KTO","KAKAO"] | ..., "threshold": "연속 6시간 · 식사 60분", "example": "12:00 점심 45분은 최소 60분보다 짧습니다", "companyAdjustable": true(R07 만)
```
<callout icon="⚙️" color="gray_bg">
	**검수 기준 API에 규칙 개별 비활성화 파라미터를 두지 않습니다.** 어떤 주체도 규칙을 끌 수 없습니다 (PM-NG-003).
	**상품별 설정 덮어쓰기 파라미터도 제공하지 않습니다.** 회사 기준의 스코프는 계정 단위입니다 (FR-OP-024 · PM-DA-005).
	**검수 기준 항목은 표준 5 · 회사 기준 2 · 관심 2(관심 키워드 · 관심 지역) · 운영 3(운영자)이고, ****`PUT /settings`**** 로 바꾸는 것은 회사 기준 2개와 관심 2개뿐입니다.** 표준(가중치 · R04 임계치 · R10 기대 프로파일 63행 · 기본 체류시간 47행 · 실내 · 야외 59행)은 API로 편집하지 않고 모든 계정에 같으며, 표 3종은 화면이 `packages/shared` 시드를 직접 읽어 0콜입니다(5-12). 계정별 표 편집 엔드포인트(`target-profiles` · `dwell-defaults` · `indoor-outdoor`)는 두지 않으며, DB 표 3종과 `settings-tables` 코드는 릴리즈 2 에서 지웁니다 (FR-OP-021).
	**외부 시스템 연동용 API 토큰 발급 기능은 범위 밖입니다** (권한 10-2).
	**배치 실행 시각 · 일일 호출 예산 · 배치 자동 실행은 운영자 전용입니다** (저장: 전역 1행 `system_setting` · 환경변수). 사용자 API 로 바꾸는 경로를 두지 않으며 코드에 있던 `PUT /settings/global` 도 지웁니다. 사용자 화면에는 다음 배치 시각만 보입니다 (PM-FN-008 · PM-DA-006 · DR-CF-007).
</callout>
## 4-10. 기획 (F17)
<table fit-page-width="true" header-row="true">
<tr>
<td>Method</td>
<td>Path</td>
<td>설명</td>
<td>요구사항 · 호출</td>
</tr>
<tr>
<td>GET</td>
<td>`/api/v1/plan/briefing`</td>
<td>`regnCd` `signguCd` `startDate` `nights` `extraLcls2?`. 종류 칩 첫째 줄(기본 4 + 축제 · 공연 + 걷기 길)의 등록 수를 돌려준다 — 중분류 칩은 `areaBasedList2`(`lclsSystm2`, `numOfRows=1`)의 `totalCount` 1콜, 축제는 `searchFestival2` 1콜, 걷기 길은 두루누비 1콜 = 6콜, 지역이 바뀔 때만. `extraLcls2`("자주 넣는 곳"에서 연 종류)는 칩당 1콜. 무장애 · 반려동물 건수 포함(서비스 불가면 `null`). 둘째 줄(식당 · 카페 · 숙소)은 세지 않는다. 10분 메모리 캐시</td>
<td>FR-PL-010 · 6콜 · 검수와 같은 게이트</td>
</tr>
<tr>
<td>GET</td>
<td>`/api/v1/plan/places`</td>
<td>`scope=SIGNGU|NEAR3KM` `lcls2` `nearKind=MEAL|CAFE|STAY` `sort=near|together` `anchor=mapx,mapy` `anchorContentId` `wheelchair` `pet` `indoor` `page`. SIGNGU 는 칩과 같은 조건의 `areaBasedList2` 목록 1콜(100행 · 10분 캐시), `sort=near` 는 `locationBasedList2` 반경 20km. NEAR3KM 은 앵커 기준 `locationBasedList2`(radius 3000) 1콜 — 식당은 음식점에서 주점 · 카페 제외, 카페는 FD05, 숙소는 AC — 가까운 순만 · 순위 없음 · 응답 개수가 칩 숫자이고, 앵커가 없으면 부르지 않고 `disabled: "ANCHOR_REQUIRED"`. 응답의 제목 · 주소 · 사진 URL 은 저장하지 않는다</td>
<td>FR-PL-010 · 011 · 1에서 2콜</td>
</tr>
<tr>
<td>GET</td>
<td>`/api/v1/plan/events`</td>
<td>`searchFestival2` 여행 기간 ±3일. 각 항목에 기간 관계(BEFORE · IN · AFTER)와 옮길 출발일 제안. 끝나는 날만 조건으로 주므로 창 뒤에 열리는 행사도 함께 오고(`AFTER`), 창 전에 끝난 것과 기간을 모르는 것은 뺀다</td>
<td>FR-PL-014 · 1콜</td>
</tr>
<tr>
<td>GET</td>
<td>`/api/v1/plan/walks`</td>
<td>두루누비 걷기 길 목록(식별자 · 이름 · 길이 · 소요 · 난이도 — 좌표 없음). 넣으면 직접 정한 곳 — 넣을 때는 `walkId` 만 보내고 이름은 저장하지 않는다(4-3). 코스의 `sigun` 을 시군구 이름으로 대조하므로 그 이름을 모르면 빈 목록이다</td>
<td>FR-PL-015 · 1콜</td>
</tr>
<tr>
<td>GET</td>
<td>`/api/v1/plan/place-detail?contentId&contentTypeId&with`</td>
<td>카드 「자세히」 — 그 콘텐츠의 이용시간 · 쉬는 날 · 요금 · 주차 · 문의 · (축제는) 행사 기간. `detailIntro2` 1콜을 그때그때 실호출한다(**캐시 없음** — 펼칠 때마다). `place-facts`(4-2)와 같은 유형별 매핑을 쓰되 상품 · 항목이 아니라 contentId 로 부르므로 저장 전 카드에도 쓴다. 소개정보를 못 받으면 값은 `null`. 원문은 응답으로만 흐르고 저장하지 않는다. `with=accessible,pet` 이면 목록에서 그렇게 표시된 축의 상세(`detailWithTour2` · `detailPetTour2`)를 1콜씩 함께 부른다 — 목록은 해당 여부만 알려 준다. 축이 막히거나 실패하면 그 축만 `null`, 다른 값이 오면 400 (#850)</td>
<td>FR-PL-012 · 1콜 + 축마다 1콜 · 국문은 검수와 같은 게이트, 축은 각 서비스 예산</td>
</tr>
<tr>
<td>GET</td>
<td>`/api/v1/contents/{contentId}?with=accessible,pet`</td>
<td>기존 엔드포인트 확장. 좌표 · 분류 · 유형(#517)과 요청한 조건 축(무장애 · 반려동물)을 낸다 — 축마다 1콜, `with` 에 다른 값이 오면 400, 축이 막히거나 실패하면 그 축만 `null`. 카드 「자세히」는 핑거프린트 필드만 담는 이 응답이 아니라 `/plan/place-detail` 이 낸다(조건 축 포함 · #850)</td>
<td>FR-PL-012</td>
</tr>
<tr>
<td>POST</td>
<td>`/api/v1/products/{productId}/place-facts`</td>
<td>`{itemIds?}`. 고른 항목의 장소 정보 한 줄 값(이용시간 · 쉬는 날 · 요금 · 주차 · 행사 기간)과 앞 항목에서 차로 걸리는 시간(양쪽 좌표가 있고 앞 줄이 같은 날 고른 곳일 때만, 대중교통 상품은 늘 `null`). 고르지 않은 줄 · 직접 정한 곳은 응답에 넣지 않고, 장소명을 저장하지 않은 줄은 표시할 때 찾는다. 규칙엔진을 부르지 않고 `audit_run` 없음 · 저장 없음. 고른 직후 그 항목만</td>
<td>FR-PL-005 · 항목당 1콜 + 구간 카카오 1콜</td>
</tr>
<tr>
<td>POST</td>
<td>`/api/v1/products/{productId}/items`</td>
<td>본문 확장(4-3 참조): `content{…}` 면 CONFIRMED 로 생성, `excluded{walkId}` 면 EXCLUDED(걷기 길), `afterItemId` 로 자리 지정, 시각 자동 채움, 식당 · 카페 · 숙소는 식사 · 휴식 · 숙박 유형</td>
<td>FR-PL-013 · 0~1콜(카카오)</td>
</tr>
<tr>
<td>POST</td>
<td>`/api/v1/products/{productId}/handoff`</td>
<td>`{excludePending?}`. `planned_at` 기록 + 첫 검수 요청(F04 큐). PENDING 이 있고 `excludePending` 이 아니면 422 `PLACE_UNRESOLVED` 와 `pendingCount`, true 면 남은 PENDING 을 EXCLUDED 로 바꾸고 넘긴다(한 트랜잭션)</td>
<td>FR-PL-001</td>
</tr>
</table>
**요청 · 응답 모양**
```json
GET /api/v1/plan/briefing?regnCd=51&signguCd=150&startDate=2026-10-23&nights=1(&extraLcls2=중분류)
  → PlanBriefing (packages/shared plan.ts). 첫째 줄 칩 = PLAN_BASE_LCLS2 4 + 축제 · 공연 + 걷기 길 (+ extraLcls2: "자주 넣는 곳"에서 연 종류, FD · AC 제외 — 카페 · 식당 · 숙소는 NEAR3KM 칩을 연다).
    중분류 칩마다 areaBasedList2(lDongRegnCd, lDongSignguCd, lclsSystm2, numOfRows=1) 의 totalCount 1콜.
    축제 · 공연은 searchFestival2 1콜, 걷기 길은 두루누비 1콜 → 6콜. 지역이 바뀔 때만 다시 센다. 기대 · 없음 표시는 없다. 지역 · 중분류별 10분 메모리 캐시
GET /api/v1/plan/places?regnCd&signguCd&lcls2=VE01&sort=near|together&anchor=128.89,37.79&anchorContentId=125769&wheelchair=1&pet=1&indoor=1&page=1
  → { "scope": { "kind": "SIGNGU" | "NEAR", "label": "강릉시 전체" | "고른 줄 반경 20km" | "강릉시 전체 · 2026년 8월 기준 함께 많이 가는 순" }, "totalCount": 6, "items": PlanPlace[], "disabled": null, "notice": "..." }
    together 로 순위를 매기면 label 에 연관 관광지 자료의 기준 연월을 붙인다(EI-KT-024 · #832). 매기지 못했으면 붙이지 않는다
    totalCount 는 거른 뒤 곳 수이고 items 는 한 쪽 20곳(page)이다. 목록은 칩과 같은 조건이라 필터를 걸지 않으면 칩 숫자와 맞는다
    칩과 같은 조건(lclsSystm2 · 시군구)의 areaBasedList2를 100행씩 totalCount까지 페이지 조회한다. 전체 목록을 10분 메모리 캐시하고 중복 contentid를 제거한 뒤 정렬·필터를 적용한다. 추가 원본 페이지마다 예산을 확인한다. 중간 조회가 실패하면 일부를 전체로 반환하거나 캐시하지 않는다. 응답 totalCount는 필터 후 전체 수이며 page(1부터)에 따라 20곳씩 items로 반환한다.
    near 는 locationBasedList2(radius 20000) 1콜. together 는 searchKeyword1(앵커 이름 · 시군구 · 기준 연월) 1콜 · 연관 관광지 응답에 contentid 가 없어 이름 · 시군구 대조가 하나로 정해질 때만 순위 · 관광지 순위만 · 기준 연월 표기 · 기준은 넣을 위치 앞의 고른 항목(앵커). 앵커가 없으면 이 정렬은 비활성
GET /api/v1/plan/places?scope=NEAR3KM&nearKind=MEAL|CAFE|STAY&anchor=128.89,37.79&page=1
  → { "scope": { "kind": "NEAR3KM", "label": "해변 K 근처 3km" }, "totalCount": 12, "items": PlanPlace[] }   거리순 · togetherRank 는 늘 null
    locationBasedList2(mapX, mapY, radius=PLAN_NEAR_RADIUS_M, lclsSystm1=FD|AC, numOfRows=1000) 목록을 totalCount까지 페이지 조회하고 중복을 제거한 후 PLAN_NEAR_KIND 로 거른다(식당 = FD 중 주점 FD04 · 카페 FD05 제외, 카페 = FD05, 숙소 = AC). 거른 개수가 칩 숫자다. 응답이 거리순으로 오지 않아 dist 로 정렬한다.
    앵커가 없거나 앞 항목이 직접 정한 곳이면 부르지 않고 { "disabled": "ANCHOR_REQUIRED" }
GET /api/v1/plan/events?regnCd&signguCd&startDate&nights   → { "window": { "from", "to" }, "items": PlanEvent[] }
GET /api/v1/plan/walks?regnCd&signguCd                     → { "items": PlanWalk[], "notice": "넣으면 직접 정한 곳으로 들어가요" }
    두루누비 courseList 1콜(지역 조건 없음 · 전국 코스 · 10분 캐시)을 코스의 시군구 글자(sigun)로 거른다. 코스에 좌표가 없어 앵커가 되지 않는다
GET /api/v1/plan/place-detail?contentId=125790&contentTypeId=12&with=accessible
  → { "contentId", "hours", "restDays", "fee", "parking", "eventPeriod", "contact", "accessible"?: {...} | null, "pet"?: {...} | null }
    값은 공사 원문 · 응답으로만 · 저장 없음. 원문의 `<br>` 만 개행으로 바꿔 보낸다(#762). accessible · pet 은 요청한 축만 실린다(#850)
    detailIntro2 1콜을 캐시 없이 실호출한다(펼칠 때마다). place-facts 와 같은 유형별 필드 매핑(INTRO_FIELDS · 요금 · 주차)을 contentId 로 쓴다. 소개정보를 못 받으면 모든 값 null
    거르는 기준은 법정동 목록에서 찾은 시군구 이름이고, 세종처럼 시군구 단계가 없는 곳만 시도 약칭으로 본다
GET /api/v1/contents/{contentId}?contentTypeId=12&with=accessible,pet   기존 응답 + "accessible": {...} | null, "pet": {...} | null
    요청한 축만 detailWithTour2 · detailPetTour2 로 1콜씩 부르고(10분 캐시) 값에서 contentid 는 뺀다. with 가 없으면 콜 수도 응답도 그대로다
POST /api/v1/products/{id}/place-facts  본문 { "itemIds"?: [17] }  → { "items": PlaceFacts[] }. 규칙엔진 · audit_run 없음 · 저장 없음. 고른 직후 그 항목만. 글자 값은 place-detail 과 같이 `<br>` 을 개행으로 바꿔 보낸다(#762)
모든 기획 조회: 예산 100% 면 검수와 같은 429 BUDGET_EXHAUSTED. 오류 본문은 공통 모양(3-2) 그대로이고 재개 시각(내일 0시)과 "일정 입력 · 저장은 지금도 된다"를 message 에 담는다 — 오류에 필드를 더하지 않는다. 새 서비스 하나가 막히거나 실패하면 그 필드만 null 이고 notice 로 알린다
타입 PlanBriefing · PlanPlace · PlanEvent · PlanWalk · PlaceFacts 는 packages/shared plan.ts. PlanPlace 에서 worldHeritage 를 뺐다(2026.09.16) — 목록 응답에 그 표시가 없고 화면 요구사항에도 없다
```
<callout icon="🚧" color="orange_bg">
	**기획 조회는 판정하지 않고 저장하지 않습니다** (FR-PL-017 · 021).
	`plan` 모듈은 `external` 을 쓰되 `engine/rules` 를 부르지 않습니다. `place-facts` 도 규칙 함수를 부르지 않고 `audit_run` · `finding` · `content_fingerprint` 를 만들지 않습니다. 규칙 번호 · 통과 여부 · 등급은 검수 시작 뒤 검수 결과에서만 나옵니다.
	응답의 제목 · 주소 · 사진 URL · 행사명은 응답으로만 흐르고 DB · 로그에 남지 않습니다. 캐시는 메모리 10분뿐이며(지역 · 중분류별 수와 목록, 무장애 · 반려동물 contentid 집합), `detailIntro2` 본문은 기존 이름 캐시 범위를 넘기지 않습니다 (DR-PR-009 · DB 명세서 6-4).
	비표출(`showflag = 0`) 콘텐츠는 어느 목록에도 나오지 않습니다 (FR-PL-019).
</callout>
## 4-11. 에이전트 (F18)
<table fit-page-width="true" header-row="true">
<tr>
<td>Method</td>
<td>Path</td>
<td>설명</td>
<td>요구사항 · 호출</td>
</tr>
<tr>
<td>POST</td>
<td>`/api/v1/products/{productId}/place-suggestions`</td>
<td>`{itemIds?}`(없으면 PENDING 전체). 줄마다 `{itemId, kind: FOUND|NOT_FOUND|NO_NAME, place?, alternatives[], reason}` 과 요약 건수. `place` 의 제목 · 주소는 응답으로만 흐른다. 도구 결과 밖 contentid 는 버린다. `NO_NAME` 은 서버가 정한다 — 일반 낱말로만 된 줄(「점심」 · 「숙소 체크인」)은 모델도 공사도 부르지 않는다. 저장 없음</td>
<td>FR-AG-010 – 012 · 줄마다 0 – 2콜 + LLM 1회 · 30초</td>
</tr>
<tr>
<td>POST</td>
<td>`/api/v1/audit-runs/{runId}/check-questions`</td>
<td>확인 필요 목록으로 곳마다 `{findingIds[], itemId, visit{dayNo, date, start}, tel: string|null, questions[]}`. 도구 결과 밖 전화번호는 `null` 로 바꾼다. `visit` 은 항목 값 그대로이고 `findingIds` 는 그 곳의 것만 남긴다 — 둘 다 서버가 채운다. 확인 필요가 0건이면 모델도 부르지 않는다. 모델에게 주는 곳 이름과 이유 문장은 결과 화면과 같은 표시 값이다 — 이름을 저장하지 않은 곳은 결과 화면이 읽어 둔 이름(10분 캐시)을 쓰고, 없으면 그 곳만 공통정보로 찾는다. 저장 없음</td>
<td>FR-AG-020 – 022 · 곳마다 최대 2콜(문의처 10분 캐시) + 이름을 저장하지 않은 곳의 이름(결과 화면 캐시에 없을 때만 1콜) + LLM 1회</td>
</tr>
<tr>
<td>POST</td>
<td>`/api/v1/radar/today`</td>
<td>`{basisAt, todos: [{kind: CHANGE|NEWS, productId?, region?, reason, action: REAUDIT|VIEW_RESULT|NEW_PLAN}], quiet: [{productId, text}]}`. 순서 · 종류 · 대상은 서버가 정하고 모델은 이유 한 줄만 쓴다 — 알림 · 새 소식에 없는 항목은 버린다. `basisAt` 은 마지막 배치 시각(없으면 지금)이다. 이름을 저장하지 않은 곳은 알림 목록이 읽어 둔 이름(10분 캐시)만 쓴다 — 공사를 부르지 않고, 없으면 세기만 한다. 표출이 중단된 곳은 이름을 쓰지 않는다. 저장 없음</td>
<td>FR-AG-030 · 031 · 0콜 + LLM 1회</td>
</tr>
</table>
**실행 전에 막히면 요청을 거절한다** — 예산 100% 는 429 `BUDGET_EXHAUSTED`, 같은 계정의 같은 에이전트가 이미 돌고 있으면 429 `RATE_LIMIT_EXCEEDED`(새로 돌리지 않는다, FR-AG-002 · EX-AG-004). **실행한 뒤에는 거절하지 않는다** — LLM 실패 · 시간 초과(30초) · 도구 호출의 예산 소진이면 200 으로 끝난 항목만 돌려주고 `incomplete: { reasonCode, itemIds }` 를 채운다. 하나도 못 끝냈으면 결과 배열이 비어 있다(EX-AG-001 · 002). 화면은 `incomplete` 가 있으면 "지금은 AI로 정리할 수 없어요"를 보이고 끝난 항목만 카드로 보인다.
**요청 · 응답 모양**
```json
POST /api/v1/products/{id}/place-suggestions   본문 { "itemIds"?: [21, 22] }   (없으면 PENDING 전체)
  → { "items": PlaceSuggestion[], "summary": { "found": 5, "notFound": 1, "noName": 2 }, "incomplete": null }
    예: { "itemId": 22, "kind": "FOUND", "place": { "contentId": "…", "contentTypeId": 39, "title": "식당 A", "kindName": "음식점", "addr": "강릉시 초당동" },
          "alternatives": [ { "contentId": "…", "title": "식당 C", "kindName": "음식점", "distanceM": 2300 } ],
          "reason": "초당순두부 음식점 3곳 중 앞 일정과 가장 가까운 곳이에요 (1.4km)" }
    도구: searchKeyword2(상품 지역) · detailCommon2. 줄마다 0 – 2콜 + LLM 1회. 도구 결과에 없던 contentId 는 버린다. 저장 · 로깅 없음
    검색 지역은 서버가 상품의 시도 · 시군구로 붙인다(모델 입력이 아니다). 제목 · 주소 · 분류도 도구가 받아 둔 값만 싣고, alternatives 의 distanceM 은 앞뒤 고른 줄과의 직선거리다 — 이동시간이 아니다.
    끝내지 못한 줄(모델 실패 · 시간 초과 · 예산 · 버린 줄)은 incomplete.itemIds 에 담기고 응답 items 에는 없다
POST /api/v1/audit-runs/{runId}/check-questions
  → { "places": CheckQuestionPlace[], "incomplete": null }
    예: { "findingIds": [301], "itemId": 25, "visit": { "dayNo": 1, "date": "2026-10-23", "start": "19:30" }, "tel": null, "questions": ["그날 문을 여나요?", "몇 시까지 운영하나요?"] }
    도구: audit-runs/{id}/unverified · findings · 상품 항목 · content-view 연락처(공통정보 tel → 소개정보 infocenter). 곳마다 최대 2콜(공통정보 1 + tel 이 비었을 때 소개정보 1 · 10분 캐시) + LLM 1회. 도구 결과에 없던 전화번호는 null
    곳은 확인 불가 · 확인 필요 판정을 항목별로 묶은 것이다 — 이미 확인한 항목과 항목을 가리키지 않는 판정은 빼고, 직접 정한 곳은 문의처를 조회하지 않는다
POST /api/v1/radar/today
  → { "basisAt": "2026-09-11T05:00:00+09:00", "todos": TodayItem[], "quiet": [ { "productId": 9, "text": "태백 당일 산행은 바뀐 정보가 없어요." } ], "incomplete": null }
    도구: radar/summary · radar/changes · notifications · 관심 지역 새 소식 · 상품 목록. 공사 0콜 + LLM 1회. 순서는 서버가 정한다(출발일이 가까운 상품의 바뀐 정보 → 새 소식)
    대상은 여행이 끝나지 않은 상품이고, 바뀐 정보가 없는 상품은 quiet 한 줄이다. 아직 세지 않았거나 0 건인 관심 지역은 새 소식이 아니다
    공사를 부르지 않아 예산 게이트가 없다 — 이 에이전트의 실행 전 거절은 동시 실행(429 RATE_LIMIT_EXCEEDED)뿐이다
모든 에이전트: 사람이 누를 때만 · 계정당 같은 에이전트 동시 1회 · 30초.
  실행 전 거절 — 429 BUDGET_EXHAUSTED(예산 100%) · 429 RATE_LIMIT_EXCEEDED(같은 에이전트가 도는 중 · 분당 상한)
  실행 뒤 실패 — 200 + 끝난 항목만 + "incomplete": { "reasonCode": "LLM_UNAVAILABLE" | "BUDGET_EXHAUSTED", "itemIds": [23, 24] }  (레이더 에이전트는 itemIds 가 빈 배열)
  필드는 더해도 되지만 도구 결과 밖 값은 넣지 않는다
타입 PlaceSuggestion · CheckQuestionPlace · TodayItem · AgentIncomplete 는 packages/shared agent.ts. TodayItem.region 은 { regnCd, signguCd, month } — 시군구 코드(3자리)는 시도 코드와 함께여야 한 곳으로 정해진다
```
<callout icon="🤖" color="blue_bg">
	**에이전트는 제안만 하고 아무것도 바꾸지 않습니다** (FR-AG-001 · 003 · 004).
	에이전트마다 정한 읽기 도구만 쓰고, 상품 · 항목 · 판정을 바꾸는 서비스 메서드는 도구로 넘기지 않습니다. 바꾸는 것은 사람이 누르는 기존 API 입니다 — `items/{id}/match` · `items/{id}/exclude` · `findings/{id}/confirm` · `products/{id}/audit-jobs`.
	그 실행의 도구 결과에 없던 contentid · finding id · 전화번호 · 알림 id · 상품 id 는 서버가 그 항목째 버립니다.
	제안 · 이유 · 질문 · 할 일과 도구 결과는 저장하지 않고 로그에도 남기지 않습니다. LLM 호출은 `api_call_log` 에 `provider = 'LLM'` · `operation` = 목적(`PLACE_MATCH` · `CHECK_QUESTIONS` · `TODAY_BRIEF`)으로 세고, 로그에는 에이전트 이름 · 도구 호출 수 · 걸린 시간 · 성공 여부만 남깁니다. 에이전트 문장은 `finding.message` 에 넣지 않으므로 같은 검수의 결정론(NF-MT-001)과 무관합니다.
</callout>
---
# 5. 주요 요청·응답 DTO
## 5-1. 상품 생성
```json
// POST /api/v1/products  (요청)
{
  "name": "강릉 감성 1박 2일",
  "ldongRegnCd": "51",
  "ldongSignguCd": "150",
  "startDate": "2026-10-28",
  "nights": 1,
  "targetKey": "20대",
  "conceptKey": "감성",
  "headCount": 24,
  "transport": "CHARTER_BUS"
}

// 201 Created (응답)
{
  "productId": 31,
  "name": "강릉 감성 1박 2일",
  "startDate": "2026-10-28",
  "nights": 1,
  "dayCount": 2,
  "releasedAt": null,
  "createdAt": "2026-08-15T10:02:11+09:00"
}
```
## 5-2. 상품 목록 (홈 · 내 상품)
```json
// GET /api/v1/products?page=0&size=20
{
  "content": [
    {
      "productId": 31,
      "name": "강릉 감성 1박 2일",
      "startDate": "2026-10-28",
      "nights": 1,
      "region": { "regnName": "강원특별자치도", "signguName": "강릉시" },
      "latestAudit": {
        "auditRunId": 812,
        "executedAt": "2026-09-15T14:32:07+09:00",
        "readinessScore": 29,
        "isPartial": false,
        "counts": { "blocker": 2, "error": 1, "warning": 2, "unverified": 1 },
        "releasable": false
      },
      "unreadNotifications": 3,
      "activeNotifications": 4,
      "risksSinceAudit": 1,
      "pendingMatches": 0,
      "startedBy": "MANUAL"
    }
  ],
  "page": 0, "size": 20, "totalElements": 1, "totalPages": 1
}
```
`latestAudit.readinessScore` 는 5-5 와 같은 **조회 시점 재계산 값**입니다(FR-AU-046). 무시한 판정을 뺀 점수라 `audit_run` 저장값과 다를 수 있습니다. `counts` 도 5-5 의 `counts` 와 같은 재계산 값으로, 무시한 판정을 뺀 건수입니다.
## 5-3. 장소 검색 · 확정
검색과 확정은 **장소를 입력하는 순간** 화면 2 편집기 행에서 일어납니다(목록에서 고르기). 저장한 뒤 검수 화면에서 확정하는 단계는 없습니다. 기획 에이전트 카드의 "이곳으로 선택"도 같은 `match` 를 `matchedBy: "AGENT"` 로 부릅니다 (FR-PL-004 · FR-AG-012).
```json
// GET /api/v1/contents/search?keyword=중앙시장&regnCd=51&signguCd=150
{
  "regionFilterApplied": true,
  "fetchedAt": "2026-08-15T10:05:22+09:00",
  "candidates": [
    {
      "contentid": "2668891",
      "title": "강릉중앙시장",
      "addr1": "강원특별자치도 강릉시 금성로 21",
      "contenttypeid": 38,
      "lDongRegnCd": "51",
      "lDongSignguCd": "150",
      "cpyrhtDivCd": "Type3"
    }
  ],
  "source": "ⓒ한국관광공사"
}

// POST /api/v1/items/{itemId}/match  (요청)
{ "contentid": "2668891", "matchedBy": "USER" }

// 200 OK (응답) — 확정 시점 실시간 취득 정보
{
  "itemId": 101,
  "matchStatus": "CONFIRMED",
  "content": {
    "contentid": "2668891",
    "title": "강릉중앙시장",
    "addr1": "강원특별자치도 강릉시 금성로 21",
    "contenttypeid": 38,
    "lclsSystm1": "SH", "lclsSystm2": "SH02", "lclsSystm3": "SH020100",
    "mapx": 128.898632, "mapy": 37.753996,
    "usetime": "09:00~21:00",
    "restdate": "매월 둘째주 일요일",
    "infocenter": "033-000-0000",
    "homepage": "http://example.kr",
    "firstimage": "http://tong.visitkorea.or.kr/...",
    "modifiedtime": "20260814103000",
    "createdtime": "20180301120000",
    "cpyrhtDivCd": "Type3"
  },
  "fetchedAt": "2026-08-15T10:06:03+09:00",
  "sourceBadge": { "type": "KTO_RAW", "note": "변경금지" }
}
```
<callout icon="©️" color="blue_bg">
	**`sourceBadge`****는 모든 정보에 붙습니다** (FR-CM-010). 4종 — `KTO_RAW` 공사 원문(무가공) · `TOURLINT_VERDICT` 판정 · `AI_NORMALIZED` AI 정규화(원문 병기 필수) · `EXTERNAL_REF` 외부 참고(제공자명 표기).
	실측상 콘텐츠 대부분이 `cpyrhtDivCd = Type3`(변경금지)입니다. 확정 응답의 `sourceBadge.note` 는 받은 값이 `Type3` 이면 "변경금지", 아니면(`Type1` · 값 없음) `null` 입니다 (FR-CM-011 · EI-KT-017).
</callout>
## 5-4. 검수 요청 · 폴링
```json
// POST /api/v1/products/31/audit-jobs  (요청)
{ "triggerType": "MANUAL" }

// 202 Accepted (응답, p95 500ms 이내)
{
  "jobId": 5501,
  "status": "QUEUED",
  "productId": 31,
  "createdAt": "2026-09-15T14:31:58+09:00",
  "pollIntervalMs": 2000
}

// GET /api/v1/audit-jobs/5501  (진행 중)
{
  "jobId": 5501,
  "status": "RUNNING",
  "progress": { "done": 5, "total": 8, "label": "8곳 중 5곳 조회 완료" },
  "auditRunId": null
}

// GET /api/v1/audit-jobs/5501  (완료)
{
  "jobId": 5501,
  "status": "DONE",
  "progress": { "done": 8, "total": 8, "label": "8곳 중 8곳 조회 완료" },
  "auditRunId": 812,
  "finishedAt": "2026-09-15T14:32:11+09:00"
}

// GET /api/v1/audit-jobs/5501  (실패)
{
  "jobId": 5501,
  "status": "FAILED",
  "progress": { "done": 3, "total": 8, "label": "8곳 중 3곳 조회 완료" },
  "auditRunId": null,
  "errorCode": "AUDIT_TIMEOUT",
  "message": "검수가 30분을 초과해 중단되었습니다. 다시 실행해 주세요.",
  "finishedAt": "2026-09-15T15:02:00+09:00"
}
```
<callout icon="⏱" color="yellow_bg">
	**같은 상품에 진행 중인 작업이 있으면 새 작업을 만들지 않고 기존 ****`jobId`****를 202로 반환합니다** (EX-AU-004).
	미확정 관광지가 남아 있으면 작업을 만들지 않고 **422 ****`PLACE_UNRESOLVED`** 로 거부하며, 응답에 미확정 항목 목록을 담습니다 (EX-AU-001).
	화면 이탈 후 재진입 시 `jobId`로 진행 상태를 이어서 표시합니다 (EX-AU-003). 재진입한 화면은 검수 이력(`GET /products/{productId}/audit-runs`)의 `activeJobId` 로 그 작업을 찾습니다(UI-ST-003). 폴링 간격은 202 응답의 `pollIntervalMs` 입니다.
</callout>
## 5-5. 검수 결과 요약
```json
// GET /api/v1/audit-runs/812
{
  "auditRunId": 812,
  "productId": 31,
  "executedAt": "2026-09-15T14:32:07+09:00",
  "rulesetVersion": "v1.3.0",
  "isPartial": false,
  "readinessScore": 29,
  "scoreBreakdown": {
    "formula": "100 - (2 x 25) - (1 x 10) - (2 x 4) - (1 x 3) = 29",
    "deduction": 71,
    "weights": { "BLOCKER": 25, "ERROR": 10, "WARNING": 4, "UNVERIFIED": 3 },
    "scoredCounts": { "blocker": 2, "error": 1, "warning": 2, "unverified": 1 }
  },
  "settingSnapshot": { "standardVersion": "2026.09", "r07SpanHours": 6, "r07MealMinutes": 90 },
  "counts": { "blocker": 2, "error": 1, "warning": 2, "unverified": 1, "dismissed": 0 },
  "targetCount": 8,
  "failedCount": 0,
  "excludedItemCount": 0,
  "releasable": false,
  "releaseBlockedReason": "차단 2건",
  "evidence": {
    "fetchedAt": "2026-09-15T14:32:07+09:00",
    "targetContentCount": 8,
    "dataFingerprint": "a3f91c2e",
    "rulesetVersion": "v1.3.0",
    "ktoLastModified": "20260914",
    "delayNotice": "공사 데이터는 당일 변경분이 익일 반영되므로 출발 임박 시 운영기관 최종 확인을 권장합니다",
    "source": "출처: ⓒ한국관광공사"
  }
}
```
<callout icon="🧮" color="green_bg">
	**`scoreBreakdown.formula`****를 응답에 그대로 담습니다.** 점수가 산식에서 도출되었음을 사용자가 화면에서 직접 검산할 수 있어야 하기 때문입니다 (FR-AU-043).
	**확인 필요 N건은 점수와 분리 표기**합니다 — N은 확인 불가 등급 건수가 아니라 **확인 필요 목록의 항목 수**입니다(추정 동시 등록 · 출발 임박 항목 포함). 예: "출시 준비도 93점 · 확인 필요 3건" (FR-AU-044).
	`isPartial = true`이면 `readinessScore`는 `null`이며 화면에 숫자를 표시하지 않고 `부분 검수` 배지를 노출합니다 (EX-AU-007).
	`readinessScore` · `counts`는 **조회 시점에 미무시 finding + 해당 실행의 ****`weight_snapshot`****으로 재계산한 값**입니다. `audit_run` 저장값은 실행 시점 기록으로 불변이며, 무시 건수는 `counts.dismissed`로 병기합니다 (FR-AU-046).
	`scoreBreakdown.scoredCounts` 는 **감점에 쓴 등급별 건수**입니다. `counts` 에서 감점하지 않는 출발 전 최종 확인 항목(FR-AU-045)을 뺀 값이라 `formula` 의 건수와 같고, 화면의 계산 문장(UI-S3-010)이 이 값으로 적습니다.
	`evidence.dataFingerprint`는 콘텐츠별 지문을 `kto_content_id` 오름차순으로 U+001F 연결 후 재해시한 **실행 대표 지문**의 앞 8자리입니다. 전체 값 확인 수단을 함께 제공합니다 (DR-FP-008 · UI-CM-032).
	`settingSnapshot` 은 **실행 시점의 표준 버전과 회사 기준 두 값**입니다. `weight_snapshot` 처럼 실행에 딸린 기록이라 회사 기준을 나중에 바꿔도 소급해 바뀌지 않고, 리포트 머리글이 이 값을 씁니다. 컬럼이 생기기 전의 실행은 `null` 입니다 (FR-OP-023 · DR-CF-009).
	R07 finding 의 `message` 는 **적용한 기준을 함께 적습니다** — 예: "12:00 점심 60분은 회사 기준 90분보다 짧습니다. TourLint 표준 60분은 충족합니다." 회사 기준이 표준과 같으면 지금 문장 그대로입니다 (FR-RU-074 · NF-MT-001).
</callout>
## 5-6. finding 목록
```json
// GET /api/v1/audit-runs/812/findings?severity=BLOCKER
{
  "content": [
    {
      "findingId": 9101,
      "ruleCode": "R01",
      "ruleVersion": "1.0.0",
      "severity": "BLOCKER",
      "reasonCode": "REST_DAY_CONFLICT",
      "message": "오죽헌은 매주 월요일 휴관입니다. 10월 12일(월) 10:00 일정을 다른 날짜로 옮기거나 대체 관광지로 교체해 주세요.",
      "target": {
        "itemId": 101, "dayNo": 1, "seq": 1,
        "startTime": "10:00", "placeLabel": "오죽헌"
      },
      "targetSecondary": null,
      "requiresExternal": false,
      "externalSource": null,
      "sourceBadge": "TOURLINT_VERDICT",
      "needsConfirmation": false,
      "hiddenContent": null,
      "evidenceView": {
        "aiNormalized": { "weeklyClosed": ["MON"], "confidence": "CONFIRMED" },
        "verdict": { "visitDate": "2026-10-12", "visitWeekday": "MON", "conflict": true }
      },
      "patches": [
        { "patchId": "p-1", "type": "REPLACE_CONTENT",
          "payload": { "ktoContentId": "126512", "distanceMeters": 4200 },
          "placeName": "선교장",
          "label": "선교장으로 대체 (연중무휴 · 4.2km)" },
        { "patchId": "p-2", "type": "TIME_SHIFT",
          "payload": { "newDayNo": 2, "newStartTime": "10:00" },
          "label": "방문 날짜를 10월 13일로 변경" },
        { "patchId": "p-3", "type": "REORDER",
          "payload": { "swapWithItemId": 103 },
          "label": "오죽헌과 안목해변 순서 교체" }
      ],
      "dismissible": false,
      "dismissedAt": null,
      "dismissReason": null,
      "confirmedAt": null
    }
  ],
  "totalElements": 2
}
```
<callout icon="📖" color="blue_bg">
	**`evidenceView`****가 판정 근거의 데이터 소스입니다.** 목록 응답에는 자체 산출물인 **AI 해석 · 판정 2단만** 담고, **공사 원문(****`ktoRaw`****)은 포함하지 않습니다.** 카드의 "판단 근거 보기" 펼침 시 `GET /api/v1/contents/{contentId}`로 그 1건만 실시간 조회해 3단 병기를 완성합니다 (FR-AU-013 · 061, 기본 접힘 — UI-S3-011 · 5-12절).
	펼침 시 표시하는 원문은 그 순간 조회한 실시간 값이며 DB에서 읽지 않습니다. `overview`를 AI로 요약·재작성해 담는 필드는 존재하지 않습니다 (FR-AU-062 · NF-CO-013).
	**`dismissible`****은 ****`severity !== "BLOCKER"`****일 때만 true**입니다. 화면 버튼 제어용이며, API·DB에서도 각각 독립적으로 차단합니다.
	**`target`****은 항목이 있을 때만 상세를 담습니다.** 상품 전체 판정(R04 · R10)이나 수정안 반영으로 사라진 항목은 `{ "itemId": null }` 처럼 id 만 옵니다 — 없는 값을 지어내지 않습니다. `placeLabel`은 **사용자가 입력한 문구**라 응답에 담아도 무저장 원칙과 무관합니다 (DB 명세서 6-4 검증 ①의 제외 대상).
	**페이징하지 않습니다.** 응답은 `content` 와 `totalElements` 뿐입니다 — 한 검수의 finding 은 항목 수 × 규칙 수로 묶여 있어 나눌 이유가 없고, 화면은 등급별로 묶어 한 번에 그립니다(UI-S3). 3장 페이지네이션 규약의 예외입니다.
	**`patches[].placeName`****은 저장물이 아닙니다.** 대체 관광지 명칭은 공사 원문이라 저장하지 않고, 표시할 때 `GET /contents/{contentId}`로 조회해 얹습니다 (DR-PR-001). 조회에 실패하면 이 필드가 없고 화면은 유형·거리로 표시합니다.
</callout>
**비표출 콘텐츠의 finding** — 명칭·주소를 재출력하지 않고 `contentid`와 전환 감지 시각만 담습니다 (FR-AU-071 · PM-NG-009).
```json
{
  "findingId": 9107,
  "ruleCode": "R06",
  "severity": "BLOCKER",
  "reasonCode": "CONTENT_HIDDEN",
  "message": "이 관광지는 표출이 중단되어 정보를 표시할 수 없습니다. 일정은 유지되며 대체 관광지를 제안합니다.",
  "target": { "itemId": 207, "dayNo": 2, "seq": 3, "startTime": "14:00" },
  "hiddenContent": { "contentid": "126508", "detectedAt": "2026-09-20T05:03:11+09:00" },
  "patches": [
    { "patchId": "p-1", "type": "REPLACE_CONTENT", "label": "반경 20km 내 동일 유형 대안" }
  ]
}
```
`target`에 `placeLabel`이 없고 `hiddenContent`에 명칭·주소가 없는 것이 핵심입니다.
## 5-7. 확인 필요 목록
```json
// GET /api/v1/audit-runs/812/unverified
{
  "totalCount": 3,
  "items": [
    {
      "findingId": 9105,
      "contentid": "1234567",
      "placeLabel": "B전망대",
      "reason": "운영시간이 데이터에서 확인되지 않습니다",
      "reasonCode": "PARSE_REFERENCE",
      "location": { "dayNo": 2, "seq": 1, "startTime": "09:00" },
      "confirmedAt": null,
      "excludedFromScore": false
    },
    {
      "findingId": 9109,
      "reason": "출발 전 운영기관 최종 확인",
      "reasonCode": "PRE_DEPARTURE_CHECK",
      "excludedFromScore": true,
      "note": "출발이 가까워 자동으로 올린 항목이며 감점하지 않습니다"
    }
  ]
}
```
문의처가 없으면 `contact.tel`을 `null`로 두고 화면에 "정보 없음"을 표시합니다. **항목 자체를 숨기지 않습니다** (FR-AU-082 · EX-PS-010). 목록의 관광지명은 `place_label`(사용자 입력 · 0콜)로 표기합니다. **장소 담기 · 삽입 확정으로 들어와 라벨이 빈 항목만** 그 항목의 이름을 표시 시점에 조회해 채우고(5-12 화면 3과 같은 방식), 판정 문장 앞의 이름도 같은 값으로 채웁니다 — 저장된 문장은 이름 자리가 비어 있습니다. 공사 원문(`ktoRaw`) · 문의처는 **항목 펼침 시 1콜**로 실시간 조달합니다 (5-12절).
## 5-8. 패치 미리보기 · 확정
```json
// POST /api/v1/products/31/patch-preview  (요청)
{
  "selections": [
    { "findingId": 9101, "patchId": "p-1" },
    { "findingId": 9102, "patchId": "p-2" },
    { "findingId": 9103, "patchId": "p-1" },
    { "findingId": 9104, "patchId": "p-3" }
  ]
}

// 200 OK (응답) — 일정은 아직 바뀌지 않았음
{
  "previewToken": "pv_7f21a9",
  "conflict": { "hasConflict": false, "pairs": [] },
  "before": { "items": [ /* 현재 일정 */ ] },
  "after":  { "items": [ /* 4건 모두 반영한 결과 */ ] },
  "diff": [
    { "op": "REPLACE", "dayNo": 1, "seq": 1,
      "from": "10:00 오죽헌", "to": "10:00 선교장" },
    { "op": "INSERT",  "dayNo": 2, "seq": 4,
      "to": "19:30 강릉 야간 해변축제" },
    { "op": "TIME",    "dayNo": 2, "seq": 5,
      "from": "20:00 숙소 체크인", "to": "21:30 숙소 체크인" }
  ]
}

// 충돌이 있는 경우 — 확정 차단
{
  "previewToken": "pv_7f21a9",
  "conflict": {
    "hasConflict": true,
    "pairs": [
      {
        "a": { "findingId": 9101, "patchId": "p-2" },
        "b": { "findingId": 9104, "patchId": "p-3" },
        "kind": "SAME_ITEM",
        "message": "두 수정안이 같은 일정 항목을 서로 다르게 바꿉니다"
      }
    ]
  }
}
```
<callout icon="🔑" color="blue_bg">
	**`previewToken`**** 은 서버에 저장하는 값이 아닙니다** (2026.08.23 · F09 구현에서 확정).
	미리보기가 본 **일정 그 자체를 해싱한 값**(`pv_` + sha256 앞 12자리)입니다. 확정 요청이 이 값을 되돌려주면 서버가 현재 일정으로 다시 계산해 맞춰 보고, 다르면 `PATCH_STALE`로 거절합니다 (EX-PA-002).
	토큰 표를 두지 않는 이유는 F08이 **아무것도 저장하지 않는다**는 전제를 지키기 위해서입니다. 만료 청소라는 운영 부담도 생기지 않습니다 — 정작 알고 싶은 것은 만료가 아니라 **일정이 그대로인가**이기 때문입니다.
	충돌이 있어도 토큰은 그대로 내려갑니다. 충돌은 선택의 문제고 토큰은 일정의 문제라, 사용자가 하나를 해제하고 바로 확정할 수 있어야 합니다.
	확정 요청에서 `previewToken`을 **생략하면** 이 검사만 건너뜁니다. 충돌 검사와 대상 소실 검사는 그대로 걸립니다.
</callout>
**충돌 검사 3항목** (FR-PA-005)
<table fit-page-width="true" header-row="true">
<tr>
<td>`kind`</td>
<td>검사 내용</td>
</tr>
<tr>
<td>`SAME_ITEM`</td>
<td>같은 일정 항목을 둘 이상의 수정안이 동시에 변경</td>
</tr>
<tr>
<td>`TIME_COLLISION`</td>
<td>반영 후 같은 시간대에 둘 이상의 일정이 배치됨</td>
</tr>
<tr>
<td>`ORDER_DEPENDENT`</td>
<td>반영 순서에 따라 결과가 달라짐</td>
</tr>
</table>
```json
// POST /api/v1/products/31/patch-applications  (요청)
{
  "previewToken": "pv_7f21a9",
  "selections": [ /* 미리보기와 동일 */ ]
}

// 202 Accepted (응답)
{
  "patchApplicationId": 44,
  "beforeAuditRunId": 812,
  "reauditJobId": 5502,
  "pollIntervalMs": 2000
}
```
`previewToken`이 만료되었거나 그 사이 일정이 변경되었으면 **409 ****`PATCH_STALE`** 로 거부합니다.
## 5-9. 전후 비교
```json
// GET /api/v1/products/31/comparison
{
  "patchApplicationId": 44,
  "before": { "auditRunId": 812, "executedAt": "2026-09-15T14:32:07+09:00" },
  "after":  { "auditRunId": 815, "executedAt": "2026-09-15T14:41:33+09:00" },
  "metrics": [
    { "key": "blocker",        "label": "차단",          "before": 2,   "after": 0 },
    { "key": "error",          "label": "오류",          "before": 1,   "after": 0 },
    { "key": "warning",        "label": "주의",          "before": 2,   "after": 1 },
    { "key": "unverified",     "label": "확인 불가",     "before": 1,   "after": 1 },
    { "key": "deduction",      "label": "총 감점",       "before": 71,  "after": 7,
      "formulaBefore": "50+10+8+3", "formulaAfter": "0+0+4+3" },
    { "key": "readinessScore", "label": "출시 준비도",   "before": 29,  "after": 93 },
    { "key": "travelMinutes",  "label": "총 이동시간",   "before": 190, "after": 145,
      "sourceBadge": "EXTERNAL_REF", "externalSource": "카카오모빌리티" },
    { "key": "travelMeters",   "label": "총 이동거리",   "before": 86000, "after": 63000,
      "sourceBadge": "EXTERNAL_REF", "externalSource": "카카오모빌리티" },
    { "key": "targetFit",      "label": "수요 적합성",
      "beforeText": "야간·체험 콘텐츠 없음", "afterText": "야간축제 반영" }
  ],
  "warningBanner": null,
  "revertible": true,
  "schedule": {
    "before": [{ "id": 352, "dayNo": 1, "seq": 2, "startTime": "12:00", "endTime": "13:00", "placeLabel": "가람집옹심이", "itemType": "MEAL" }],
    "after":  [{ "id": 352, "dayNo": 2, "seq": 2, "startTime": "10:30", "endTime": "11:30", "placeLabel": "가람집옹심이", "itemType": "MEAL" }]
  }
}
```
`schedule` 은 그 반영이 바꾼 일정이다(UI-S5-003 · FR-PA-042 · #806). 반영 기록의 `before_snapshot` · `after_snapshot` 이라 반영 뒤 사람이 일정을 고쳐도 그 반영이 무엇을 바꿨는지를 보인다. 이름이 빈 줄과 대체한 곳의 이름은 미리보기처럼 **응답에만** 채운다(DR-PR-001). 좌표 · 분류는 내보내지 않는다. 화면은 같은 `id` 끼리 견줘 추가 · 제거 · 변경을 가르고, 순번(`seq`)만 밀린 줄은 변경으로 보지 않는다.
준비도가 하락했거나 차단이 늘어난 경우 **자동 롤백하지 않고** `warningBanner`에 경고 문구를 담고 되돌리기 수단을 제시합니다 (FR-PA-027 · EX-PA-005).
<callout icon="↩️" color="blue_bg">
	**되돌리기는 재검수를 돌리지 않습니다** (2026.08.23 · F09 구현에서 확정).
	되돌린 일정은 `before_audit_run_id`가 판정한 바로 그 일정이라, 이미 있는 결과가 곧 현재 결과입니다. 한 번 더 돌리면 같은 답을 받으려고 공사 호출을 다시 쓰는 셈입니다.
	```json
// POST /api/v1/patch-applications/44/revert  →  200 OK
{ "patchApplicationId": 44, "productId": 31,
  "revertedAt": "2026-09-15T15:02:44+09:00", "restoredAuditRunId": 812 }
	```
	**현재 결과** (#551 · 2026.09.20). 되돌리기가 새 실행을 만들지 않으므로 「가장 최근 실행」과 「지금 일정의 결과」가 갈라집니다. 서버는 상품마다 다음 규칙으로 현재 결과를 정하고, 출시 승인 · 리포트 생성 · 상품 목록의 `latestAudit` · 검수 이력의 `isCurrent` 가 모두 이 값을 씁니다.
	- **검수한 뒤에 사람이 일정을 고쳤으면 → 현재 결과 없음**(#710 · 2026.09.21). 항목 추가 · 수정 · 삭제 · 순서 변경 · 장소 다시 고르기, 그리고 판정을 바꾸는 기본정보(출발일 · 이동수단 · 타깃 · 콘셉트) 변경이다. 일정 항목의 `created_at` · `updated_at` 중 가장 늦은 시각이 마지막 검수가 **저장된** 시각(`audit_run.created_at`)과 그 뒤 반영 · 되돌리기 시각보다 5초 넘게 뒤면 그렇게 본다(앱 시계와 DB 시계가 섞이는 자리의 여유). 삭제는 흔적이 없어 남은 항목의 `updated_at` 을 올린다. 출시 승인은 403 「검수한 뒤에 일정이 바뀌었습니다. 다시 검수한 뒤 출시해 주세요.」, `latestAudit.releasable` 은 false, 상품 상세의 `auditState` 는 `{ kind: "STALE", reason: "EDIT" }` 다. 이름 · 인원 변경은 해당하지 않는다
	- **항목이 하나도 없으면 출시 승인은 403 「일정이 비어 있습니다. 장소를 담고 검수한 뒤 출시해 주세요.」**(#738 · 2026.09.22). 항목을 전부 지우면 남은 행이 없어 위의 시각 비교가 「바뀌지 않음」 이 된다 — 출시 게이트가 항목 수를 따로 본다.
	- 가장 최근 실행 뒤에 되돌리기가 있으면 → 그 반영의 `before_audit_run_id`
	- 가장 최근 실행 뒤에 확정만 있으면(재검수 전 · 실패) → 현재 결과 없음. 출시 승인은 403, `latestAudit.releasable` 은 false
	- 그 밖에는 → 가장 최근 실행
	가장 최근 실행만 보던 때는 차단을 없앤 수정안을 확정 · 재검수한 뒤 되돌린 일정이 출시 승인을 통과했습니다(2026-09-11 감사 치명 1번). 반영 · 되돌리기만 일정 변경으로 보던 때는 검수 100점 → 일정 편집으로 식사를 03:00 으로 옮김 → 재검수 없이 출시 승인이 통과했습니다(2026-09-21 운영 · 다시 검수하면 차단 1). 트리거 `trg_check_release` 는 가장 최근 실행 기준 그대로 마지막 방어선으로 둡니다. 스키마 변경은 없습니다.
	`after_audit_run_id`가 비어 있는 이력은 자동 재검수가 아직 안 끝났거나 실패한 상태입니다 (EX-PA-004). 이때는 **사용자가 다시 누른 검수**가 그 자리를 채웁니다 — 확정이 부른 검수만 붙이도록 좁히면 한 번 실패한 이력은 영영 전후 비교를 못 합니다. 되돌린 이력은 대상에서 제외합니다. 그 "적용 후 일정"이 더는 존재하지 않기 때문입니다.
</callout>
## 5-10. 규칙 목록
```json
// GET /api/v1/rules
{
  "rulesetVersion": "v1.3.0",
  "rules": [
    { "code": "R01", "name": "휴무일 · 운영시간 충돌", "version": "1.0.0",
      "defaultSeverity": "BLOCKER",    "requiresExternal": false, "basis": "KTO_ONLY" },
    { "code": "R02", "name": "행사기간 불일치",       "version": "1.0.0",
      "defaultSeverity": "BLOCKER",    "requiresExternal": false, "basis": "KTO_ONLY" },
    { "code": "R03", "name": "일정 시간 중복",         "version": "1.0.0",
      "defaultSeverity": "ERROR",      "requiresExternal": false, "basis": "ITINERARY_ONLY" },
    { "code": "R04", "name": "콘텐츠 편중",            "version": "1.0.0",
      "defaultSeverity": "WARNING",    "requiresExternal": false, "basis": "KTO_ONLY" },
    { "code": "R05", "name": "데이터 검증 불가",       "version": "1.0.0",
      "defaultSeverity": "UNVERIFIED", "requiresExternal": false, "basis": "KTO_ONLY" },
    { "code": "R06", "name": "데이터 변경 감지",       "version": "1.0.0",
      "defaultSeverity": null,         "requiresExternal": false, "basis": "KTO_ONLY" },
    { "code": "R07", "name": "식사 · 휴식 누락",       "version": "1.0.0",
      "defaultSeverity": "WARNING",    "requiresExternal": false, "basis": "ITINERARY_ONLY",
      "dataSources": ["ITINERARY"], "threshold": "연속 6시간 · 식사 60분",
      "example": "12:00 점심 45분은 최소 60분보다 짧습니다", "companyAdjustable": true },
    { "code": "R08", "name": "이동시간 부족",          "version": "1.0.0",
      "defaultSeverity": "ERROR",      "requiresExternal": true,  "basis": "KTO_PLUS_EXTERNAL" },
    { "code": "R09", "name": "우천 리스크",            "version": "1.0.0",
      "defaultSeverity": "WARNING",    "requiresExternal": true,  "basis": "KTO_PLUS_EXTERNAL" },
    { "code": "R10", "name": "상품 타깃-콘텐츠 적합성", "version": "1.0.0",
      "defaultSeverity": "WARNING",    "requiresExternal": false, "basis": "KTO_ONLY" }
  ]
}
```
`R06`의 `defaultSeverity`가 `null`인 것은 등급이 변경 내용에 따라 결정되기 때문입니다. 비표출 전환(R06-b)은 독립 코드가 아니라 R06 내부 판정이며 항상 `BLOCKER`입니다.
`dataSources` · `threshold` · `example` · `companyAdjustable` 은 **모든 규칙에 붙습니다**(예시는 R07 만 펼침). 검수 기준 탭의 규칙 설명이 이 값을 씁니다. `dataSources` 는 `KTO`(관광정보) · `ITINERARY`(일정) · `KAKAO`(이동 시간) · `KMA`(날씨 예보)의 조합이고, 화면은 서비스 이름 대신 괄호 안의 말로 적습니다. `companyAdjustable` 은 R07 만 `true` 입니다 (FR-OP-025).
## 5-11. 호출 예산
```json
// GET /api/v1/usage/budget
{
  "quotaDate": "2026-09-15",
  "dailyQuota": 800,
  "used": 214,
  "usageRatio": 0.268,
  "state": "NORMAL",
  "batchAutoStopped": false,
  "topOperations": [
    { "operation": "searchKeyword2",  "count": 72 },
    { "operation": "detailIntro2",    "count": 64 },
    { "operation": "detailCommon2",   "count": 64 },
    { "operation": "locationBasedList2", "count": 9 },
    { "operation": "searchFestival2", "count": 5 }
  ],
  "resetAt": "2026-09-16T00:00:00+09:00"
}
```
`state` 열거값 — `NORMAL` · `WARN`(80% 이상, 자동 배치 중지) · `EXHAUSTED`(100%, 신규 검수 차단)
`dailyQuota`는 계정별 값이 아니라 전역 `system_setting.daily_quota`이며, `used`는 당일 전역 `api_call_log` 합산이다. **데모 계정을 포함한 전 계정이 같은 예산을 공유한다.**
## 5-12. UI 데이터 조달 원칙
<callout icon="🧭" color="blue_bg">
	**원칙 — 미리 부르지 말고, 볼 때 그것만 부른다.**
	공사 원문을 DB에 저장하지 않는다고 해서 모든 화면이 매번 API를 부르는 것은 아닙니다. 대부분의 화면은 **0콜**입니다.
	검수 결과 목록·일정표·전후 비교·알림은 전부 자체 데이터로 그려지고, **공사 원문이 실제로 화면에 필요한 순간에만 그 1건을 호출**합니다.
</callout>
### 세 가지 데이터 소스
<table fit-page-width="true" header-row="true">
<tr>
<td>소스</td>
<td>예시</td>
<td>비용</td>
</tr>
<tr color="green_bg">
<td>**사용자 입력**</td>
<td>`place_label` · 상품명 · 일정 시각 · 타깃·콘셉</td>
<td>**0콜.** 공사 원문이 아니므로 자유롭게 저장·표시</td>
</tr>
<tr color="green_bg">
<td>**자체 산출물**</td>
<td>`finding.message` · 등급 · 점수 · `normalized_json` · 지문</td>
<td>**0콜.** DB에 있음</td>
</tr>
<tr color="orange_bg">
<td>**공사 원문**</td>
<td>공식 명칭·주소 · `restdate`/`usetime` 문장 · 문의처 · 이미지</td>
<td>**그 순간 호출.** lazy load 원칙 적용</td>
</tr>
</table>
### 화면별 조달 방식
<table fit-page-width="true" header-row="true">
<tr>
<td>화면</td>
<td>공사 원문 필요</td>
<td>조달 방법</td>
<td>콜 수</td>
</tr>
<tr>
<td>1 홈 (내 상품)</td>
<td>❌</td>
<td>DB — 준비도·등급 건수·알림 건수 · 기획 중(`planned_at`) · 출시(`released_at`)</td>
<td>**0**</td>
</tr>
<tr>
<td>2 상품 기획 (등록 · 편집)</td>
<td>⚠️ 대체·추가된 항목 · 장소 담기로 넣은 항목만</td>
<td>`place_label`. 패치로 콘텐츠가 바뀐 항목과 장소 담기로 넣어 라벨이 빈 항목은 이름을 그 순간 조회</td>
<td>0 ~ 해당 건수</td>
</tr>
<tr>
<td>2 ↳ 장소 찾기 (자동완성) · 확정</td>
<td>✅</td>
<td>장소 칸에 입력할 때 `searchKeyword2`, 고르면 확정 (그 순간 호출)</td>
<td>입력당 1 + 확정 1</td>
</tr>
<tr>
<td>2 ↳ 장소 정보 한 줄</td>
<td>✅</td>
<td>고른 직후 그 항목만 `detailIntro2`  • 앞 항목과의 구간 카카오모빌리티(양쪽 좌표가 있을 때만)</td>
<td>고르기당 1 + 카카오 1</td>
</tr>
<tr>
<td>2 ↳ 장소 담기</td>
<td>✅</td>
<td>종류 칩 수 6 · 식당 · 카페 · 숙소 칩 3(누를 때만) · 무장애 · 반려동물 지역 목록 2 · 종류별 목록 4~5 · 카드 펼침 12 안팎. 메모리 10분 캐시</td>
<td>기획 1건 **28 안팎**</td>
</tr>
<tr>
<td>2 ↳ 기획 에이전트</td>
<td>✅</td>
<td>누를 때만. 고르지 않은 줄마다 `searchKeyword2` · `detailCommon2`. 예산 100% 게이트는 검수와 같음</td>
<td>줄마다 0~2 + LLM 1회</td>
</tr>
<tr color="blue_bg">
<td>**3 검수 결과 목록**</td>
<td>⚠️ 대체·추가된 항목만</td>
<td>`finding.message`가 DB에 저장됨. 일정 항목 라벨은 상품 상세를 그대로 따름</td>
<td>0 ~ 대체·추가 건수</td>
</tr>
<tr color="blue_bg">
<td>**3 ↳ "판단 근거 보기" 클릭**</td>
<td>✅</td>
<td>**클릭한 그 1건만** `detailIntro2`</td>
<td>**1**</td>
</tr>
<tr>
<td>3 확인 필요 목록</td>
<td>✅</td>
<td>펼칠 때 항목별 lazy load</td>
<td>항목당 1</td>
</tr>
<tr>
<td>3 ↳ 검수 에이전트</td>
<td>⚠️ 문의처만</td>
<td>누를 때만. 확인 필요 목록 · finding · 항목은 DB, 문의처는 곳마다 `content-view` 연락처(10분 캐시)</td>
<td>곳마다 최대 1 + LLM 1회</td>
</tr>
<tr>
<td>4 패치</td>
<td>⚠️ 대체 관광지만</td>
<td>`REPLACE_CONTENT` 수정안의 `ktoContentId` 조회</td>
<td>0~3</td>
</tr>
<tr>
<td>5 전후 비교</td>
<td>⚠️ 대체된 항목만</td>
<td>스냅샷 + `place_label`. 대체된 항목은 이름을 그 순간 조회</td>
<td>0 ~ 대체 건수</td>
</tr>
<tr color="orange_bg">
<td>**6 PDF 리포트**</td>
<td>✅ 전량</td>
<td>생성 요청 시 재조회 (공식 명칭 + 원문 근거 필수). 콘텐츠당 `detailCommon2`  • `detailIntro2` **2콜**</td>
<td>**콘텐츠 수 × 2** (8곳이면 16)</td>
</tr>
<tr>
<td>7 레이더·알림</td>
<td>❌</td>
<td>`affectedItemIds` → `place_label` 조인. 수요 신호 · 관심 지역 새 소식은 배치가 산출한 `demand_signal`</td>
<td>**0**</td>
</tr>
<tr>
<td>7 ↳ 관심 지역 새로고침</td>
<td>✅</td>
<td>배치가 꺼진 기간에만 사용자 요청으로 T1 · T2 · T3 산출</td>
<td>지역당 3</td>
</tr>
<tr>
<td>7 ↳ 레이더 에이전트</td>
<td>❌</td>
<td>누를 때만. 레이더 요약 · 변경 · 알림 · 관심 지역 새 소식 · 상품 목록(모두 DB)</td>
<td>0 + LLM 1회</td>
</tr>
<tr>
<td>8 검수 기준</td>
<td>❌</td>
<td>표준 3표(체류시간 · 실내외 · R10 63행)는 `packages/shared` 시드를 화면이 직접 읽음. 회사 기준 · 변경 이력 · 관심 값은 `GET /settings`(DB)</td>
<td>**0** (shared 시드)</td>
</tr>
</table>
<callout icon="📐" color="gray_bg">
	**왜 3번 화면을 접어두는가**
	3단 병기를 8개 전부 펼쳐놓으면 화면 진입 시마다 8콜이 나가고, 하루 20번만 열어도 160콜입니다. 접어두면 차단 2건의 근거만 확인해도 **2콜**입니다.
	이건 UX적으로도 낫습니다 — 근거 3단을 8개 펼쳐놓으면 화면이 읽히지 않습니다.
	예상 호출량 — 결과 화면 20회 열람 0콜 · 근거 10건 클릭 10콜 · 확인 필요 5건 5콜 · 패치 3회 9콜 · 리포트 2건 32콜 = **하루 약 56콜** (예산 800 기준 7%)
	리포트는 애초에 8콜로 적었으나 실측에서 콘텐츠당 2콜이었습니다 — `detailIntro2` 응답에 `title` 이 없고 `detailCommon2` 응답에 판정 필드가 없어(픽스처 대조) 공식 명칭과 원문 근거를 둘 다 실으려면 두 오퍼레이션이 모두 필요합니다.
</callout>
<callout icon="🧾" color="gray_bg">
	**기획 화면의 호출량** (8곳 기준 추정)
	장소 찾기 · 확정 16콜 + 장소 정보 한 줄 8콜(구간 카카오 별도) + 검수 29콜 = 약 53콜입니다. 장소 담기를 적극적으로 쓰면 28콜 안팎이 더해집니다.
	기획 에이전트는 줄마다 0~2콜(8줄 예시 9콜)이며 사람이 검색어를 고쳐 가며 부르던 검색 몫을 대신하므로 공사 호출 총량은 거의 늘지 않습니다. 검수 에이전트는 곳마다 최대 1콜, 레이더 에이전트는 0콜입니다.
	기획 조회와 에이전트의 공사 호출은 검수와 같은 100% 게이트를 지납니다 (8-2).
</callout>
<callout icon="🔒" color="red_bg">
	**응답에 싣는 것과 저장하는 것은 다릅니다.**
	공사 원문(`ktoRaw`)과 `patches[].label`은 **근거 펼침 · 패치 화면 · 리포트 생성 등 필요한 시점의 응답에만** 실시간 조회 값으로 조립해 싣습니다. finding 목록 응답에는 포함하지 않으며(0콜 원칙), **DB에는 남지 않습니다.**
	저장되는 것은 `type` · `payload` · `reasonCode` 같은 구조화된 값뿐입니다 (DB 명세서 4-3 · 4-5절).
</callout>
<callout icon="🏷" color="gray_bg">
	**대체·추가된 항목의 이름은 0콜에서 빠집니다** (FR-PA-003 · DR-PR-001)
	`itinerary_item.place_label`은 사용자가 입력한 장소명입니다. `REPLACE_CONTENT`는 자리를 두고 콘텐츠만 바꾸므로 저장된 라벨이 그대로 남고, `INSERT_ITEM`은 빈 라벨로 들어옵니다. 대체 후보의 명칭은 공사 원문이라 저장할 수 없기 때문입니다. 장소 담기로 넣은 항목도 같습니다 — 공식 명칭을 칸에 복사하면 원문을 저장하게 되므로 `place_label` 을 비워 두고(CONFIRMED 항목만 허용, DR-IN-013) 표시할 때 조회합니다.
	그래서 일정 항목을 그리는 화면(2 · 3 · 5)은 **콘텐츠가 바뀌었거나 라벨이 빈 항목에 한해** 이름을 그 순간 조회해 응답에만 얹습니다. 저장은 그대로입니다. 패치하거나 장소 담기로 넣은 적 없는 상품은 종전대로 0콜입니다.
	못 읽으면 저장된 라벨을 그대로 둡니다 — 이름을 지어내지 않습니다.
	걷기 길 항목은 라벨 없이 `walk_id` 만 저장되므로, 두루누비 걷기 길 전국 목록(1콜 · 10분 메모리 캐시)에서 식별자로 이름을 찾아 얹고 못 찾으면 "걷기 길"로 둡니다 (DR-MD-005 · EX-PL-011).
</callout>
---
# 6. 검수 실행 파이프라인
## 6-1. 처리 흐름
```plain text
POST /products/{id}/audit-jobs
        │
        ├─ 사전 검증 : PENDING 매칭 존재 → 422 PLACE_UNRESOLVED
        │              진행 중 작업 존재 → 202 + 기존 jobId
        │              예산 100% 소진   → 429 BUDGET_EXHAUSTED
        │              계정당 분당 5회 초과 → 429 RATE_LIMIT_EXCEEDED + Retry-After
        │                                  (검수 시작과 한 창 · 공개 테스트 계정 제외 · 3-4)
        │
        ├─ audit_job INSERT (QUEUED) ──→ 202 + jobId  [p95 500ms]
        │
        ▼ 스케줄러가 큐에서 소비 (동시 RUNNING 최대 3건)
   ┌────────────────────────────────────────────────────┐
   │ 1) 대상 수집                                        │
   │    CONFIRMED 일정 항목의 고유 contentid 목록        │
   │    progress_total 설정                              │
   ├────────────────────────────────────────────────────┤
   │ 2) 공사 데이터 조회  ★ 관광지 단위 병렬 (기본 8)     │
   │    detailCommon2 + detailIntro2 (+ searchFestival2) │
   │    동일 contentid 중복 호출은 실행 내 캐시로 1회     │
   │    실패 → 지수 백오프 2회 재시도 → KTO_FETCH_FAILED  │
   │    progress_done 갱신 (폴링 응답에 반영)             │
   ├────────────────────────────────────────────────────┤
   │ 3) 지문 생성 + 정규화                                │
   │    field_hash = sha256(판정 필드 원문, 전처리 없음)  │
   │    OperatingInfoParser → normalized_json            │
   │    직전 지문과 비교 → R06 입력 생성                  │
   ├────────────────────────────────────────────────────┤
   │ 4) 외부 데이터 조회  ★ 구간 단위 병렬                │
   │    카카오모빌리티 (R08) · 기상청 (R09)               │
   │    실패 → 해당 구간/규칙만 확인 불가                 │
   ├────────────────────────────────────────────────────┤
   │ 5) ItineraryContext 조립  ← 여기까지가 I/O           │
   ├────────────────────────────────────────────────────┤
   │ 6) 규칙 평가 R01~R10  ★ 메모리 상에서만              │
   │    차단이 나와도 전 규칙 완주                        │
   │    규칙 내부에서 외부 호출 금지                      │
   ├────────────────────────────────────────────────────┤
   │ 7) 등급 · 출시 준비도 산출                           │
   │    실패 콘텐츠 50% 초과 → is_partial, 점수 NULL      │
   │    weight_snapshot · setting_snapshot 기록          │
   ├────────────────────────────────────────────────────┤
   │ 8) 수정안 생성  ← 판정 이후 별도 단계                │
   │    locationBasedList2 최대 4콜 (대체 · 추가 관광지)  │
   │    상한은 차단 → 오류 → 주의 → 확인 불가 순으로 쓴다 │
   │    R10 야간 자리만 detailIntro2 최대 4콜 (운영 확인) │
   ├────────────────────────────────────────────────────┤
   │ 9) 저장                                             │
   │    audit_run + finding + content_fingerprint        │
   │    audit_job.status = DONE, audit_run_id 연결        │
   └────────────────────────────────────────────────────┘
```
<callout icon="⚡" color="orange_bg">
	**p95 목표(8곳 15초 · 12곳 20초)를 달성하는 지점은 2단계와 4단계의 병렬화입니다.**
	검수 1건은 공사 OpenAPI 약 29회(1박 2일 8곳)~43회(2박 3일 12곳) 호출이 필요해 순차 실행으로는 목표를 맞출 수 없습니다. 동시 실행 수는 환경변수로 조정 가능하며 **기본값 8**입니다 (NF-PF-010).
	6단계를 메모리 전용으로 못 박은 것도 성능뿐 아니라 **결정론성**을 위한 것입니다. 규칙이 개별적으로 외부를 호출하면 같은 입력에 다른 결과가 나올 수 있습니다.
	외부 API가 느려 목표 시간(8곳 15초 · 12곳 20초)을 넘겨도 **검수를 중단하지 않고 완료까지 진행**하며 진행률을 계속 갱신합니다. 응답 시간 초과 자체는 실패가 아닙니다 (EX-EI-027).
</callout>
## 6-2. 부분 성공 격리
실패는 가능한 가장 작은 단위로 격리하고, 아래로 확대하지 않습니다.
<table fit-page-width="true" header-row="true">
<tr>
<td>단위</td>
<td>처리</td>
<td>대표 사유코드</td>
</tr>
<tr>
<td>`FRAGMENT` 조각</td>
<td>`unparsed` 기록 · 해당 필드만 확인 불가</td>
<td>`PARSE_REFERENCE` `LLM_UNAVAILABLE`</td>
</tr>
<tr>
<td>`CONTENT` 콘텐츠</td>
<td>해당 콘텐츠만 확인 불가 · 나머지 정상 판정. **예외** — 조회가 `CONTENT_NOT_FOUND` 이고 배치가 그 상품의 알림에 표출 중단(`body.hidden`)을 가장 최근 기록으로 남긴 콘텐츠는 확인 불가가 아니라 R06-b 차단(`CONTENT_HIDDEN`)이고, 조회 실패 수에 넣지 않는다(#745 · FR-RU-065).</td>
<td>`KTO_FETCH_FAILED` `CONTENT_NOT_FOUND`</td>
</tr>
<tr>
<td>`SEGMENT` 구간</td>
<td>해당 구간만 확인 불가 (R08)</td>
<td>`ROUTE_NOT_FOUND` `TRANSIT_NOT_SUPPORTED`</td>
</tr>
<tr>
<td>`RULE` 규칙</td>
<td>해당 규칙만 확인 불가 · 타 규칙 정상 수행</td>
<td>`ROUTE_PROVIDER_FAILED` `CLIMATE_DATA_MISSING`</td>
</tr>
<tr>
<td>`ITEM` 일정 항목</td>
<td>항목 유지 + 검수 제외 배지 · 감점 없음</td>
<td>`PLACE_NOT_FOUND`</td>
</tr>
<tr color="orange_bg">
<td>`PRODUCT` 상품</td>
<td>**부분 검수 표시 · 점수 미산출.** 실패 콘텐츠 50% 초과가 유일한 자동 승격 조건</td>
<td>`AUDIT_PARTIAL`</td>
</tr>
<tr>
<td>`REQUEST` 요청</td>
<td>거부 + 사유 안내 · 데이터 변경 없음</td>
<td>`FORBIDDEN_ACTION` `PATCH_CONFLICT`</td>
</tr>
<tr>
<td>`BATCH` 배치</td>
<td>실패 기록 · `last_covered` 미갱신 · 다음 회차 복구</td>
<td>`BATCH_EMPTY` `BATCH_HIDDEN_OVERFLOW`</td>
</tr>
</table>
## 6-3. 규칙 인터페이스
```java
public interface AuditRule {
    String   code();              // "R01"
    String   version();           // "1.0.0"
    Severity defaultSeverity();   // BLOCKER | ERROR | WARNING | UNVERIFIED | null
    boolean  requiresExternal();  // true면 "외부 참고" 배지 자동 부착

    List<Finding> evaluate(ItineraryContext ctx);
}
```
<table fit-page-width="true" header-row="true">
<tr>
<td>보장</td>
<td>구현 방법</td>
</tr>
<tr>
<td>신규 규칙 추가 시 기존 규칙 코드 무수정</td>
<td>`RuleRegistry`가 구현체를 스캔해 등록. 규칙 간 직접 참조 금지 (NF-MT-002)</td>
</tr>
<tr>
<td>외부 데이터 사용 여부의 시각적 분리</td>
<td>`requiresExternal()`이 true면 `finding.requiresExternal`이 자동으로 true가 되고 화면에 배지가 붙음 (FR-AU-033)</td>
</tr>
<tr>
<td>판정 결정론성</td>
<td>`evaluate()`는 순수 함수. `ItineraryContext` 외의 입력(시계·난수·외부 호출) 금지 (NF-MT-001)</td>
</tr>
<tr>
<td>차단 발생 후에도 전 규칙 완주</td>
<td>`AuditRunner`가 예외를 규칙 단위로 잡고 다음 규칙을 계속 실행 (FR-AU-031 · EX-AU-006)</td>
</tr>
</table>
`ItineraryContext`가 담는 것 — 상품 기본정보 · 일정 항목 목록 · `contentid`별 조회 결과와 정규화 결과 · 직전 지문 · 구간별 경로 산출값 · 강수 지표 · 설정값(가중치·임계치·체류시간·실내외 매핑·기대 프로파일).
## 6-4. 운영정보 해석 파이프라인
```plain text
공사 API 원문 (restdate / usetime 계열, contentTypeId별 필드 분기)
     ↓
[0] 전처리      서식 접두 기호(※ · -)와 앞뒤 공백 제거
                ★ 전처리는 해석 입력에만 적용. 지문은 항상 가공하지 않은 원문으로 생성
     ↓
[1] 구분자 분해  '/'  ','  '·' 로 쪼개 여러 규칙을 분리
     ↓ 조각 단위로
[2] 사전 파서    실측 기반 정규식 16종을 우선순위 순으로 평가
                (LLM 호출 없음 · 빠르고 재현 가능)
     ↓ 실패한 조각만
[3] LLM 정규화   스키마 고정 JSON 출력 · 실패 시 1회 재시도
     ↓
[4] 조각 병합    배열형 휴무 필드는 합집합. 같은 요일에 상충 조각이 있으면
                항목을 만들지 않고 unparsed(CONDITIONAL)로 기록 — 임의 선택 금지
     ↓
[5] 스키마 검증  실패 시 normalized_json = NULL · parse_confidence = UNPARSED
     ↓
[6] 규칙엔진 판정  ★ AI는 여기 관여하지 않음
     ↓
[7] 화면 표시    판정 + 정규화 결과 + 공사 원문 3단 병기
```
<callout icon="🎯" color="green_bg">
	**커버리지 목표 90% 이상** — 커버리지 = 해석 성공 조각 ÷ (전체 − 결측)이며 결측은 분모에서 제외한다(FR-AU-004 · DR-TD-003). 분모는 휴무일 239건 · 운영시간 266건, 통과선은 216건 · 240건이다. (착수 시점 휴무일 85.8% · 운영시간 76.7%).
	회귀 테스트는 실측 287건(`operating_info.csv`)을 정답 데이터셋으로 사용하며 인공 데이터로 대체하지 않습니다. 골든 케이스 3건은 스키마·파서 변경 시 반드시 통과해야 합니다 (DR-TD-001~003 · NF-MT-007).
	커버리지 90% 달성 시 **LLM 호출은 전체 조각의 10% 이하**가 됩니다 (EI-LM-005 · NF-PF-013).
</callout>
---
# 7. 외부 어댑터 설계
## 7-1. 공통 정책
<table fit-page-width="true" header-row="true">
<tr>
<td>항목</td>
<td>정책</td>
<td>근거</td>
</tr>
<tr>
<td>호출 위치</td>
<td>**서버에서만.** 브라우저 직접 호출 금지</td>
<td>PM-SC-002 · EI-CM-001</td>
</tr>
<tr>
<td>인증키</td>
<td>환경변수 주입. 소스·리포·로그·오류 메시지·API 응답 노출 금지</td>
<td>EI-CM-002 · NF-SC-007</td>
</tr>
<tr>
<td>계층</td>
<td>연동점별 **어댑터 경유.** 규칙엔진·컨트롤러의 직접 호출 금지</td>
<td>EI-CM-003 · NF-MT-003</td>
</tr>
<tr>
<td>타임아웃</td>
<td>연결 3초 · 응답 10초. 환경변수로 조정 가능</td>
<td>EI-CM-004</td>
</tr>
<tr>
<td>재시도</td>
<td>지수 백오프 최대 2회 (LLM만 1회). 실패 시 해당 단위 확인 불가 확정</td>
<td>EI-CM-005</td>
</tr>
<tr>
<td>계측</td>
<td>전 호출을 `api_call_log`에 기록. 공사 호출은 예산 카운트 합산</td>
<td>EI-CM-006 · NF-OB-001</td>
</tr>
<tr>
<td>장애 전파</td>
<td>화면 전체가 실패하지 않고 **해당 데이터 영역만 대체 문구** 처리</td>
<td>EI-CM-007 · NF-AV-006</td>
</tr>
</table>
## 7-2. 한국관광공사 OpenAPI 어댑터
<table fit-page-width="true" header-row="true">
<tr>
<td>항목</td>
<td>값</td>
</tr>
<tr>
<td>베이스 URL</td>
<td>국문 관광정보 `https://apis.data.go.kr/B551011/KorService2`. 새 서비스 5종(반려동물 동반여행정보 · 무장애 여행 정보 · 관광지별 연관 관광지 정보 · 두루누비 · 빅데이터 지역별 방문자수)은 서비스마다 베이스 URL 이 따로이며 외부 연동 요구사항 3-1 이 정본이다(`KorPetTourService2` · `KorWithService2` · `TarRlteTarService1` · `Durunubi` · `DataLabService`)</td>
</tr>
<tr>
<td>서비스별 transport</td>
<td>`HttpKtoTransport` 가 `KTO_SERVICE_OF[operation]`(KOR · PET · WITH · RELATED · DURUNUBI · VISITOR)으로 베이스 URL 을 고른다. PET 은 KOR 과 다른 서비스(`KorPetTourService2`)라 한도도 따로다. 무장애 · 반려동물의 지역 목록은 국문과 오퍼레이션 이름이 같아(`areaBasedList2`) `KTO_OPERATIONS` 에서는 서비스를 붙인 이름(`withAreaBasedList2` · `petAreaBasedList2`)으로 구분하고 `KTO_OPERATION_PATH` 로 실제 경로를 고른다. 서비스별 `KTO_BASE_URL_*` 환경변수는 선택. `KtoClient.call()` 이 같은 표로 `api_call_log.provider` 를 골라 기록한다(8-2)</td>
</tr>
<tr>
<td>인증</td>
<td>쿼리 파라미터 `serviceKey` — 공공데이터포털 일반 인증키 **Decoding**</td>
</tr>
<tr>
<td>공통 파라미터</td>
<td>`MobileOS=ETC` · `MobileApp=TourLint` · `_type=json`</td>
</tr>
<tr>
<td>호출 한도</td>
<td>개발계정 1일 1,000건 / 운영계정 1일 100,000건. **활용신청과 하루 한도는 서비스마다 따로**다</td>
</tr>
<tr>
<td>픽스처 (`KTO_MODE=fixture`)</td>
<td>`fixtures/kto/NN_{오퍼레이션}[_접미].json` 실호출 스냅샷을 리플레이한다. `FixtureKtoTransport.buildIndex` 가 파일명에서 오퍼레이션을 읽고, 상세형은 본문 `contentid` 로 색인한다 — 새 상세 오퍼레이션은 `DETAIL_OPERATIONS` 에 등록한다. 조건이 결과를 가르는 목록은 조건을 파일명 접미에 담고 조건까지 맞아야 돌려준다 — 무장애 · 반려동물 지역 목록 `_<시도>_<시군구>`(`22_withAreaBasedList2_51_150.json`), 키워드 검색 · 연관 관광지 `_<키워드>`, 방문자수 `_<시작일>_<종료일>`, 근처 3km `_<분류1>[_<분류2>]`(`27_locationBasedList2_FD.json`). 키워드 검색(`searchKeyword2`)만 그 키워드 스냅샷이 없을 때 기본 스냅샷으로 물러난다. **없는 키는 조용히 대체하지 않고 던진다.** 운영에서는 쓸 수 없다 (FR-OP-009)</td>
</tr>
<tr>
<td>데이터 신선도</td>
<td>국문 콘텐츠는 04:30 이후 최신 반영. 당일 수정분은 익일 조회 (D+1)</td>
</tr>
</table>
**국문 관광정보 오퍼레이션 9종**
이 9종에 새 서비스 5종의 오퍼레이션을 더한 목록 밖은 호출하지 않는다. 더해지는 오퍼레이션 · 파라미터 · 사용 필드는 외부 연동 요구사항 EI-KT-001 · 3-3 · EI-KT-022~026 이 정본이다(2026.09.15 실호출로 확정, `packages/shared` `KTO_OPERATIONS`).
<table fit-page-width="true" header-row="true">
<tr>
<td>#</td>
<td>오퍼레이션</td>
<td>용도</td>
<td>연결 규칙</td>
</tr>
<tr>
<td>1</td>
<td>`searchKeyword2`</td>
<td>관광지 매칭 · 동명 장소 확정 · 기획 에이전트 도구</td>
<td>전 규칙 선행 · F18</td>
</tr>
<tr>
<td>2</td>
<td>`detailCommon2`</td>
<td>좌표 · 수정일자 · 분류체계 · 저작권 유형 · 기획 에이전트의 분류 · 주소 확인 · 검수 에이전트 문의처</td>
<td>R06 · R08 · F18</td>
</tr>
<tr>
<td>3</td>
<td>`detailIntro2`</td>
<td>휴무일 · 운영시간 · 문의처 · 장소 정보 한 줄 · 카드 펼침</td>
<td>**R01 · R05** · F17</td>
</tr>
<tr>
<td>4</td>
<td>`searchFestival2`</td>
<td>행사기간 검증 · 행사 밀도 · 축제 · 공연 종류 · 관심 지역 새 소식</td>
<td>**R02 · T2** · F17</td>
</tr>
<tr color="blue_bg">
<td>5</td>
<td>`areaBasedSyncList2`</td>
<td>**변경 감지 배치 1단계 · 비표출 전환 · 신규 콘텐츠**</td>
<td>**R06 · T1**</td>
</tr>
<tr>
<td>6</td>
<td>`areaBasedList2`</td>
<td>지역별 탐색 · 대체 후보 보강 · 종류 칩 등록 수(`totalCount`) · 장소 담기 목록</td>
<td>수정안 · F13 · F14 · F17</td>
</tr>
<tr>
<td>7</td>
<td>`locationBasedList2`</td>
<td>대체 관광지 추천 (반경 20km 이내) · 장소 담기 가까운 순(20km) · 식당 · 카페 · 숙소 칩(3km)</td>
<td>R01 · R02 · R08 수정안 · F17</td>
</tr>
<tr>
<td>8</td>
<td>`ldongCode2`</td>
<td>법정동 코드 (시도 → 시군구 2단)</td>
<td>F01 · F13 조건 2</td>
</tr>
<tr>
<td>9</td>
<td>`lclsSystmCode2`</td>
<td>분류체계 코드 (대 10 · 중 59 · 소 246)</td>
<td>R04 · R09 · R10 기준표</td>
</tr>
</table>
**`detailIntro2`**** ****`contentTypeId`****별 필드 분기 (실측 확정)**
<table fit-page-width="true" header-row="true">
<tr>
<td>`contentTypeId`</td>
<td>휴무일</td>
<td>운영시간</td>
<td>문의처</td>
</tr>
<tr>
<td>12 관광지</td>
<td>`restdate`</td>
<td>`usetime`</td>
<td>`infocenter`</td>
</tr>
<tr>
<td>14 문화시설</td>
<td>`restdateculture`</td>
<td>`usetimeculture`</td>
<td>`infocenterculture`</td>
</tr>
<tr>
<td>15 축제공연행사</td>
<td>–</td>
<td>`playtime`</td>
<td>`sponsor1tel`</td>
</tr>
<tr>
<td>28 레포츠</td>
<td>`restdateleports`</td>
<td>`usetimeleports`</td>
<td>`infocenterleports`</td>
</tr>
<tr>
<td>32 숙박</td>
<td>– (R01 판정 제외)</td>
<td>`checkintime` / `checkouttime`</td>
<td>`infocenterlodging`</td>
</tr>
<tr>
<td>38 쇼핑</td>
<td>`restdateshopping`</td>
<td>`opentime`</td>
<td>`infocentershopping`</td>
</tr>
<tr>
<td>39 음식점</td>
<td>`restdatefood`</td>
<td>`opentimefood`</td>
<td>`infocenterfood`</td>
</tr>
</table>
**응답 파서가 반드시 처리해야 하는 실측 동작 5가지**
<table fit-page-width="true" header-row="true">
<tr>
<td>동작</td>
<td>처리</td>
<td>근거</td>
</tr>
<tr color="red_bg">
<td>본문이 꺾쇠괄호로 시작 (XML 오류 응답)</td>
<td>**JSON 파싱 오류로 오인하지 않고 인증 실패·쿼터 초과로 분류.** 가장 흔한 오해 지점</td>
<td>EI-KT-002 · EX-EI-001</td>
</tr>
<tr>
<td>0건일 때 `items`가 배열이 아니라 빈 문자열</td>
<td>정상 응답으로 처리. 파싱 오류 취급 금지</td>
<td>EI-KT-004</td>
</tr>
<tr>
<td>1건일 때 `items.item`이 객체, 2건 이상일 때 배열</td>
<td>양쪽 형태 모두 수용</td>
<td>EI-KT-005</td>
</tr>
<tr>
<td>구 코드체계 필드(`areacode` `sigungucode` `cat1/2/3`)</td>
<td>**값이 있어도 읽지 않는다.** 지역은 `lDongRegnCd`, 유형은 `contentTypeId`·`lclsSystm1/2/3`만 사용</td>
<td>EI-KT-006</td>
</tr>
<tr>
<td>`resultCode`가 `0000`이 아님</td>
<td>실패 처리. 쿼터 초과 → 예산 관리자 통지 · 키 오류 → 운영자 알림. **둘 다 재시도하지 않음.** 파라미터 오류(10 · 11 · 12)도 같은 요청은 같은 결과라 재시도하지 않는다. 두루누비는 이 오류를 `response` 봉투 없이 최상위에 준다</td>
<td>EI-KT-003 · EX-EI-002·003</td>
</tr>
</table>
<callout icon="🔬" color="green_bg">
	**실측으로 확정된 오퍼레이션 동작 (구현 전제)**
	`searchFestival2`의 `eventStartDate`는 "그 날짜 이후 시작"이 아니라 **"그 날짜에 아직 종료되지 않은 행사"** 를 반환합니다. 따라서 여행기간 겹침 조회는 `eventStartDate = 여행시작일` 하나로 충분하며 추가 보정 로직이 필요 없습니다.
	`areaBasedSyncList2`의 `modifiedtime`은 **해당일 분만 반환하고 누적되지 않습니다.** 배치는 날짜를 순회 호출해야 합니다.
	`showflag` 미지정 시 표출·비표출이 **모두 반환**되므로 비표출 감지를 위한 별도 호출이 필요 없습니다.
	`numOfRows`는 2000까지 동작하나 안전 마진으로 **1000**을 사용합니다.
	`ldongCode2`의 시도 코드는 길이가 일정하지 않습니다 (세종특별자치시 `36110`, 5자리). **하드코딩 금지, 항상 API 응답 사용.**
</callout>
## 7-3. 카카오모빌리티 길찾기 어댑터 (R08)
<table fit-page-width="true" header-row="true">
<tr>
<td>항목</td>
<td>값</td>
</tr>
<tr>
<td>베이스 URL</td>
<td>`https://apis-navi.kakaomobility.com`</td>
</tr>
<tr>
<td>인증</td>
<td>요청 헤더 `Authorization: KakaoAK {REST_API_KEY}`</td>
</tr>
<tr>
<td>1급 경로</td>
<td>`GET /v1/future/directions` — `departure_time`에 일정 출발 시각을 `YYYYMMDDHHMM`으로 전달</td>
</tr>
<tr>
<td>폴백</td>
<td>`GET /v1/directions` — 출발 시각이 과거이거나 미래 운행 정보 실패 시. 화면에 **"현재 시각 기준"** 표기</td>
</tr>
<tr>
<td>요청 구성</td>
<td>`origin={경도},{위도}` · `destination={경도},{위도}` · `summary=true`. 상세 경로(`roads` `guides`) 미요청</td>
</tr>
<tr>
<td>사용 응답 필드</td>
<td>`routes[0].result_code` · `summary.distance`(m) · `summary.duration`(초). 요금 정보 미사용</td>
</tr>
<tr>
<td>좌표계</td>
<td>WGS84 경도·위도. 공사 `mapx` `mapy`를 **변환 없이 그대로** 사용</td>
</tr>
<tr>
<td>호출 단위</td>
<td>연속한 두 일정 항목의 구간. 관광지 8곳이면 구간 7개 = 7콜. 동일 구간·동일 출발 시각은 실행 내 캐시</td>
</tr>
<tr>
<td>무료 쿼터</td>
<td>자동차 10,000건/일 · 미래 운행 정보 5,000건/일</td>
</tr>
</table>
<callout icon="🚨" color="red_bg">
	**HTTP 200이어도 ****`result_code`****를 반드시 확인합니다.** 0이 아니면 해당 구간을 `ROUTE_NOT_FOUND`로 확인 불가 처리합니다 (EI-KM-005).
	**이동수단이 대중교통이면 아예 호출하지 않고** `TRANSIT_NOT_SUPPORTED`로 확인 불가 처리한 뒤 확인 필요 목록에 등록합니다. 자동차 소요시간으로 대체 제시하지 않습니다 (EI-KM-007).
	**API 전면 장애 시 R08 전체를 확인 불가로 처리하고 검수는 계속합니다. 직선거리 기반 추정으로 대체하지 않습니다** (EI-KM-009). 이것이 구간 → 규칙으로 확대하는 유일한 명시적 예외입니다.
</callout>
## 7-4. 기상 어댑터 (R09)
<table fit-page-width="true" header-row="true">
<tr>
<td>출발일까지</td>
<td>연동점</td>
<td>방식</td>
<td>화면 표기</td>
</tr>
<tr>
<td>D+0 – D+2</td>
<td>기상청 단기예보 조회서비스</td>
<td>실시간 호출 (강수확률 POP만 사용)</td>
<td>"단기예보 기준 — 강수확률 N%"</td>
</tr>
<tr>
<td>D+3</td>
<td>기상청 단기예보 조회서비스</td>
<td>실시간 호출. 그 날 야외 일정 시간대를 덮을 때만 판정</td>
<td>"단기예보 기준 — 강수확률 N%"</td>
</tr>
<tr>
<td>D+4 – D+10</td>
<td>기상청 중기예보 조회서비스</td>
<td>실시간 호출. 오전·오후 강수확률 중 **큰 값**. 대상 일자를 덮는 발표분 선택</td>
<td>"중기예보 기준 — 강수확률 N%"</td>
</tr>
<tr>
<td>D+11 이상</td>
<td>평년 강수일수 (`climate_normal`)</td>
<td>사전 구축 고정 테이블</td>
<td>"평년 기준 — N월 강수일수 N.N일 (N%)"</td>
</tr>
</table>
- 격자 좌표 변환은 **상품 여행 지역 대표 지점 1개**로 수행합니다. 일정 항목별 개별 조회를 하지 않습니다 (EI-WX-002).
- 예보 API 실패 시 **평년 테이블로 자동 강등**하고 표기를 "평년 기준"으로 바꿉니다. R09 전체를 확인 불가로 만들지 않습니다 (EI-WX-006).
- 키 문자열은 공사 인증키와 같은 계정 인증키이고(data.go.kr 은 계정당 키 하나), 서비스별 활용신청으로 인가를 따로 받습니다. 환경변수는 `KMA_SERVICE_KEY` 로 분리합니다 — 어댑터가 다른 연동의 설정을 읽지 않습니다 (EI-WX-001).
- 예보 결과는 발표분 단위로 캐시할 수 있습니다 (단기 1시간 · 중기 12시간). 이 캐시는 자체 판정 입력값이므로 무저장 원칙과 무관합니다 (EI-WX-007).
<callout icon="📊" color="gray_bg">
	**평년 강수일수를 파일로 받아 고정 테이블로 쓰는 것은 축소안이 아니라 정상 구현입니다.** 실시간 호출 의무는 한국관광공사 데이터에만 적용되며(SC-DT-014), 기상자료개방포털 통계는 공공누리 제1유형(출처표시)입니다.
</callout>
## 7-5. LLM 어댑터
<table fit-page-width="true" header-row="true">
<tr>
<td>허용 용도 5가지</td>
<td>금지</td>
</tr>
<tr>
<td>① F01 자연어 일정 구조화<br>② F03 운영정보 정규화 (사전 파서 실패 조각만)<br>③ 장소 찾기 제안 (기획 에이전트)<br>④ 확인 질문 정리 (검수 에이전트)<br>⑤ 오늘 할 일 정리 (레이더 에이전트)</td>
<td>**등급 · 점수 · 충돌 판정에 사용 금지**<br>근거 없이 휴무·운영시간·행사기간 생성 금지<br>판매량·수요 예측 금지<br>데이터 없는데 정상 판정 금지<br>finding 설명 문장 생성 · 에이전트 문장의 `finding.message` 저장 금지<br>에이전트의 상품 · 일정 · 판정 · 알림 변경 금지</td>
</tr>
</table>
- 정규화 호출은 **스키마 고정 JSON 출력**. `temperature` 는 지정하지 않습니다(EI-LM-002 개정 2026.09.10 — 결정론은 `llm_parse_cache` 가 지킵니다). 출력은 스키마 검증을 거치며 불일치 시 확인 불가로 강등합니다.
- 실패·타임아웃 시 **1회 재시도** 후 해당 조각을 확인 불가로 확정하고 검수를 계속합니다.
- 전송 데이터는 해석 대상 원문 조각과 일정 텍스트, 에이전트는 그 상품 · 그 실행의 입력과 도구 결과로 한정합니다. 계정 정보·인증키·타 상품 데이터를 포함하지 않습니다 (EI-LM-009).
- 에이전트는 도구 호출을 주고받는 반복으로 돌리고 에이전트마다 도구 목록 · 반복 상한 · 시간 상한(30초)을 둡니다. 도구 결과에 없던 식별자 · 전화번호는 버리고, 실패 · 시간 초과는 `LLM_UNAVAILABLE` 로 끝내 사람이 하는 길을 막지 않습니다 (EI-LM-007 · 008 · 010, 4-11).
- 에이전트 호출은 도구를 강제하지 않습니다(`tool_choice: auto`) — 강제 호출을 거절하는 모델이 있어 강제하면 모델을 바꿀 수 없습니다. 모델은 조회를 마치면 `submit_result` 도구로 답을 내고, 서버가 그 값을 도구 결과와 대조합니다. 반복 상한 · 시간 상한에 닿거나 도구의 공사 호출이 예산에 막히면 더 조회하지 않고 지금까지의 결과로 답을 한 번 청해 끝난 항목만 받습니다. 한 요청의 응답 대기는 30초이고, 에이전트 턴은 되돌리지 않습니다(실행 전체 30초 안에서 끝내야 해서입니다). 모델은 `LLM_MODEL_AGENT` 하나를 에이전트 셋이 함께 씁니다.
- 제공자·모델명은 환경변수로 관리해 교체 가능하게 두며, 특정 모델의 응답 형식에 파서를 결합하지 않습니다.
<callout icon="🛡" color="blue_bg">
	**프롬프트 주입 방어** — 공사 원문과 사용자 입력은 LLM에 **데이터로만** 전달하고 지시문 영역과 명확히 분리합니다. 스키마 검증을 통과한 값만 사용하며, 실패하면 확인 불가로 강등합니다.
	구조적으로 **LLM 출력이 등급·점수·권한에 직접 영향을 주는 경로가 없으므로**, 주입이 성공해도 영향은 조각 1건의 확인 불가로 갇힙니다 (NF-SC-012 · EX-EI-026).
	에이전트도 읽기 도구만 쓰고 도구 결과 밖 값은 서버가 버리므로, 주입이 성공해도 영향은 사람이 누르기 전의 제안 한 줄에 갇힙니다.
</callout>
---
# 8. 배치와 예산
## 8-1. 자동 경량 배치 (F12)
```plain text
평일 05:00 KST · 주말 미실행 · 개발 기간 중 기본 OFF

[1단계] areaBasedSyncList2 로 변경분 수신
        조회 기준일 = batch_state.last_covered + 1일 ~ 어제 (하루씩 순회)
        numOfRows = 1000
        showflag 미지정 → 표출 · 비표출 모두 수신
        │
        ├─ 조회 0건 (어제 · 평일) → BATCH_EMPTY · last_covered 미갱신
        │                     공사 동기화 지연 신호로 간주
        │                     주말 · 이틀 지난 평일의 0건은 변경 없는 날로 보고 넘어간다
        ├─ 비표출 페이지 상한(20) 초과 → BATCH_HIDDEN_OVERFLOW
        │                     배치 중단 후 등록 상품 contentid 개별 확인으로 전환
        │                     초과는 그 날짜 첫 쪽 totalCount 로 안다 · 그 날에서 순회를 멈춘다
        │                     여행이 끝나지 않은 등록 상품의 contentid 마다 detailIntro2 1콜 (예산 게이트)
        │                     없음 = 표출 중단 알림 · 있음 = 직전 지문 비교(조건 1 과 같은 판정)
        │                     전부 확인해야 last_covered 를 그 날짜로 올린다
        └─ 예산 소진율 80% 도달 → 중단하고 다음 회차로 이월
        │
[2단계] 변경분 중 등록 상품에 포함된 contentid만 상세 재호출
        detailCommon2 + detailIntro2
        │
[3단계] 지문 재생성 → 직전 지문과 비교 → 재판정
        │
[4단계] 영향 상품 탐색 (6조건) → notification 생성
        동일 contentid + 동일 변경 지문 쌍은 재노출하지 않음
        한국 날짜 기준 여행 종료일(출발일+박수)이 지난 상품은 알림 미생성
        같은 시군구 = 시도 코드 + 시군구 코드 일치 (시군구 3자리는 시도마다 다시 쓴다)
        감시 대상(조건 2 ~ 6) — 계정마다 출발일 임박순 상위 10개(BATCH_WATCH_LIMIT). 조건 1 은 상한 없음
        행사 알림은 body.eventPeriod 에 읽어 낸 기간(날짜)을 남긴다 — 원문이 아니다
        조건 1 에서 「판정 필드 그대로」 로 넘긴 상품은 그 콘텐츠의 조건 2 · 3 후보에서 뺀다
        조건 3 — 같은 시군구의 행사만. 상품에 시군구가 없으면 같은 시도, 행사 지역을 모르면 걸지 않음. ±7일 창 없음
        기회(4 ~ 6) — 이번 배치가 본 첫 날짜 뒤에 등록된 표출 콘텐츠만
                      넣을 자리(body.slot · 0콜)를 남기고, 상한 안에 든 것만 배치당 20건까지
                      계정마다 돌아가며 길찾기로 앞뒤 이동을 재 body.precheck 에 남긴다
                      (대중교통 제외 · 제공자 장애면 첫 실패에서 · 60초 상한 · UI-S7-008)
                      바뀐 정보 알림은 사전 확인 전에 넣고 재검수도 먼저 건다
                      R10 결손 유형은 지금 일정의 검수 실행에서, 무시한 R10 은 제외
                      배치 한 번에 상품당 3건까지 (조건 4 먼저 · 같은 조건은 contentid 순)
                      같은 콘텐츠는 한 상품에 한 번만 (change_key NEW:{createdtime})
        │
[성공]  last_covered 갱신 · batch_state 기록
[실패]  last_covered 미갱신 → 다음 회차가 누락 구간 자동 재조회
```
<table fit-page-width="true" header-row="true">
<tr>
<td>시나리오</td>
<td>호출량</td>
</tr>
<tr>
<td>평일 1회 (1단계 1콜 + 2단계 약 3콜)</td>
<td>약 4콜</td>
</tr>
<tr>
<td>월요일 (금·토·일 3일 순회)</td>
<td>약 6콜</td>
</tr>
<tr>
<td>주말</td>
<td>0콜</td>
</tr>
<tr>
<td>상품 1건 온디맨드 검수 (참고)</td>
<td>약 29콜(1박 2일 8곳) · 약 43콜(2박 3일 12곳)</td>
</tr>
<tr>
<td>분류체계 대분류 목록 (부팅 때 1회 · 메모리 캐시)</td>
<td>1콜 — 중분류 59행은 `packages/shared` 상수라 부르지 않는다(EI-KT-015)</td>
</tr>
</table>
## 8-2. 예산 관리자 (F15)
```plain text
BudgetGuard — 공사 API 호출 직전 게이트 (의도 · provider 별)

  소진율 < 80%   → 전부 허용
  80% <= 소진율  → BUDGET_THRESHOLD
                   자동 배치(BATCH)만 즉시 중지
                   사용자 온디맨드 검수(USER_AUDIT) · 기획 조회 · 에이전트(PLAN)는 계속 허용
  소진율 = 100%  → BUDGET_EXHAUSTED
                   신규 검수 · 기획 조회 · 에이전트 차단 (429) + 재개 시점(익일 00:00 KST) 안내
                   기획 화면 안내에는 입력 · 저장은 계속된다는 문구를 더한다
                   진행 중인 검수는 끝까지 완료

공사 응답으로 쿼터 초과가 확인되면 자체 집계보다 우선해
즉시 차단하고 자체 카운터를 실제 값에 맞춰 보정한다.

quota_date는 반드시 KST 기준. UTC로 채우면 집계가 9시간 밀린다.

provider 별로 따로 센다 — 활용신청과 하루 한도가 서비스마다 따로다
  KTO (국문 관광정보)
      소진율 분모 = korDailyQuota(system_setting.daily_quota, 오늘) (전역 1행 · 계정별 예산 없음)
        트래픽 증설 10,000 동안은 DB 값(8,000), 마지막 날 다음 날부터는 DB 값이 800 을 넘어도 800
        마지막 날 = system_setting.kor_quota_raised_until (기본 2026.10.11 · 칸이 없는 DB 도 이 날)
        연장되면 batch_switch.mjs --kor-until 로 날짜만 바꾼다 — 배포가 아니다
        검수 · 배치 · 기획 조회 · 사용량 조회(API)가 모두 BatchStateRepository.setting() 한 곳을 읽는다
      소진율 분자 = 당일 quota_date의 전역 api_call_log(provider=KTO) 합산
        오늘 공사가 한도 초과(result_code 22)로 답한 호출이 있으면 분자 = 분모 — 공사 응답 우선 (EX-QT-005)
        검수 도중 인증 오류 · 한도 초과를 받으면 남은 조회 · 수정안용 조회를 하지 않는다 (EX-EI-002 · 003)
  KTO_PET · KTO_WITH · KTO_RELATED · KTO_DURUNUBI · KTO_VISITOR (새 서비스 5종)
      소진율 분모 = extraServiceDailyCap(service, 오늘) — 각 한도의 80%
        무장애 · 반려동물 · 연관 관광지  8,000  (트래픽 증설 10,000 · 2026.09.17 ~ 10.16)
        두루누비 · 방문자수              800   (개발계정 1,000 그대로)
        증설 종료일 다음 날(10.17)부터 다섯 다 800 으로 돌아간다
      소진율 분자 = 당일 그 provider 합산
  서비스마다 BudgetGuard 인스턴스를 두고, 게이트는 부르려는 서비스의 예산을 본다
  → 새 서비스 호출이 국문 예산을 잠식하지 않는다
  LLM(에이전트) 호출은 provider=LLM · operation=목적으로 세며 공사 예산에 들어가지 않는다
데모 계정 포함 전 계정이 같은 예산을 공유한다 (PM-DA-006 · DR-CF-007).
```
<table fit-page-width="true" header-row="true">
<tr>
<td>의도 (`CallIntent`)</td>
<td>멈추는 경계</td>
<td>쓰는 호출</td>
</tr>
<tr>
<td>`BATCH`</td>
<td>**80%** — `BUDGET_THRESHOLD`</td>
<td>변경 감지 배치 · 신호 배치(관심 지역 포함)</td>
</tr>
<tr>
<td>`USER_AUDIT`</td>
<td>100% — 429 `BUDGET_EXHAUSTED`</td>
<td>사용자가 누른 검수 · 다시 검수 · 패치 확정 뒤 재검수</td>
</tr>
<tr>
<td>`PLAN`</td>
<td>100% — 429 `BUDGET_EXHAUSTED` (`USER_AUDIT` 과 같다)</td>
<td>기획 조회(장소 찾기 · 장소 정보 한 줄 · 장소 담기)와 에이전트의 공사 호출. 경계는 `USER_AUDIT` 과 같고 로그 · 안내 문구를 가르는 값이다</td>
</tr>
</table>
<callout icon="✅" color="green_bg">
	**호출 예산 관리자는 서버의 운영 제어입니다.**
	오늘 호출량·소진율·오퍼레이션별 상위 5개는 운영용으로 집계하며 **사용자 화면에는 두지 않습니다**(2026.09.18 · 이슈 #532). 예산이 모자라 막힐 때만 무엇을 하면 되는지 알려 줍니다. 공공 API를 절제해 쓰는 설계 자체가 서비스의 성숙도를 드러내는 지표입니다 (NF-OB-002 · FR-OP-005).
	다만 응답은 **집계값만** 포함하며 개별 호출의 인증키·파라미터는 노출하지 않습니다 (PM-DA-006 · PM-SC-005).
</callout>
---
# 9. 오류 코드 체계
## 9-1. 사유 코드 43종과 HTTP 매핑
<table fit-page-width="true" header-row="true">
<tr>
<td>코드</td>
<td>단위</td>
<td>HTTP</td>
<td>결과</td>
</tr>
<tr>
<td>`UPLOAD_FORMAT_INVALID`</td>
<td>REQUEST</td>
<td>400 · 201</td>
<td>거부. 확장자 · 내용 · MIME · 파서 실패는 400. 양식 헤더를 못 찾거나 필수 컬럼이 빠지면 201 의 `rejected`(없는 컬럼을 짚는다). 양식 내려받기 링크는 업로드 칸에 늘 있다</td>
</tr>
<tr>
<td>`UPLOAD_ROW_INVALID`</td>
<td>REQUEST</td>
<td>201</td>
<td>부분 수용. 정상 행은 `items`, 실패 행은 `errors[]`(행 번호 · 사유)로 돌려준다 — 응답에 이 코드를 싣지는 않는다</td>
</tr>
<tr>
<td>`UPLOAD_LIMIT_EXCEEDED`</td>
<td>REQUEST</td>
<td>201 · 413</td>
<td>거부. 상한값 안내. 5MB · 500행 · 유효 항목 45건 · 메모 4,000자 초과는 201 의 `rejected`, 20MB 안전망 초과는 413</td>
</tr>
<tr>
<td>`DAY_COUNT_MISMATCH`</td>
<td>PRODUCT</td>
<td>422</td>
<td>검수 시작 거부. 비어 있는 일차 표시(`missingDays`). 업로드 파일의 4일차 이상도 같은 코드로 파일 전체를 거부한다(201 의 `rejected`)</td>
</tr>
<tr>
<td>`NL_STRUCTURE_FAILED`</td>
<td>REQUEST</td>
<td>201</td>
<td>거부 + 직접 입력 유도(201 의 `rejected`). 빈 상품 생성 금지</td>
</tr>
<tr>
<td>`PLACE_NOT_FOUND`</td>
<td>ITEM</td>
<td>200</td>
<td>검수 제외. 항목 유지 · 감점 없음</td>
</tr>
<tr>
<td>`PLACE_UNRESOLVED`</td>
<td>PRODUCT</td>
<td>422</td>
<td>검수 실행 차단</td>
</tr>
<tr>
<td>`PARSE_MISSING`</td>
<td>FRAGMENT</td>
<td>200</td>
<td>확인 불가</td>
</tr>
<tr>
<td>`PARSE_TARGET_VARIES`</td>
<td>FRAGMENT</td>
<td>200</td>
<td>확인 불가</td>
</tr>
<tr>
<td>`PARSE_REFERENCE`</td>
<td>FRAGMENT</td>
<td>200</td>
<td>확인 불가</td>
</tr>
<tr>
<td>`PARSE_CONDITIONAL`</td>
<td>FRAGMENT</td>
<td>200</td>
<td>확인 불가</td>
</tr>
<tr>
<td>`PARSE_SCHEMA_INVALID`</td>
<td>FRAGMENT</td>
<td>200</td>
<td>확인 불가</td>
</tr>
<tr>
<td>`LLM_UNAVAILABLE`</td>
<td>FRAGMENT</td>
<td>200</td>
<td>확인 불가. 검수는 계속. 에이전트(4-11)의 실패 · 시간 초과도 새 코드 없이 이 코드를 쓴다 — 거절하지 않고 200 응답의 `incomplete.reasonCode` 로 알리며 끝난 항목만 돌려준다 (EX-AG-001 · 002)</td>
</tr>
<tr>
<td>`KTO_FETCH_FAILED`</td>
<td>CONTENT</td>
<td>200</td>
<td>해당 콘텐츠만 확인 불가</td>
</tr>
<tr>
<td>`CONTENT_NOT_FOUND`</td>
<td>CONTENT</td>
<td>200</td>
<td>해당 콘텐츠만 확인 불가. 상세 조회가 성공했으나 0건(삭제된 `contentid` 등). 재시도 안 함</td>
</tr>
<tr color="red_bg">
<td>`KTO_AUTH_ERROR`</td>
<td>REQUEST</td>
<td>500</td>
<td>**검수 즉시 중단 · 재시도 안 함 · 운영자 알림**</td>
</tr>
<tr color="red_bg">
<td>`KTO_QUOTA_EXCEEDED`</td>
<td>REQUEST</td>
<td>429</td>
<td>**즉시 중단 · 재시도 안 함 · 재개 시점 안내**</td>
</tr>
<tr color="red_bg">
<td>`CONTENT_HIDDEN`</td>
<td>CONTENT</td>
<td>200</td>
<td>**차단 등급. 명칭·주소·이미지 미노출**</td>
</tr>
<tr>
<td>`COORD_MISSING`</td>
<td>ITEM</td>
<td>200</td>
<td>R08만 확인 불가</td>
</tr>
<tr>
<td>`ROUTE_NOT_FOUND`</td>
<td>SEGMENT</td>
<td>200</td>
<td>해당 구간만 확인 불가</td>
</tr>
<tr>
<td>`ROUTE_PROVIDER_FAILED`</td>
<td>RULE</td>
<td>200</td>
<td>R08 전체 확인 불가. 검수 계속</td>
</tr>
<tr>
<td>`TRANSIT_NOT_SUPPORTED`</td>
<td>SEGMENT</td>
<td>200</td>
<td>확인 불가 + 확인 필요 목록 등록</td>
</tr>
<tr>
<td>`FORECAST_UNAVAILABLE`</td>
<td>RULE</td>
<td>200</td>
<td>평년 테이블로 강등. 표기 변경</td>
</tr>
<tr>
<td>`CLIMATE_DATA_MISSING`</td>
<td>RULE</td>
<td>200</td>
<td>R09만 확인 불가</td>
</tr>
<tr>
<td>`AUDIT_PARTIAL`</td>
<td>PRODUCT</td>
<td>200</td>
<td>부분 검수 · 점수 미산출</td>
</tr>
<tr>
<td>`AUDIT_TIMEOUT`</td>
<td>PRODUCT</td>
<td>200</td>
<td>작업 FAILED 확정. 재실행 가능</td>
</tr>
<tr>
<td>`PATCH_CONFLICT`</td>
<td>REQUEST</td>
<td>409</td>
<td>확정 차단 + 충돌 쌍 지목</td>
</tr>
<tr>
<td>`PATCH_STALE`</td>
<td>REQUEST</td>
<td>409</td>
<td>거부 + 재검토 유도</td>
</tr>
<tr>
<td>`UNDO_UNAVAILABLE`</td>
<td>REQUEST</td>
<td>409</td>
<td>거부. 되돌리기는 직전 1단계까지</td>
</tr>
<tr>
<td>`SETTING_NOT_STRICTER`</td>
<td>REQUEST</td>
<td>400</td>
<td>거부. 회사 기준이 표준보다 느슨함 — 느슨하게 하는 길은 건별 무시뿐임을 안내</td>
</tr>
<tr>
<td>`DISMISS_REASON_REQUIRED`</td>
<td>REQUEST</td>
<td>400</td>
<td>거부. 무시 사유 없음 — 사유 없이는 무시하지 않는다</td>
</tr>
<tr>
<td>`FINGERPRINT_INCOMPARABLE`</td>
<td>CONTENT</td>
<td>200</td>
<td>재판정만 수행. 변경 알림 미생성</td>
</tr>
<tr>
<td>`BATCH_EMPTY`</td>
<td>BATCH</td>
<td>–</td>
<td>`last_covered` 미갱신</td>
</tr>
<tr>
<td>`BATCH_HIDDEN_OVERFLOW`</td>
<td>BATCH</td>
<td>–</td>
<td>개별 확인으로 전환</td>
</tr>
<tr>
<td>`BUDGET_THRESHOLD`</td>
<td>BATCH</td>
<td>–</td>
<td>배치 자동 중지</td>
</tr>
<tr>
<td>`BUDGET_EXHAUSTED`</td>
<td>REQUEST</td>
<td>429</td>
<td>신규 검수 · 기획 조회 · 에이전트 차단. 기획 화면 안내에는 입력 · 저장은 계속된다는 문구를 더한다. 에이전트가 실행 중에 막히면 거절 대신 200 `incomplete`</td>
</tr>
<tr>
<td>`RATE_LIMIT_EXCEEDED`</td>
<td>REQUEST</td>
<td>429</td>
<td>거부 + `Retry-After`. 분당 상한 초과(3-4 · EX-SY-008)와 같은 계정의 같은 에이전트가 도는 중에 온 요청(EX-AG-004). 새로 실행하지 않는다</td>
</tr>
<tr color="red_bg">
<td>`FORBIDDEN_ACTION`</td>
<td>REQUEST</td>
<td>403</td>
<td>**전면 금지 동작 거부 + 시도 사실 로그 기록**</td>
</tr>
<tr>
<td>`NOT_AUTHENTICATED`</td>
<td>REQUEST</td>
<td>401</td>
<td>거부 + 재인증</td>
</tr>
<tr>
<td>`NOT_FOUND`</td>
<td>REQUEST</td>
<td>404</td>
<td>거부. **존재 여부 비노출**</td>
</tr>
<tr>
<td>`REPORT_FAILED`</td>
<td>REQUEST</td>
<td>500</td>
<td>거부 + 재시도 유도. 검수 결과는 무영향</td>
</tr>
<tr>
<td>`INPUT_INVALID`</td>
<td>REQUEST</td>
<td>400</td>
<td>거부. 전용 코드가 없는 입력 형식 오류(허용 값 밖 · 빠진 필수 값 · 깨진 JSON 본문). 문구는 무엇이 틀렸는지 한국어로 — 파서 · 프레임워크의 영어 문구는 싣지 않는다</td>
</tr>
<tr>
<td>`INTERNAL_ERROR`</td>
<td>REQUEST</td>
<td>500</td>
<td>거부 + 로그 기록. **최후 수단**</td>
</tr>
</table>
<callout icon="🔀" color="yellow_bg">
	**`finding.reason_code`****에는 두 네임스페이스가 함께 기록됩니다.**
	규칙 판정 사유코드 — **15종** (R01: `REST_DAY_CONFLICT` `OPEN_HOUR_CONFLICT` `ADMISSION_CUTOFF` `IN_BREAK_TIME` `REST_DAY_UNCERTAIN` · R02: `EVENT_ENDED` `EVENT_NOT_STARTED` · R03: `TIME_OVERLAP` · R04: `CONTENT_IMBALANCE` · R07: `MEAL_REST_MISSING` `MEAL_TIME_SHORT` · R08: `TRAVEL_TIME_SHORT` · R09: `RAIN_RISK` · R10: `TARGET_MISMATCH` · F07: `PRE_DEPARTURE_CHECK`) — 전체 정의는 예외처리 4장 「규칙 판정 사유코드 목록」(EX-CM-022)
	예외 사유코드 — 위 43종
	정규화 결과의 `unparsed[].reason`은 접두어 없는 열거값(`MISSING` `TARGET_VARIES` …)이고, 로그와 finding에 기록하는 것이 `PARSE_*` 코드입니다. 둘을 혼동하지 않도록 상수 클래스를 분리합니다.
</callout>
## 9-2. 재시도 정책
<table fit-page-width="true" header-row="true">
<tr>
<td>대상</td>
<td>자동 재시도</td>
<td>실패 확정 시</td>
<td>사용자 복구 수단</td>
</tr>
<tr>
<td>공사 상세 조회</td>
<td>지수 백오프 2회</td>
<td>콘텐츠 단위 확인 불가</td>
<td>다시 검수</td>
</tr>
<tr>
<td>공사 인증·쿼터 오류</td>
<td>**없음**</td>
<td>즉시 중단</td>
<td>–</td>
</tr>
<tr>
<td>LLM 정규화</td>
<td>1회</td>
<td>조각 단위 확인 불가</td>
<td>다시 검수</td>
</tr>
<tr>
<td>지도 API</td>
<td>지수 백오프 2회</td>
<td>구간 단위 확인 불가</td>
<td>다시 검수</td>
</tr>
<tr>
<td>기상 예보 API</td>
<td>지수 백오프 2회</td>
<td>평년 테이블로 강등 (확인 불가 아님)</td>
<td>–</td>
</tr>
<tr>
<td>검수 작업</td>
<td>없음</td>
<td>30분 초과 시 FAILED</td>
<td>재실행</td>
</tr>
<tr>
<td>패치 확정</td>
<td>**없음 (상태 변경)**</td>
<td>전체 원상 복구</td>
<td>재선택 후 재확정</td>
</tr>
<tr>
<td>자동 배치</td>
<td>없음</td>
<td>`last_covered` 미갱신</td>
<td>다음 회차 자동 복구</td>
</tr>
<tr>
<td>PDF 생성</td>
<td>없음</td>
<td>거부</td>
<td>재요청</td>
</tr>
</table>
---
# 10. 권한 · 금지 동작
## 10-1. 접근 제어
<table fit-page-width="true" header-row="true">
<tr>
<td>규칙</td>
<td>구현</td>
</tr>
<tr>
<td>모든 조회에서 요청자 계정과 소유자를 대조</td>
<td>서비스 계층에서 `account_id` 일치 검증. 식별자 추측만으로 접근 불가 (PM-DA-003)</td>
</tr>
<tr>
<td>타 계정 리소스는 404</td>
<td>존재 여부 비노출 (PM-DA-004 · EX-SY-003)</td>
</tr>
<tr>
<td>미인증 API 호출은 401</td>
<td>화면 리다이렉트만으로 불충분. **API 레벨에서 차단** (PM-AC-004 · EX-SY-001)</td>
</tr>
<tr>
<td>PDF 다운로드 인증 필수</td>
<td>공개 링크 발급 금지 (PM-DA-007)</td>
</tr>
<tr>
<td>테스트 계정 권한</td>
<td>일반 계정과 동일. 자동 배치 활성화 · 실행 시각 · 일일 호출 예산은 테스트 계정을 포함한 모든 계정이 바꿀 수 없다 (PM-TA-006 · PM-FN-008)</td>
</tr>
</table>
## 10-2. 전면 금지 동작 (모든 주체 예외 없음)
<table fit-page-width="true" header-row="true">
<tr>
<td>금지 동작</td>
<td>방어 계층</td>
</tr>
<tr color="red_bg">
<td>차단 등급 finding 무시</td>
<td>화면 버튼 비활성 + **API 403**  • **DB CHECK 제약**</td>
</tr>
<tr color="red_bg">
<td>차단 1건 이상 상태에서 출시 승인</td>
<td>화면 버튼 비활성 + **API 403**  • **DB 트리거**</td>
</tr>
<tr>
<td>규칙 개별 비활성화</td>
<td>설정 API에 해당 파라미터가 존재하지 않음</td>
</tr>
<tr>
<td>과거 검수 실행 결과 수정</td>
<td>**엔드포인트 자체를 만들지 않음**  • DB 트리거</td>
</tr>
<tr>
<td>확인 필요 항목의 확인 결과값 저장</td>
<td>요청 본문에 해당 필드가 없고 컬럼도 없음</td>
</tr>
<tr>
<td>비표출 콘텐츠의 명칭·주소·이미지 노출</td>
<td>응답 DTO에서 제외. 화면·API·PDF 3곳 모두</td>
</tr>
<tr>
<td>비표출 전환 알림 무시</td>
<td>API 403</td>
</tr>
<tr>
<td>되돌리기 2단계 이상</td>
<td>API 409</td>
</tr>
<tr>
<td>개인위치정보(GPS) 요청·수집·전송</td>
<td>**권한 요청 코드 자체를 두지 않음**</td>
</tr>
<tr>
<td>공사 원문 요약·재작성 후 표시</td>
<td>해당 API·화면 기능 미탑재</td>
</tr>
<tr>
<td>브라우저에서 공사 API 직접 호출</td>
<td>인증키를 프론트에 내려보내지 않음. 전부 서버 프록시</td>
</tr>
<tr>
<td>외부 시스템 연동용 API 토큰 발급</td>
<td>범위 밖. 기능 미제공</td>
</tr>
</table>
<callout icon="🧪" color="orange_bg">
	**W7 전수 테스트에 API 레벨 우회 시도 4건이 포함되어 있습니다.**
	차단 finding 무시 API 직접 호출 거부 / 차단 상태 출시 승인 API 직접 호출 거부 / 타 계정 리소스 ID 조회 시 404 반환 / 비표출 콘텐츠의 명칭·주소·이미지가 화면·API·PDF 어디에도 미노출.
	화면에서 막는 것만으로는 통과할 수 없는 항목들입니다.
</callout>
---
# 11. 성능 목표와 구현 근거
<table fit-page-width="true" header-row="true">
<tr>
<td>대상</td>
<td>목표</td>
<td>구현 근거</td>
</tr>
<tr>
<td>검수 1회 완료</td>
<td>**관광지 8곳 이하 p95 15초 · 최대 구간 12곳(2박 3일) p95 20초**</td>
<td>관광지 단위 병렬 8 · 중복 contentid 캐시 · 규칙 평가 메모리 전용</td>
</tr>
<tr>
<td>검수 요청 → 작업 ID 반환</td>
<td>p95 500ms</td>
<td>큐 INSERT만 수행하고 즉시 202 반환</td>
</tr>
<tr>
<td>진행 상태 폴링</td>
<td>p95 300ms</td>
<td>`audit_job` 단일 행 조회</td>
</tr>
<tr>
<td>일반 조회 API</td>
<td>p95 1초</td>
<td>DR-IN-011 인덱스 7종</td>
</tr>
<tr>
<td>PDF 리포트 생성</td>
<td>p95 10초</td>
<td>서버 사이드 렌더링 · 이미지 미임베드</td>
</tr>
<tr>
<td>자동 경량 배치 1회</td>
<td>5분 이내</td>
<td>2단계 구조로 평일 약 4–6콜</td>
</tr>
<tr>
<td>엑셀 업로드 파싱 (100행)</td>
<td>p95 5초</td>
<td>스트리밍 파싱</td>
</tr>
<tr>
<td>자연어 구조화 (LLM 1회)</td>
<td>p95 20초</td>
<td>미리보기 비동기 처리 불필요 수준</td>
</tr>
</table>
**용량 상한** — 동시 사용자 10명 · 계정당 상품 50건(성능 보증 수 · 막는 한도 아님) · 상품당 일정 항목 45건 · 동시 검수 3건 · 업로드 5MB/500행 · 자연어 4,000자 · 국문 관광정보 일일 예산 8,000건(트래픽 증설 기간 · 증설 마지막 날 다음 날부터 800건).
<callout icon="📏" color="gray_bg">
	**성능 측정은 정식 배포된 실제 환경에서 수행합니다.** 로컬 측정치를 근거로 쓰지 않으며, 목표 미달 항목은 미달 사실과 실측치를 함께 문서화합니다. **목표값의 사후 하향은 금지합니다** (NF-PF-020·021).
</callout>
---
# 12. 요구사항 추적
<table fit-page-width="true" header-row="true">
<tr>
<td>요구사항</td>
<td>API 설계 반영</td>
</tr>
<tr>
<td>FR-AU-021·022·023 비동기 검수</td>
<td>4-5절 `POST /audit-jobs` 202 + `GET /audit-jobs/{id}` 폴링 · 5-4절 DTO</td>
</tr>
<tr>
<td>FR-AU-032 규칙 인터페이스</td>
<td>6-3절 `AuditRule`</td>
</tr>
<tr>
<td>FR-AU-033 외부 참고 배지</td>
<td>`requiresExternal` → `finding.requiresExternal` 자동 부착</td>
</tr>
<tr>
<td>FR-AU-043 총 감점 노출</td>
<td>5-5절 `scoreBreakdown.formula`</td>
</tr>
<tr>
<td>FR-AU-061 3단 병기</td>
<td>5-6절 `evidenceView` (ktoRaw · aiNormalized · verdict)</td>
</tr>
<tr>
<td>FR-AU-065 검수 근거 영역</td>
<td>5-5절 `evidence` 객체 6개 필드</td>
</tr>
<tr>
<td>FR-AU-084 확인 결과 미저장</td>
<td>`POST /findings/{id}/confirm` 은 본문을 받지 않음</td>
</tr>
<tr>
<td>FR-PA-005·006 충돌 검사</td>
<td>5-8절 `conflict.pairs` · `kind` 3종</td>
</tr>
<tr>
<td>FR-PA-022 재검수 정확히 1회</td>
<td>패치 확정이 재검수 작업 1건을 생성하고 `reauditJobId` 반환</td>
</tr>
<tr>
<td>FR-PA-040 비교 지표 9종</td>
<td>5-9절 `metrics` 배열</td>
</tr>
<tr>
<td>FR-MO-017 다시 검수</td>
<td>`triggerType: MANUAL` · 예산 100%까지 허용</td>
</tr>
<tr>
<td>FR-OP-005 운영자 사용량 조회</td>
<td>5-11절 `GET /usage/budget`</td>
</tr>
<tr>
<td>FR-OP-020 – 026 검수 기준</td>
<td>4-9절 `GET · PUT /settings` · 5-5절 `settingSnapshot` · 5-10절 규칙 설명 필드</td>
</tr>
<tr>
<td>FR-PL-001 – 023 상품 기획</td>
<td>4-10절 · 4-2절 `handoff` · 4-3절 항목 본문 확장 · 8-2절 `PLAN` 의도</td>
</tr>
<tr>
<td>FR-AG-001 – 031 AI 에이전트</td>
<td>4-11절 · 3-4절 동시 1회 · 7-5절 허용 용도</td>
</tr>
<tr>
<td>PM-NG-001·002·004</td>
<td>10-2절 3중 방어 (화면 · API · DB)</td>
</tr>
<tr>
<td>PM-SC-002 서버 프록시</td>
<td>4-4절 `/contents/*` `/ldong-codes` `/lcls-codes`</td>
</tr>
<tr>
<td>EI-CM-003 어댑터 격리</td>
<td>2-2절 `external` 패키지 · 규칙은 `external` 미의존</td>
</tr>
<tr>
<td>EX-CM-001~011 예외 격리</td>
<td>3-2절 `unit` 필드 · 6-2절 격리표</td>
</tr>
<tr>
<td>NF-AV-004 헬스체크</td>
<td>`GET /health` (인증 없음)</td>
</tr>
<tr>
<td>NF-SC-010 호출 빈도 제한</td>
<td>3-4절</td>
</tr>
<tr>
<td>NF-PF-001~015 성능</td>
<td>11장 + 6-1절 병렬 구조</td>
</tr>
</table>
---
# 13. 미결·확인 필요 항목
<table fit-page-width="true" header-row="true">
<tr>
<td>항목</td>
<td>내용</td>
<td>기한</td>
</tr>
<tr>
<td>엑셀 지정 양식 컬럼</td>
<td>양식 1종의 실제 컬럼 구성이 확정되지 않음</td>
<td>W2</td>
</tr>
<tr>
<td>프론트 라우팅 경로</td>
<td>화면 0–8의 URL 경로가 확정되지 않음. 화면 요구사항과 함께 확정 필요</td>
<td>W2</td>
</tr>
<tr>
<td>Swagger 문서화</td>
<td>API 변경 시 Swagger와 프론트 타입을 동시 갱신하는 절차 확정</td>
<td>W2</td>
</tr>
<tr>
<td>운영계정 전환</td>
<td>미승인을 기본 시나리오로 가정. 승인 시 `daily_quota` 상한만 상향</td>
<td>W4</td>
</tr>
</table>
<callout icon="📌" color="gray_bg">
	**개정 이력**
	v1.0 (2026.08.15) — 최초 작성.
	v1.1 (2026.08.19) — 문서 정합성 점검 반영. 배치 실행 시각 · 일일 호출 예산을 전역 설정으로 확정 — BudgetGuard 소진율 = 당일 전역 `api_call_log` 합산 ÷ `system_setting.daily_quota` (4-9 · 5-11 · 8-2 주석). 재검수의 전 콘텐츠 재조회 전제(기능 v1.2 FR-PA-023 개정)는 6-1절 파이프라인과 이미 정합.
	v1.2 (2026.08.19) — 배치 1 반영. 5-5 주석 보강 — `readinessScore` · `counts`는 조회 시점 재계산 값(FR-AU-046), `evidence.dataFingerprint`는 실행 대표 지문 앞 8자리(DR-FP-008). 9-1 규칙 판정 사유코드를 15종 체계로 갱신(예외처리 4장 · EX-CM-022 참조).
	v1.3 (2026.08.19) — 배치 2 반영. ① finding 목록 응답에서 공사 원문(`ktoRaw`) 제외 — 근거 펼침 시 `GET /contents/{contentId}` 1콜로 조달(5-6 · 5-12, UI-S3-011 기본 접힘과 정합) ② "확인 필요 N건" = 목록 항목 수 기준으로 예시 정정(93점 · 3건) ③ `POST /api/v1/demo/reset` 신설 — 시드 재실행 복원(PM-TA-003 · DR-TD-007).
	v1.4 (2026.08.19) — 상품 범위 확대(팀 합의 2026.08.19, 당일~2박 3일 · 최대 12곳). **API 계약(엔드포인트 · 요청/응답 필드)은 변경 없음** — `nights`는 기존 필드이며 서버 검증 범위만 0~2로 완화. 수치 갱신: 6-1 · 8-1 호출량(29→43콜 병기), 11장 성능 목표 이원화(8곳 15초 / 12곳 20초 — NF-PF-001 v1.1 정합), 4-3 업로드 상한 30→45건(NF-CP-003 정합).
	v1.5 (2026.08.21) — 6-4절 커버리지 목표에 분모 정의를 병기하고 기준선 수치를 재계산(71.4% · 71.1% → 85.8% · 76.7%). 종전 수치는 결측을 포함한 전체 287 기준이라 새 정의와 혼재하면 "착수 71.4% → 목표 90%"라는 틀린 서술이 남는다. API 계약(엔드포인트 · 요청/응답 필드)은 변경 없음. FR-AU-004 · DR-TD-003 · NF-OB-007 · 기획서 8-2와 동시 개정.
	v1.6 (2026.08.23) — F09 패치 확정 · 되돌리기 구현에서 확정. ① `previewToken`을 저장 키가 아니라 **일정 해시**로 정의(5-8 콜아웃) — F08이 아무것도 저장하지 않는다는 전제를 지키면서 EX-PA-002를 답할 수 있고, 충돌이 있어도 토큰은 그대로 내려간다 ② 확정 거부 조건에 ③대상 소실 · ④검수 진행 중 · ⑤예산 소진 추가(4-6 콜아웃) — 특히 ④는 진행 중인 작업을 재검수라며 내주면 패치 전 일정을 보는 작업 번호가 나가고 바뀐 일정의 재검수가 영영 돌지 않아서다 ③ 되돌리기는 **재검수를 돌리지 않고** `before_audit_run_id`를 가리킨다(5-9 콜아웃), `after_audit_run_id`가 빈 이력은 다음 사용자 검수가 채우되 되돌린 이력은 제외한다(EX-PA-004).
	v1.7 (2026.08.24) — R09 강수 판정 분기를 실측에 맞춰 정정. 중기육상예보가 **발표일 +5일부터** 시작해 `rnSt3` · `rnSt4` 필드가 없다(실호출 확인). D+3 을 중기로 보내면 빈 값을 받고 그걸 강수확률 0 으로 읽어 비 오는 날을 정상 판정하게 된다. 구간을 D+0–D+2 단기 / **D+3 단기 부분 커버리지** / **D+4–D+10 중기** / D+11 이상 평년 으로 바꾸고, 중기는 최신 발표분이 아니라 **대상 일자를 덮는 발표분**을 고르도록 했다. EI-WX-001 의 「공사 인증키와 별개의 키」 서술도 정정 — data.go.kr 은 계정당 키 하나이고 활용신청만 서비스별이다. 관련 이슈 #54 · #55.
	v1.8 (2026.08.24) — 구현 실측 대조. ① 백엔드를 Spring Boot 3 → **NestJS 10 + TypeScript** 로 정정. 아키텍처 다이어그램과 기술 스택 표가 실제와 달랐고, 기획서는 기능설명서의 원본이라 그대로 두면 제출 서류와 구동 코드가 어긋난다. 선택 근거(상시 구동 · 공용 상수 단일 출처 · eslint 로 강제하는 결정론성)도 함께 적었다 ② LLM 허용 용도를 셋 → **둘**로 정정 — finding 설명문 생성은 결정론성 때문에 쓰지 않기로 확정했고 구현의 `LlmPurpose` 도 `STRUCTURE` · `NORMALIZE` 둘뿐이다 ③ 배치를 Spring Scheduler → Node 프로세스 내 스케줄러, 배포를 Railway 로 구체화.
	v1.9 (2026.08.29) — F11 리포트 구현에서 확정. ① `reportId` 가 가리킬 행이 없다는 것을 4-7 콜아웃으로 명시 — DB 명세서 6-4 가 PDF 를 남기지 못하게 하고 `report` 테이블은 엔터티 18종에 없다. `POST` 가 렌더까지 끝내고 프로세스 메모리에 5분 들고, `GET .../download` 가 그것을 흘려보낸다 ② **가장 최근 검수 실행만** 리포트 대상이며 아니면 409 `REPORT_FAILED` — `audit_run` 에 일정 스냅샷이 없어 과거 실행으로 만들면 그때 판정과 지금 일정이 섞인다 ③ 5-12 리포트 호출 수를 8 → **콘텐츠 수 × 2** 로 정정(픽스처 실측). `detailIntro2` 에 `title` 이 없고 `detailCommon2` 에 판정 필드가 없어 둘 다 필요하다. 하루 예상 호출량 40 → 56콜 ④ 머리표 버전이 v1.5 인데 개정 이력은 v1.8 까지 있어 v1.9 로 맞췄다.
	v2.0 (2026.08.30) — F13 · F14 레이더 구현에서 확정. ① **T1 · T2 를 배치가 미리 산출**하고 조회는 읽기만 한다 — 요청 시 조회하면 화면을 열 때마다 예산이 나간다. `demand_signal` 신설(DB 명세서 v1.9) ② `radar/signals` 에 **`productId`**** 를 필수**로 했다 — T2 조회 창이 그 상품의 여행일에서 나오므로 상품 없이는 어느 기간의 행사를 세야 하는지 정할 수 없다 ③ `radar/changes` 의 판독 결과 변화는 `content_fingerprint.normalized_json` 전후 비교이며 재검수가 돌아 지문이 두 번 이상 쌓인 콘텐츠에만 있다. 없으면 `hasReadableDiff: false` 로 그 사실을 말한다 ④ 알림 응답에 `dismissable` 을 넣었다 — 비표출 전환 알림은 무시할 수 없는데(FR-MO-037 · PM-NG-010) 눌러 보고 403 을 받는 것은 화면이 규정을 모른다는 뜻이다 ⑤ 알림 응답에 관광지명을 담지 않는다. 화면이 `ktoContentId` 로 자기 일정의 `placeLabel` 을 붙인다(FR-MO-002).
	v2.10 (2026.09.17) — 8-2 새 서비스 예산 분모를 서비스별로 나눴다. 트래픽 증설로 무장애 · 반려동물 · 연관 관광지 3종의 한도가 1일 10,000건이 되어 분모가 8,000 이 되고, 두루누비 · 방문자수는 800 그대로다 — 종전에는 다섯이 한 상수(800)를 썼다. **증설이 30일 기간제(2026.09.17 ~ 10.16)라 분모가 날짜를 본다** (`extraServiceDailyCap`) — 종료일 다음 날부터 다섯 다 800 으로 돌아간다. 예산 게이트 경계와 엔드포인트는 변경 없다. 외부 연동 요구사항 v1.13 · DB 명세서와 동시 개정. 이슈 #508.
	v2.9 (2026.09.17) — 13 에서 결정이 끝난 두 줄을 더 뺐다. ① 인증 방식 상세 — 세션 저장소는 DB (`db/schema.sql` `session` 테이블 · `expires_at`), 만료는 7일(`session-cookie.ts` `SESSION_TTL_MS`)로 정해져 있다 ② 카카오모빌리티 키 재발급 — **하지 않기로 했다.** 저장소에 노출 이력이 없다 — 588커밋 전체를 `KakaoAK [0-9a-f]{32}` 와 `KAKAO_REST_API_KEY=` 값 패턴으로 훑어 0건이고, `KakaoAK` 가 든 커밋 4건은 어댑터 코드와 문서의 자리표시자다(이슈 #8 이 같은 결론). 외부 연동 요구사항 7 의 같은 문구도 함께 뺐다(v1.12). 13 은 4행이 됐다. 이슈 #461.
	v2.8 (2026.09.17) — 13 에서 끝난 두 줄을 뺐다. LLM 제공자·모델은 Anthropic 으로 정하고 키를 받아 정답셋 조각 13종으로 확인했고(외부 연동 v1.7 · 2026.09.10), 기상청 예보 API 는 활용신청 뒤 단기 · 중기 실호출을 봤다(2026.08.26 · `test/live-kma.smoke.spec.ts`). 둘 다 검수 파이프라인에 붙어 있고 `/health` 가 키를 ok 로 본다. 이 표는 「미결·확인 필요 항목」이라 완료 표시를 남기지 않고 행을 뺀다 — 같은 사실은 외부 연동 요구사항 7 이 v1.10 에서 상태로 적었다. 이슈 #458.
	v2.7 (2026.09.17) — 13 카카오모빌리티 키 행에서 「배포 도메인 등록」을 뺐다. REST API 키에는 도메인을 등록하는 항목이 없다 — 사유는 외부 연동 요구사항 v1.11 과 같다. 「문서에 노출된 키 재발급 권장」은 남겼다. 이슈 #456.
	v2.7 (2026.09.18) — 4-10 에 `GET /plan/place-detail?contentId&contentTypeId` 을 신설했다(이슈 #529). 카드 「자세히」(FR-PL-012)가 이용시간 · 쉬는 날 · 요금 · 주차를 보이려면 `detailIntro2` 가 필요한데, 종전에 이 자리를 가리키던 `/contents/{contentId}?with=` 은 핑거프린트 필드(restdate · usetime)만 `ktoRaw` 로 낼 뿐 요금 · 주차가 없고, 이를 넣으려면 콘텐츠 핑거프린트 경로(NF-MT-001)를 건드려야 한다. 그래서 `place-facts`(4-2)와 같은 유형별 매핑을 contentId 로 쓰는 조회를 따로 뒀다 — 저장 전 카드에도 쓰고, **캐시 없이** 펼칠 때마다 실호출하며 예산은 검수와 같은 게이트다. `/contents/{contentId}?with=` 행은 좌표 · 분류 · 무장애 · 반려동물 축으로 뜻을 좁혔다. 계약 추가만 있고 기존 응답은 그대로다.
	v2.6 (2026.09.17) — 5-6 예시의 날짜와 요일이 어긋난 것을 고쳤다(이슈 #433). 「10월 13일(월)」로 적혀 있었는데 **2026-10-13 은 화요일**이다(`dates.spec.ts` 가 `TUE` 로 못 박는다). 오죽헌은 문화시설이라 「매주 월요일 휴관」이 예시로 자연스러우므로 요일을 바꾸지 않고 날짜를 실제 월요일인 **2026-10-12** 로 옮겼다. `TIME_SHIFT` 패치 라벨도 1일차 10-12 기준 2일차인 10월 13일로 맞췄다. 같은 예시가 DB 명세서 3-x 에도 있어 함께 고쳤다. 계약 변경은 없다.
	v2.5 (2026.09.17) — 5-6 finding 목록의 페이징 봉투를 뺐다. 예시가 `page` · `size` · `totalPages` 를 약속했는데 `toFindingsResponse` 는 `content` 와 `totalElements` 만 돌려주고, 이 목록을 페이징해 달라는 화면 요구사항은 한 줄도 없다. 한 검수의 finding 은 항목 수 × 규칙 수로 묶여 있어 나눌 이유가 없다. 3장 페이지네이션 규약에 5-6 · 5-7 이 예외라는 것을 병기했다. 상품 목록(5-2)은 종전대로 페이징한다. 엔드포인트와 나머지 필드는 변경 없다 — 이슈 #35 에 「코드가 문서와 다른 네 곳」으로 적혀 있던 것은 v2.3 과 이슈 #355 에서 이미 맞췄고 남은 차이는 이 봉투 하나였다.
	v2.4 (2026.09.15) — 설정 탭 개편안(검수 기준)과 기획 · 검수 · 레이더 개편안 v7.1 반영. 명세 사본 개정 계획 1-6 의 행과 개발 분담 계획 3-3 의 계약을 옮겼다. ① 4-10 기획(F17) · 4-11 에이전트(F18) 절 신설 — `plan/briefing` · `plan/places`(시군구 · 근처 3km) · `plan/events` · `plan/walks` · `place-facts`, `place-suggestions` · `check-questions` · `radar/today`. 기획 조회는 규칙엔진을 부르지 않고 `audit_run` 을 만들지 않으며, 에이전트는 읽기 도구만 쓰고 결과를 저장 · 로깅하지 않는다 ② 4-2 `POST /products/{id}/handoff`(검수 시작 · `excludePending` · 422 `PLACE_UNRESOLVED` 와 `pendingCount`)와 `plannedAt` · `planOrigin`, 4-3 항목 추가 본문 확장(`afterItemId` · `content` · `excluded` · `origin` · 시각 자동 채움), 4-4 `matchedBy` · `with=accessible,pet`, 5-3 확정 시점을 장소를 입력하는 순간으로 ③ 검수 기준 — 설정 10종을 표준 5 · 회사 기준 2 · 관심 2 · 운영 3 으로 나누고, `GET · PUT /settings` 를 표준 요약 · 회사 기준(엄격하게만, 400 `SETTING_NOT_STRICTER`) · 관심 키워드 · 관심 지역으로 바꾸고 표 3종 엔드포인트를 뺐다. 배치 시각 · 예산 · 배치 자동 실행은 운영자 전용이다. 무시 사유 필수(400 `DISMISS_REASON_REQUIRED`), `settingSnapshot`(5-5), 규칙 설명 필드(5-10) ④ 레이더 — `nextBatchAt` · `t1.keywordHits` · `region-signals`(T3 포함) · `region-signals/refresh` ⑤ 3-4 호출 빈도 제한 2행, 5-12 기획 화면 · 에이전트 조달 행과 호출량, 7-2 서비스별 transport · 픽스처 규칙, 8-2 의도 `PLAN`(경계는 검수와 같은 100%) · provider 별 예산(국문 `daily_quota`, 새 서비스 4종은 각 800) ⑥ 9-1 사유코드 38 → 41종 — 새 코드 2개와 함께, 예외처리 v1.3 에서 신설됐는데 이 표에 빠져 있던 `CONTENT_NOT_FOUND` 를 넣었다(코드는 이미 39종이었다) ⑦ 정합 — 2-2 패키지 구조를 실제 모듈로 현행화(`mock` 삭제 · `plan` · `agent` 신설), 1장 ② · 7-5 LLM 사용을 다섯 가지로(EI-LM-001, 표에 남아 있던 「finding 설명 문장 생성」 삭제), 「지금 재검수」 → 「다시 검수」, 호출량 표시를 계정 메뉴의 오늘 사용량으로, 기능 요구사항의 FR-OP-020~027 교체로 뜻이 바뀐 인용 정리(lcls-codes 의 FR-OP-023 제거 · 운영자 전용 문단에 PM-FN-008), 6-1 · 4-7 에 `setting_snapshot` 기록과 리포트 머리글, 10-1 테스트 계정 행(배치 3값은 모든 계정 변경 불가, PM-TA-006), 5-2 · 5-12 화면 이름 「대시보드」 → 「홈 · 내 상품」, 12 추적표에 FR-OP-020~026 · FR-PL · FR-AG 행. 연쇄 개정: 13 기능 · 14 화면 · 15 권한 · 16 데이터 · 18 외부 연동 · 19 예외처리 · 20 DB 명세서와 동시 개정. 통합 점검 — `handoff` 를 검수 요청과 같은 202 로(3-3) 하고 예산 거절 시 기획 중 유지를 적었다. 상품 목록의 중복 필드(`latestBlockerCount` · `unreadNotificationCount`)는 기존 `latestAudit.counts.blocker` · `unreadNotifications` 로 대신하고, 시군구 코드 예시를 공사 형식(3자리)으로, TodayItem.region 에 `regnCd` 를 더했다. 5-10 R03 `basis` 를 코드와 같은 `ITINERARY_ONLY` 로, 6-4 · 7-5 의 temperature 0 을 지웠다(EI-LM-002 v1.7 연쇄 누락). 4-6 확인 체크 문구 "확인했어요", 12 추적표 FR-MO-017 "다시 검수". 결정 반영(2026.09.15) — ① 걷기 길은 `excluded{walkId}` 로 넣고 코스 이름을 보내지도 저장하지도 않는다(4-3 · 4-10 · 5-12 이름 조회 콜아웃). ② 에이전트 오류 응답 — 실행 전 거절만 429(`BUDGET_EXHAUSTED` · 신설 `RATE_LIMIT_EXCEEDED`)이고, 실행 뒤 실패 · 시간 초과 · 예산 소진은 200 + `incomplete` 로 끝난 항목만 돌려준다. `RATE_LIMIT_EXCEEDED` 는 3-4 빈도 제한에도 쓴다(3-3 · 3-4 · 4-11 · 9-1, 사유 코드 42종). 반려동물 동반여행정보는 국문 관광정보와 다른 서비스(`KorPetTourService2`)라 provider `KTO_PET` 으로 따로 센다(4-8 · 7-2 · 8-2, 새 서비스 5종). 새 서비스 실호출 확인(2026.09.15) — 4-10 `together` 는 기준 관광지 이름으로 찾는 `searchKeyword1`, 근처 3km 는 응답이 거리순이 아니라 `dist` 로 정렬, 걷기 길은 두루누비 전국 목록을 시군구 글자로 거르고 좌표가 없다(4-10 표 · 5-12 이름 조회 콜아웃). 7-2 에 새 서비스 베이스 URL 과 서비스를 붙인 오퍼레이션 이름. 어댑터 구현(2026.09.15) — 7-2 에 파라미터 오류(10 · 11 · 12) 재시도 안 함 · 두루누비의 봉투 없는 오류 응답 · 픽스처 파일명 접미 규칙을 더했다. 레이더 키워드 일치 구현(2026.09.15) — 4-8 에 `keywordHits` 의 `contentIds: null`(배치가 아직 안 본 키워드)과 빈 배열의 차이, T1 건수를 키워드로 거르지 않는다는 것, 배치가 꺼져 있으면 `nextBatchAt` 이 `null` 이라는 것을 더했다. 관심 지역 신호 구현(2026.09.15) — 4-8 `region-signals` 의 `region` 모양 · `t1` · `t2` 의 `keywordHits` · `t1` 은 가장 최근 창 · T3 합산 방식, `refresh` 의 403(배치가 켜져 있을 때) · 방문자수 예산만 막힐 때 `t3` null · 이미 센 창을 다시 부르지 않는 것을 더했다. 에이전트 공통 틀 구현(2026.09.15) — 3-4 에이전트 분당 5회와 동시 실행 거절에 `Retry-After` 를 붙이지 않는 것, 7-5 에 `tool_choice: auto` · `submit_result` · 상한에 닿으면 답을 한 번 청하는 것 · `LLM_MODEL_AGENT` 를 더했다.
	v2.3 (2026.09.10) — 5-6 finding 응답을 구현과 대조해 정정. ① `summary` 를 뺐다 — `message` 와 내용이 겹치고 코드에 한 번도 없었다 ② `dismissReason` · `needsConfirmation` · `patches[].placeName` 을 예시에 넣었다. 화면이 실제로 쓰는 값인데 표에 없어서 계약 밖에 있었다 ③ `target` 이 항목 상세를 담는 조건과 `placeLabel` 이 사용자 입력이라는 근거를 콜아웃에 적었다 — 비표출 finding 에서만 빠진다(FR-AU-071) ④ 비표출 예시의 `summary` 도 함께 뺐다. 코드 쪽은 `ruleVersion` · `dismissible` · `dismissedAt` · `confirmedAt` · `target` 상세 · `hiddenContent` 가 응답에서 빠져 있던 것을 채웠다(이슈 #355). 엔드포인트는 변경 없다.
	v2.2 (2026.09.08) — 5-12 표의 화면 2 · 3 · 5 를 0콜에서 **「대체·추가된 항목만 조회」**로 정정. `itinerary_item.place_label` 은 사용자 입력이라 `REPLACE_CONTENT` 가 건드리지 않고 `INSERT_ITEM` 은 빈 라벨로 들어오는데, 표는 세 화면 모두 `place_label` 로 0콜이라고 적어 뒀다. 전후 비교는 `withReplacedNames` 가 들어가면서 **이미 표와 달라져 있었고 표를 고치지 않았다** — 확정한 뒤 화면이 대체 전 이름을 보여준 것이 그 결과다(이슈 #322 · PR #324). 패치한 적 없는 상품은 종전대로 0콜이다. API 계약(엔드포인트 · 요청/응답 필드)은 변경 없다.
	v2.1 (2026.08.31) — 4-7 콜아웃의 「`report` 테이블은 엔터티 19종에 없다」를 **20종**으로 정정. v1.9 가 18종으로 적은 뒤 `demand_signal`(DB v1.9) · `llm_parse_cache`(DB v2.0)가 들어오며 두 번 밀렸고, 같은 문장이 구현 주석 두 곳(`report-store.ts` · `report.service.ts`)에도 18종으로 남아 있어 함께 고쳤다. API 계약은 변경 없다. DB 명세서 v2.1 과 동시 개정.
</callout>
<callout icon="©️" color="gray_bg">
	출처: ⓒ한국관광공사
</callout>
## 2026.09.18 가입 인증 API
- `POST /api/v1/auth/signup-code` (공개): `{email}` → 200 `{verificationId, expiresAt, resendAfterSeconds:60}`. 계정 존재 여부와 무관하게 같은 형식으로 인증메일을 발송하며 계정·세션을 만들지 않는다. 코드 원문은 응답·로그에 없다.
- `POST /api/v1/auth/signup` (공개): `{email,password,verificationId,code}` → 201 기존 AccountView + 세션 쿠키. 코드 불일치·만료·소비·5회 초과는 400 단일 인증 오류. 잘못된 코드의 시도 횟수는 트랜잭션 커밋 후 오류를 반환한다.
- 재전송 60초·이메일당 시간당 5회·서비스 전체 분당 10회·UTC 일일 100회 제한은 DB에 저장하며 429 및 Retry-After 반환. 발송 실패·미설정은 503이며 가입 인증을 우회하지 않는다.
- Google Apps Script 웹 앱을 HTTPS로 호출하고, 소유자의 Gmail 계정으로 고정된 인증메일만 발송한다. 환경변수는 `AUTH_MAIL_SCRIPT_URL`(`/exec` 배포 URL) · `AUTH_MAIL_SECRET`(64자리 난수 hex). 동일한 비밀값을 Apps Script의 스크립트 속성에 보관한다. 요청 본문은 HMAC-SHA256 서명·120초 유효시간·인증 요청 ID로 검증한다. 스크립트는 잠금과 처리 이력으로 재전송 공격을 차단하고 Google 잔여 수신자 한도를 확인한다. 브라우저에는 비밀값과 스크립트 주소를 주지 않는다. `/health`는 설정 형식만 검사하며 실제 메일 수신을 보증하지 않는다. 기존 계정 로그인 계약은 그대로다.
<callout color="gray_bg">
	v2.11 (2026.09.18) — 사용자 요청 #539에 따라 신규 가입 이메일 인증을 필수화. FR-CM-001 · UI-S0-002 · PM-AC-008 · DB · API 연쇄 개정. 기존 계정 및 심사용 계정 로그인 유지.
</callout>
<callout color="gray_bg">
	v2.12 (2026.09.18) — 추가 도메인 비용 없이 운영하려는 사용자 요청에 따라 Resend를 Gmail · Google Apps Script 발송으로 교체. 신규 가입 검증 정책은 유지한다.
</callout>
<callout icon="📝" color="gray_bg">
	v2.13 (2026.09.18) — 인증코드 요청을 4-1 전체 엔드포인트 목록에도 추가하고 DB 물리 테이블 수 참조를 20종으로 맞춤. EI-MA 외부 연동 계약과 DB v2.9 연쇄 정리.
</callout>
### 현재 알림의 여행 기간 범위 (#559)
`notifications` 목록·totalElements·unreadCount, `radar/summary` 모든 알림 건수, `radar/changes` 목록·totalElements는 소유 계정 범위 안에서 `start_date + nights >= 한국 오늘 날짜`인 상품만 포함한다. `includeDismissed`는 무시 여부만 해제하며 종료된 상품을 되살리지 않는다. 저장된 알림의 읽음·무시와 상품 상세·수동 검수는 기존 권한을 유지한다. 상품 삭제 시 관련 알림은 기존 외래키 연쇄 삭제를 따른다.
<callout color="gray_bg">
	v2.14 (2026.09.18) — #559: 한국 날짜의 여행 종료일 기준으로 홈·기획·검수·레이더·알림 배지 표시를 통일. 진행 중인 1박 2일은 유지하고 종료된 상품의 기록은 보존한다. 기능·화면·API 명세 연쇄 개정.
	v2.15 (2026.09.19) — 4-10 장소 목록: 원본 첫 페이지 제한 제거, 전체 조회 후 필터·정렬·20곳 페이징 명시. UI v2.8과 연쇄 개정 (#564).
	v2.16 (2026.09.19) — #579: 6-1 8단계. 추가 수정안(R09 · R10)도 같은 위치기반 상한을 쓰며 R10 은 결손 중분류(`lclsSystm1` · `lclsSystm2`)로 좁혀 부른다. R10 야간 자리는 후보의 그 시각 운영을 R01 로 확인하려고 `detailIntro2` 를 최대 3콜 더 쓴다 — 위치기반 상한과 따로 센다. 기능 요구사항 v2.10 과 연쇄 개정.
	v2.17 (2026.09.19) — #584 · #589: 6-1 8단계. R10 은 야간 자리를 낮 자리보다 먼저 잡고, 낮 자리는 야간이 못 채운 결손 중분류만 맡는다. 야간이 결손 중분류부터 찾게 되어 운영 확인(`detailIntro2`) 상한을 3 → 4콜로 올렸다. 위치기반 상한(3콜)은 그대로이며 낮 자리 몫으로 한 콜을 남긴다.
	v2.18 (2026.09.20) — #605: 8-1 1단계. 0건 지연 신호를 어제 · 평일로 좁혔다. 일요일은 실제로 0건이 나와(08-30 · 09-06 실호출) 배치가 08-30 에서 3주를 멈춰 있었다. 이틀 지난 평일의 0건은 공휴일로 보고 넘어간다. 기능 요구사항 v2.11 과 연쇄 개정.
	v2.19 (2026.09.20) — #551: 되돌리기 뒤 「현재 결과」를 정했다(5-9). 출시 승인(4-2) · 리포트 생성(4-7) · 상품 목록 `latestAudit` · 검수 이력 `isCurrent`(4-5)가 가장 최근 실행 대신 지금 일정의 실행을 본다. 되돌린 일정이 출시 승인을 통과하던 문제(2026-09-11 감사 치명 1번)를 막는다.
	v2.20 (2026.09.20) — #612: 예외 사유코드 `INPUT_INVALID` 신설(42 → 43종, 3-3 · 9-1). 사유코드 없이 던지던 400 입력 오류와 깨진 JSON 본문이 `INTERNAL_ERROR` 로 나가고 파서의 영어 문구가 그대로 실렸다. 예외처리 요구사항 v1.6 과 연쇄 개정.
	v2.71 (2026.09.27) — #897: 4-2 상품 저장 본문의 `days[].items[]` 에 걷기 길 `{ "walkId" }`(장소명은 받아도 저장하지 않는다)를, 4-3 항목 추가에 걷기 길의 `startTime` · `endTime`(주면 그 시각, 없으면 그 날 끝)을 더했다. 등록 · 편집 화면에는 걷기 길 칸이 없었고, 항목 추가는 걷기 길을 늘 그 날 끝에 넣었다.
	v2.70 (2026.09.27) — #895: 4-2 상품 저장 본문의 `days[].items[]` 와 4-3 항목 추가에 `excluded: true`(장소명을 둔 채 직접 정한 곳 `EXCLUDED`)를 더했다. 등록 · 편집 화면이 직접 정한 곳을 실어 보내지 않아 그 줄이 `PENDING` 으로 저장됐다.
	v2.69 (2026.09.27) — #863: 4-8 `GET /notifications` 에 새 소식의 `opportunity`(`slot` · `slotMissing` · `precheck` · `travelSource`)와 바뀐 정보의 `verdictDiff`(알림 직전 · 뒤 첫 검수의 그 곳 판정 차이)를 더하고, 8-1 에 배치가 넣을 자리를 남기고 사전 확인을 재는 순서(바뀐 정보 알림을 먼저 넣음 · 제공자 장애나 60초에서 멈춤)를 적었다. 새 소식은 조건 번호로 고른 고정 문장뿐이었고, 다시 검수한 바뀐 정보 알림에는 판정 차이가 없었다.
	v2.68 (2026.09.27) — #861: 4-2 · 5-2 상품 목록에 `startedBy`(기획을 시작한 방법, 기록이 없으면 `null`)를 더했다. 보드의 기획 중 카드는 시작 방식을 적어야 하는데(UI-S1-010) 목록 응답에 그 값이 없었다.
	v2.67 (2026.09.27) — #892: 4-3 항목 추가 행에 상품에 항목이 45건이면 어느 본문이든 400 `INPUT_INVALID` 로 거부한다는 것(상품 저장 · 넣는 수정안 확정도 같다)을 적고 요구사항 칸에 NF-CP-010 을 더했다. 업로드 · 메모 읽기만 45건을 봐서 직접 입력 · 장소 담기 · 걷기 길 · 수정안으로는 46건 이상이 저장됐다.
	v2.66 (2026.09.27) — #871: 4-2 상품 상세의 `days[].items[]` 에 `lcls2` · `endTimeSource`(끝 시간 미리보기 · 「기본값 적용」 표시용, 판정에 쓰지 않음)를 더했다. 이 둘이 없어 화면이 채워질 시각을 계산할 수 없었다.
	v2.65 (2026.09.27) — #870: 4-2 상품 저장 본문의 `days[].items[]` 에 `origin` 을 더하고, 4-3 항목 추가의 `origin` 에 받는 값(`MANUAL` · `UPLOAD` · `TEXT` · `PICKER`, 없거나 다른 값이면 `MANUAL`)을 적었다. 등록 · 편집 화면이 경로를 보내지 않아 기획 화면 장소 담기 · 걷기 길 말고는 모든 줄이 NULL 이었다.
	v2.64 (2026.09.27) — #890: 4-3 업로드 · 메모 읽기를 실제 경로(`/api/v1/uploads/schedule` · `schedule-text` · `template`)와 응답(저장 없이 201, 파일 · 글 전체 거부도 201 의 `rejected`, 20MB 초과만 413)으로 고치고 없는 `items/commit` 행을 뺐다 — 3-3 · 9-1 의 상태 코드와 `DAY_COUNT_MISMATCH`(검수 시작 422 · 단위 상품)도 맞췄다. 그 밖에 4-4 `lcls-codes`(대분류 목록만) · 검색(늘 상품 지역), 4-8 「지금 재검수」, 7-4 기상 키(같은 계정 키 · `KMA_SERVICE_KEY`), 8-1 분류체계 호출량, 11장 용량 상한(45건 · 4,000자 · 8,000건)을 지금 동작에 맞췄다. 명세가 적은 `items/import` · `parse-text` · `commit` 경로는 코드에 없었고, 상한 초과 · 양식 불일치도 400 이 아니라 201 의 `rejected` 로 나가고 있었다.
	v2.63 (2026.09.26) — #868: 4-3 업로드 콜아웃에 400 `UPLOAD_FORMAT_INVALID`(확장자 · 내용 · MIME · 파서 실패)와 20MB 초과 413 `UPLOAD_LIMIT_EXCEEDED` 를 적었다. 이름만 `.xlsx` 인 파일은 500 `INTERNAL_ERROR` 로, 20MB 초과는 `INTERNAL_ERROR` 와 영어 문구(`File too large`)로 나갔다.
	v2.62 (2026.09.26) — #867: 3-4 에 검수 실행 요청(다시 검수 · 검수 시작을 한 창으로) · 리포트 생성의 계정당 분당 5회와 공개된 테스트 계정 제외를 적고, 기획 조회 행(`/plan/*` · `place-facts`)의 「수치는 구현에서 정해 이 표에 적는다」 를 분당 상한을 두지 않는다로 고쳤다. 4-2 `handoff` 와 6-1 흐름에 429 `RATE_LIMIT_EXCEEDED` 를 더했다. 상한은 에이전트 셋과 로그인에만 걸려 있었다.
	v2.61 (2026.09.26) — #866: 8-1 비표출 조회에 페이지 상한을 넘은 날의 흐름을 적었다 — 첫 쪽 `totalCount` 로 알고 그 날에서 멈춤, 등록 상품 콘텐츠마다 `detailIntro2` 1콜(예산 게이트), 전부 확인해야 `last_covered` 를 올림. 20쪽까지 읽고 나머지를 버린 채 `HIDDEN_OVERFLOW` 로 적고 `last_covered` 를 그 날짜로 올렸다.
	v2.60 (2026.09.26) — #858: 4-4 콘텐츠 조회(`GET /contents/{contentId}`)에 `cpyrhtDivCd` 를 싣고, 5-3 장소 확정 응답의 `sourceBadge.note` 를 받은 값이 `Type3` 일 때만 「변경금지」(아니면 `null`)로 고쳤다. 확정 응답이 값과 무관하게 「변경금지」 여서 Type1 인 오죽헌에도 붙었다.
	v2.59 (2026.09.26) — #857: 4-5 검수 이력(`GET /products/{productId}/audit-runs`)에 `activeJobId`(지금 도는 검수 작업, 없거나 멈췄으면 `null`)를 더하고, 5-4 에 다시 연 결과 화면이 그 작업을 이어 폴링하며 간격은 202 응답의 `pollIntervalMs` 라고 적었다. 재검수 중에 결과 화면을 다시 열면 도는 작업을 알 길이 없었고, 폴링은 생성 응답의 2초를 버리고 1.5초로 돌았다.
	v2.58 (2026.09.26) — #850: 4-10 `GET /plan/place-detail` 에 `with`(무장애 · 반려동물 축) · `contact` 를 더했다. 카드 「자세히」가 목록의 해당 여부 한 줄만 적어 두 서비스의 상세 오퍼레이션이 한 번도 불리지 않았다 — 1차 심사로 낸 기능설명서는 상세로 「펼친 장소 카드의 동반 조건 · 무장애 정보」를 보인다고 적었다. 「무장애 · 반려동물은 목록 응답에 이미 있어 여기서 내지 않는다」는 문장을 뺐다.
	v2.57 (2026.09.26) — #838: 4-5 에 `GET /audit-availability`(지금 검수를 시작할 수 있는지 · 다시 열리는 때)를 더했다. UI-ST-007 이 요구한 「누르기 전에 버튼을 막고 재개 시점을 안내」를 화면이 할 수 없었다 — 눌러야 429 로 알았다. 검수 429 문장도 다른 조회와 같은 말(「내일 0시부터 다시 검수할 수 있고 …」)로 바꿨다.
	v2.56 (2026.09.26) — #840: 3-4 로그인 시도 행 — 공개된 테스트 계정은 로그인에 성공할 때마다 알림 확인 처리를 되돌린다(무시한 알림 제외). 같이 쓰는 심사위원 가운데 처음 레이더를 연 사람만 "새로"를 봤다.
	v2.55 (2026.09.25) — #832: 4-10 `plan/places` 의 `scope.label` — `together` 로 순위를 매기면 기준 연월(「2026년 8월 기준 함께 많이 가는 순」)을 붙인다. EI-KT-024 가 요구한 표기가 화면에 없었다.
	v2.54 (2026.09.25) — #819: 5-5 `counts` 와 목록 `latestAudit.counts` 가 무시한 판정까지 세고 있어 89점 옆에 「주의 3건 −12점」 이 나왔다. 두 곳 모두 무시한 판정을 뺀 건수로 맞추고(FR-AU-046), 목록 절의 「무시한 것까지 센 값」 문장을 고쳤다. 5-5 `scoreBreakdown.scoredCounts`(감점에 쓴 건수)를 더했다.
	v2.53 (2026.09.25) — #813: `GET /usage/budget` 행과 8-2 주석 · 요구사항 대응표의 「계정 메뉴의 오늘 사용량」 · 「호출량 화면」 · 「예산 위젯」 을 운영자 조회로 고쳤다(09-18 #532).
	v2.52 (2026.09.25) — #808: 5-7 출발 전 확인 항목의 `note` 를 「출발이 가까워 자동으로 올린 항목이며 감점하지 않습니다」 로 바꿨다 — 화면에 그대로 나간다. 이 항목은 R05 가 출발 1일 이내 상품에 만든다(규칙셋 1.2.8).
	v2.51 (2026.09.25) — #806: 5-9 전후 비교 응답에 `schedule`(반영 기록의 전후 일정)을 더했다. 이름은 응답에만 채우고 좌표 · 분류는 뺀다.
	v2.50 (2026.09.25) — #804: 4-2 · 5-2 상품 목록에 알림 수 둘을 더했다 — `activeNotifications`(무시하지 않은 알림) · `risksSinceAudit`(알림 뒤에 다시 검수하지 않은 바뀐 정보). 셋 다 여행이 끝난 상품이면 0 이다(전에는 `unreadNotifications` 가 끝난 상품도 셌다). 4-8 확인 처리를 레이더가 카드를 보일 때 부른다고 적었다.
	v2.49 (2026.09.25) — #799: 3-4 로그인 시도 행을 실제 제한으로 고쳤다 — 계정 단위 10분 10회, 공개 테스트 계정 제외, IP 를 쓰지 않는 이유. 그전에는 제한 자체가 없었다. 검수 실행 · 리포트 생성의 분당 상한은 아직 없다(공용 테스트 계정에서 심사위원끼리 막힐 수 있어 보류 · 동시 실행 3건 상한은 있다).
	v2.48 (2026.09.25) — #793: 8-2 에 공사 응답 우선(한도 초과 22 가 오늘 있으면 다 쓴 것)과 검수 도중 인증 오류 · 한도 초과 때 남은 조회를 멈춘다는 것을 적었다. 배치도 같은 예산 문을 쓴다.
	v2.47 (2026.09.25) — #789: 8-2 국문 예산 분모의 증설 마지막 날을 코드 상수에서 `system_setting.kor_quota_raised_until` 로 옮겼다. 설정 조회는 행을 `to_jsonb` 로 읽어 칸이 아직 없는 DB 에서도 깨지지 않는다.
	v2.46 (2026.09.25) — #777: 8-2 국문 예산 분모에 증설 종료(2026.10.11)를 넣었다. 10.12 부터 DB 값이 800 을 넘어도 800 이다(`korDailyQuota`). 검수 예산 문이 `system_setting.daily_quota` 를 안 읽고 코드 기본값 8,000 을 쓰던 것도 같이 고쳐, 검수 · 배치 · 기획 조회 · 호출량 화면이 한 곳을 읽는다고 적었다. 머리표가 v2.44 에 멈춰 있어 함께 맞췄다.
	v2.45 (2026.09.22) — #762: 4-2 place-facts · place-detail 의 글자 값(이용시간 · 쉬는 날 · 요금 · 주차)에서 원문의 `<br>` 을 개행으로 바꿔 보낸다. 기획 화면 장소 정보 한 줄과 장소 담기 「자세히」 가 태그를 글자 그대로 찍었다(세인트존스 호텔 · 초당할머니순두부 실측). 지문 · 판정 · 저장은 그대로다 — 엔진은 이미 해석 입력에서 같은 처리를 한다.
	v2.44 (2026.09.22) — #745: 6-2 콘텐츠 단위 격리에 표출 중단의 예외를 더했다. 상세 조회에는 `showflag` 가 없어 숨은 곳이 0건으로 오고, 검수가 그것을 조회 실패로 격리해 확인 불가로만 내고 있었다. 검수가 알림의 표출 중단 기록을 읽는다(`NotificationRepository.hiddenContentIds`).
	v2.43 (2026.09.22) — #743: 화면 문구의 「견줄」 을 「비교할」 로 맞췄다(알림 카드 · 전후 비교 안내 · 변경 판정 라벨). 같은 뜻을 「전후 비교」 와 다른 낱말로 적고 있었다.
	v2.42 (2026.09.22) — #739: `POST /patch-preview` 의 `before` · `after` 가 이름이 빈 **걷기 길** 항목(`walk_id`)도 채운다. 상품 응답 · 리포트와 같은 이름 조회(10분 캐시)를 쓰고, 못 찾으면 「걷기 길」 이다. #713 은 관광지(`kto_content_id`)만 채웠다. 저장값과 `previewToken` 은 그대로다(DR-MD-005).
	v2.41 (2026.09.22) — #738: 5-9 에 빈 일정의 출시 거절을 더했다. 검수(차단 0) 뒤 항목을 전부 지우면 `POST /release` 가 200 이었다 — #710 의 시각 비교는 남은 항목이 있어야 한다.
	v2.40 (2026.09.22) — #735: `POST /radar/today` 의 `action` 에 `VIEW_RESULT` 를 더했다 — 그 상품의 바뀐 정보 알림이 전부 마지막 검수(`audit_run.created_at`)보다 앞일 때다. 화면 버튼은 「검수 결과 보기」 이고 가는 곳은 `REAUDIT` 과 같다.
	v2.39 (2026.09.21) — #728: `REPLACE_CONTENT` payload 에 선택 필드 `fromItemId` 를 더했다 — `distanceMeters` 를 잰 기준 항목이다. R08 은 앞 항목 주변에서 찾으므로 그 항목 id 가 실리고, 없으면 바꿀 장소 자리에서 잰 거리다. 화면은 「앞 일정 ○○에서 약 400m」 · 「지금 장소에서 약 1.3km」 로 적는다. 후보 정렬 · 제외 규칙은 기능 요구사항 FR-PA-003 · FR-RU-043.
	v2.38 (2026.09.21) — #712 · #713: `PUT /settings` 가 `watchRegions` 의 같은 (시도 · 시군구 · 달)을 하나로 접는다(한도는 접은 뒤에 센다). `POST /patch-preview` 의 `before` · `after` 는 이름이 빈 항목(장소 담기 · 수정안 삽입)의 이름을 응답에만 채우고 `previewToken` 은 채우기 전 항목으로 만든다. 판정 문구의 R07 「식사()가 …」 는 표시할 때 대상 항목 이름으로 채우고, 못 얻으면 괄호를 지운다. 저장값은 그대로다(DR-PR-001).
	v2.37 (2026.09.21) — #710 · #711: 5-9 「현재 결과」 에 사람이 일정을 고친 경우를 더했다. 검수한 뒤 일정 편집으로 차단이 생기는 일정을 만들고도 재검수 없이 출시 승인이 통과했다(PM-NG-002). 상품 상세에 `auditState` 를 실어 화면이 새로 고쳐도 「바뀌기 전 결과」 안내와 출시 · 리포트 잠금을 유지한다. 스키마 변경은 없다. 검수 시작 직후 결과 화면은 첫 결과가 생길 때까지 이력을 다시 읽는다 — 「검수 실행」 을 보여 같은 일정을 두 번 검수하게 했다.
	v2.36 (2026.09.21) — #703: 4-8 `GET /notifications` 에 `schedule` · `changes` · `current` · `modifiedOn` · `eventPeriod` · `overlapDays` 를 더하고 `what` · `impact` 를 그 사실로 만들게 했다. 카드 넷이 장소 이름만 다르고 세 문장이 같았다 — 판독 결과 전 → 후와 `place_label` 조인이 `radar/changes` 에만 있고 화면은 그 엔드포인트를 안 불렀다. 8-1 에 조건 3 알림의 `body.eventPeriod` 를 적었다. 연쇄 개정: 화면 요구사항 UI-S7-005 · DB 명세서 4-5.
	v2.35 (2026.09.21) — #704: 8-1 4단계에 조건 1 에서 넘긴 상품을 조건 2 · 3 이 다시 잡지 않는다는 것을 적었다(FR-MO-030 v2.20).
	v2.34 (2026.09.21) — #700: `/health` 에 `checks.ktoReachable` 과 503 조건을 적었다(NF-AV-004 v1.9).
	v2.33 (2026.09.21) — #697: 4-8 이름 조회를 동시 6곳 · 부분 결과로 고쳤다. 순서대로 읽어 12곳에 3초가 걸렸고, 한도를 넘으면 읽은 것까지 버려 첫 화면에 이름이 하나도 안 붙었다.
	v2.32 (2026.09.21) — #694: 4-8 `GET /notifications` 의 이름 조회에 시간 한도(2.5초)를 적었다. 공사 호출이 막힌 동안 이 목록이 30초 뒤 500 을 돌려줬다 — 실패는 흘려보냈지만 느린 것은 막지 않았다.
	v2.31 (2026.09.21) — #690: 8-1 4단계에 감시 대상 상한이 계정별임을 적었다(FR-MO-020 v2.19).
	v2.30 (2026.09.21) — #689: 8-1 4단계에 조건 3 의 지역 범위를 적었다. 행사 기간과 여행일만 견줘 다른 지역 행사 알림이 갔다. 기능 요구사항 FR-MO-030 v2.18 과 같이 고쳤다.
	v2.29 (2026.09.21) — #685: 4-8 `GET /notifications` 행에 `placeName` 을 더했다. 카드가 조건별 고정 문장만 보여 어느 행사 · 어느 곳이 바뀌었는지 알 수 없었다(UI-S7-003 은 바뀐 것과 해당 일정을 먼저 보이라고 한다). 이름은 저장하지 않고 상품 상세와 같은 방식으로 표시 시점에 읽는다. 표출 중단 콘텐츠는 이름을 내보내지 않고, 조회 실패는 `null` 로 흘려 목록을 막지 않는다.
	v2.28 (2026.09.21) — #684: 5-2 상품 목록의 `latestAudit.readinessScore` 가 조회 시점 재계산 값임을 적었다. 구현이 `audit_run` 저장값을 그대로 돌려줘, 판정을 무시한 상품의 점수가 목록(79점)과 결과 화면(83점)에서 달랐다. FR-AU-046 은 대시보드 · 결과 · 전후 비교 · 리포트에 같은 규칙을 요구한다. 계약 필드는 그대로다.
	v2.27 (2026.09.20) — #650: 4-8 에 `GET /radar/region-signals/detail` 을 더했다. 상품별 신호에만 「무엇인지」가 있고 관심 지역 카드에는 없었다. 요청 계정의 관심 지역인지 먼저 보고(아니면 404) 나머지는 상품 쪽과 같은 경로를 쓴다. 화면 요구사항 v2.15 와 연쇄 개정.
	v2.26 (2026.09.20) — #644: 4-8 에 `GET /radar/signals/detail` 을 더했다. 건수만 있고 무엇인지 볼 방법이 없어 레이더가 읽히지 않았다. 세는 조회를 한 번 더 부르고 세는 조건을 그대로 쓴다. 이름은 표시용으로만 나가고 저장하지 않는다. 기능 요구사항 v2.16 · 화면 요구사항 v2.14 와 연쇄 개정.
	v2.25 (2026.09.20) — #615: 「기존 상품 복사」 를 입력 방식에서 뺐다. 코드에 복사 진입점도 `/duplicate` 엔드포인트도 없어 문서에만 있던 기능이다. 입력 방식은 직접 입력 · 엑셀 올리기 · 메모 붙여넣기 3종이다. 4-2 의 `POST /products/{productId}/duplicate` 행을 뺐다 — 구현된 적이 없다. 기능 요구사항 v2.15 와 연쇄 개정.
	v2.24 (2026.09.20) — #635: 12 추적표의 F17 범위를 `FR-PL-001 – 023` 으로 고쳤다. 022(#525) · 023(#575) 이 들어올 때 이 줄을 안 고쳤다. 계약 변경은 없다.
	v2.23 (2026.09.20) — #631: 이미 고친 것이 남아 있던 두 자리를 정정했다. 4-7 리포트 콜아웃의 사유코드 42 → 43종(#612 로 `INPUT_INVALID` 를 넣고 여기를 안 고쳤다), 8-2 예산 관리자 콜아웃의 「계정 메뉴의 오늘 사용량」 — #532 로 계정 메뉴에서 뺐는데 문서에는 남아 있었다. 계약 · 화면 변경은 없다.
	v2.22 (2026.09.20) — #602 · #606: 6-1 8단계. 위치기반 상한을 **차단부터** 쓰고 같은 등급 안에서만 굶는 finding 을 앞세운다 — 원래 순서가 규칙 번호 순이라 같은 R01 안에서도 주의가 차단보다 앞섰다. TP-03 리플레이에서 **차단인 휴무일에 대체 수정안이 하나도 안 붙었다**(사용자는 재검수해야 봤다). 상한은 3 → 4콜이다. 3콜로 등급 순을 쓰면 마지막 확인 불가가 갖고 있던 대체를 잃는다. 5-7 — 라벨이 빈 항목(장소 담기 · 삽입 확정)의 이름과 판정 문장 앞의 이름을 표시 시점에 채운다. 「 — 휴무일 정보를 확인할 수 없습니다」 처럼 앞이 빈 줄이 뜨던 것을 고쳤다. 판정 · 감점 · 저장 형식은 그대로다.
	v2.21 (2026.09.20) — #616: 8-1 4단계. 기회 알림(조건 4 ~ 6)을 배치에 연결했다 — 판정 함수가 있었는데 아무도 부르지 않아 새 소식이 늘 0건이었다. 새로 등록된 곳만 보고, 배치 한 번에 상품당 3건까지(결손 유형 먼저), 같은 곳은 한 번만 권한다. 조건 2 · 4 ~ 6 의 같은 시군구 비교에 시도 코드를 더했다(춘천 51-110 과 종로 11-110 이 같은 곳으로 걸렸다). 기능 요구사항 v2.12 와 연쇄 개정.
</callout>
