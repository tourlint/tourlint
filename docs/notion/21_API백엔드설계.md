<callout icon="🔌" color="blue_bg">
	# TourLint API · 백엔드 설계
	**내부 REST API 계약 · 모듈 구조 · 규칙엔진 · 외부 어댑터 · 오류 코드 체계**
	본 문서는 `서비스 기획서`와 `통합 요구사항 명세서`(서비스 범위 · 용어 정의 · 기능 · 화면 · 권한 · 데이터 · 비기능 · 외부 연동 · 예외처리)만을 근거로 전면 재작성되었습니다.
</callout>
<table fit-page-width="true" header-row="true">
<tr>
<td>문서</td>
<td>API · 백엔드 설계 v2.0</td>
</tr>
<tr>
<td>작성일</td>
<td>2026.08.15</td>
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
<td>LLM 호출 경로는 F01 구조화 · F03 정규화 **2곳뿐**. **등급·점수·충돌 판정 경로에 LLM이 없다** (EI-LM-001). 설명문 생성은 결정론성 때문에 쓰지 않는다</td>
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
│       │   ├── rules          r01-operating ~ r08-travel · types · rule 인터페이스
│       │   ├── normalize      운영정보 해석기 (preprocess · parse · closed · hours · merge)
│       │   ├── fingerprint    지문 생성 · 비교 (build · compare)
│       │   ├── itinerary      dwell — 체류시간 보완
│       │   ├── calendar       dates · holidays (공휴일 표)
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
│       ├── persistence        db (pg 풀 · 트랜잭션)
│       │   ├── audit-result.repository       audit_run · finding · content_fingerprint
│       │   ├── patch-application.repository  일정 쓰기 · 패치 이력
│       │   └── api-call-log.repository
│       │
│       ├── external           외부 어댑터 (EI-CM-003)
│       │   ├── kto            transport · envelope · client · errors · factory
│       │   ├── kakao          KakaoMobilityClient (R08 이동시간)
│       │   ├── kma            grid — 위경도 → 격자 (R09 우천, 구현 중)
│       │   ├── llm            anthropic.provider · client · 스키마 검증
│       │   ├── http-client    연결 3초 · 응답 10초 분리
│       │   ├── budget-guard   예산 80% / 100% 게이트
│       │   └── api-call-log   전 호출 계측
│       │
│       ├── health             GET /health — 배포 후 확인 목록
│       └── mock               교체 대기 라우트. 실엔진으로 바뀌면 즉시 삭제 (NF-CO-002)
│
├── apps/web                   Next.js 16 + React 19
└── packages/shared            사유코드 39종 · 등급 · 실내외 시드 등 공용 상수
```
<callout icon="⚖️" color="blue_bg">
	**판정 엔진이 `audit` 밑이 아니라 `engine` 으로 분리돼 있습니다.**
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
<td>`page`(0부터) · `size`(기본 20 · 최대 100) · `sort`. 응답은 `content` `page` `size` `totalElements` `totalPages`</td>
</tr>
<tr>
<td>멱등성</td>
<td>조회는 멱등. **패치 확정 · 출시 승인 등 상태 변경 요청은 자동 재시도하지 않는다** (EX-CM-008)</td>
</tr>
<tr>
<td>실시간 통신</td>
<td>**SSE · WebSocket 미사용.** 진행 상태는 2초 간격 폴링 (FR-AU-022)</td>
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
<td>사유 코드 38종 중 하나. **화면에 그대로 노출하지 않는다** (G-015 · EX-MS-002)</td>
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
<td>조회 · 갱신 성공. **외부 호출 실패로 확인 불가가 생긴 경우도 200**</td>
<td>–</td>
</tr>
<tr>
<td>201 Created</td>
<td>상품 · 일정 항목 · 리포트 생성</td>
<td>–</td>
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
<td>`UPLOAD_FORMAT_INVALID` `DAY_COUNT_MISMATCH` `UPLOAD_LIMIT_EXCEEDED`</td>
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
<td>422 Unprocessable</td>
<td>선행 조건 미충족</td>
<td>`PLACE_UNRESOLVED`</td>
</tr>
<tr>
<td>429 Too Many Requests</td>
<td>호출 빈도 제한 · 예산 소진</td>
<td>`BUDGET_EXHAUSTED` `KTO_QUOTA_EXCEEDED`</td>
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
<td>계정당 분당 5회</td>
<td>NF-SC-010 · EX-SY-008</td>
</tr>
<tr>
<td>로그인 시도</td>
<td>계정·IP 단위 제한</td>
<td>NF-SC-010</td>
</tr>
<tr>
<td>리포트 생성</td>
<td>계정당 분당 5회</td>
<td>NF-SC-010</td>
</tr>
<tr>
<td>진행 상태 폴링</td>
<td>제한 없음 (2초 간격 전제, p95 300ms 목표)</td>
<td>NF-PF-003</td>
</tr>
</table>
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
<td>`/api/v1/auth/signup`</td>
<td>회원가입. 이메일 중복 시 상세 사유를 알리지 않고 거부</td>
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
<td>상품 목록. 대시보드용 — 출시 준비도 · 등급별 건수 · 미확인 알림 건수 포함</td>
<td>FR-CM-005</td>
</tr>
<tr>
<td>POST</td>
<td>`/api/v1/products`</td>
<td>상품 생성 (기본정보 + 상품 성격 + 이동수단)</td>
<td>FR-CM-006 · FR-IN-004·007·008</td>
</tr>
<tr>
<td>GET</td>
<td>`/api/v1/products/{productId}`</td>
<td>상품 상세 + 일정 전체 + 최신 검수 요약</td>
<td>FR-CM-006</td>
</tr>
<tr>
<td>PATCH</td>
<td>`/api/v1/products/{productId}`</td>
<td>상품 기본정보 수정</td>
<td>FR-CM-006</td>
</tr>
<tr>
<td>DELETE</td>
<td>`/api/v1/products/{productId}`</td>
<td>상품 삭제 (종속 데이터 연쇄 삭제). 확인 단계 필수</td>
<td>FR-CM-006 · DR-LC-002 · EX-MS-006</td>
</tr>
<tr>
<td>POST</td>
<td>`/api/v1/products/{productId}/duplicate`</td>
<td>상품 복제 (C등급)</td>
<td>FR-CM-007</td>
</tr>
<tr color="red_bg">
<td>POST</td>
<td>`/api/v1/products/{productId}/release`</td>
<td>**출시 승인. 최신 검수의 차단이 1건 이상이면 403 ****`FORBIDDEN_ACTION`****으로 거부**</td>
<td>PM-NG-002 · EX-AU-008 · DR-IN-007</td>
</tr>
</table>
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
<td>일정 항목 추가</td>
<td>FR-IN-014</td>
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
<td>`/api/v1/products/{productId}/items/import`</td>
<td>엑셀·CSV 업로드 → **미리보기 반환**. 사용자 확정 전에는 저장하지 않음</td>
<td>FR-IN-002·015</td>
</tr>
<tr>
<td>POST</td>
<td>`/api/v1/products/{productId}/items/parse-text`</td>
<td>자연어 텍스트 → LLM 구조화 → **미리보기 반환**</td>
<td>FR-IN-003·013</td>
</tr>
<tr>
<td>POST</td>
<td>`/api/v1/products/{productId}/items/commit`</td>
<td>미리보기 확정 저장</td>
<td>FR-IN-013</td>
</tr>
<tr>
<td>GET</td>
<td>`/api/v1/templates/itinerary-form.xlsx`</td>
<td>지정 양식 파일 내려받기</td>
<td>FR-IN-002</td>
</tr>
</table>
<callout icon="📥" color="yellow_bg">
	**업로드 상한과 거부 규칙**
	파일 5MB · 500행 초과 → 파싱 전에 400 `UPLOAD_LIMIT_EXCEEDED`
	유효 일정 항목 45건 초과 → 400 `UPLOAD_LIMIT_EXCEEDED` + 상품 분할 안내 (NF-CP-003)
	자연어 입력 5,000자 초과 → 400
	일부 행 형식 오류 → **200 + 정상 행 유지 + 실패 행 번호·사유 반환** (전체 거부 아님)
	박수와 일자별 일정 수 불일치 → 400 `DAY_COUNT_MISMATCH`
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
<td>장소명으로 공사 키워드 검색 프록시. 파라미터 `keyword` `regnCd` `signguCd` `page` `size`</td>
<td>FR-IN-020 · PM-SC-002</td>
</tr>
<tr>
<td>POST</td>
<td>`/api/v1/items/{itemId}/match`</td>
<td>`contentid` 확정. 확정 시점의 실시간 정보를 함께 반환</td>
<td>FR-IN-027·028</td>
</tr>
<tr>
<td>POST</td>
<td>`/api/v1/items/{itemId}/exclude`</td>
<td>"해당 없음" 처리. 항목은 유지하고 `EXCLUDED`로 전환</td>
<td>FR-IN-024·025</td>
</tr>
<tr>
<td>GET</td>
<td>`/api/v1/contents/{contentId}`</td>
<td>관광지 상세 실시간 조회. **DB에서 읽지 않는다**</td>
<td>DR-PR-004 · FR-IN-030</td>
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
<td>분류체계 코드. `level` `parentCode` 계층 조회. 수집된 기준 테이블에서 응답</td>
<td>FR-OP-023 · EI-KT-015</td>
</tr>
</table>
<callout icon="📍" color="blue_bg">
	**`/contents/search`****는 검색 결과가 10건 이상이면 상품 지역(법정동 코드)으로 자동 필터링**하고, 응답에 `regionFilterApplied: true`를 함께 반환해 화면이 해제 수단을 제공할 수 있게 합니다 (FR-IN-023 · EX-MC-003).
	검색 호출 자체가 실패하면 항목을 `PENDING`으로 두고 재시도 수단을 제공합니다. **검수 제외로 자동 전환하지 않습니다** (EX-MC-004).
</callout>
## 4-5. 검수 (F04 \~ F07)
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
<tr color="orange_bg">
<td>GET</td>
<td>`/api/v1/audit-jobs/{jobId}`</td>
<td>**진행 상태 폴링 (2초 간격).** 상태 · 진행률 · 완료 시 `auditRunId`</td>
<td>FR-AU-022·023 · NF-PF-003</td>
</tr>
<tr>
<td>GET</td>
<td>`/api/v1/audit-runs/{runId}`</td>
<td>검수 결과 요약 — 등급별 건수 · 출시 준비도 · 총 감점 · 검수 근거</td>
<td>FR-AU-040\~050·065</td>
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
<td>무시 처리. **`severity = BLOCKER`****이면 403 ****`FORBIDDEN_ACTION`**</td>
<td>PM-NG-001 · EX-AU-009</td>
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
<td>확인 필요 항목 "확인함" 체크. **확인 결과 값은 받지도 저장하지도 않는다**</td>
<td>FR-AU-083·084 · PM-NG-006</td>
</tr>
<tr>
<td>GET</td>
<td>`/api/v1/rules`</td>
<td>**규칙 목록 — 10개 코드 · 명칭 · 기본 등급 · 버전 · 외부 데이터 필요 여부**</td>
<td>FR-RU 6장 공통 AC</td>
</tr>
<tr>
<td>GET</td>
<td>`/api/v1/products/{productId}/audit-runs`</td>
<td>검수 실행 이력 목록 (전후 비교 선택용)</td>
<td>FR-PA-045</td>
</tr>
</table>
<callout icon="🚫" color="red_bg">
	**존재해서는 안 되는 엔드포인트**
	`PATCH /audit-runs/{runId}` · `DELETE /audit-runs/{runId}` · `PATCH /findings/{id}` (판정 내용 수정)
	과거 검수 실행 결과는 불변 기록이므로 **수정 요청 경로 자체가 존재하지 않아야 합니다** (PM-NG-004 · EX-AU-010). DB 트리거로도 이중 차단합니다.
</callout>
## 4-6. 패치 (F08 \~ F10)
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
	**패치 확정 거부 조건** (2026.08.23 · F09 구현에서 ③\~⑤ 추가)
	① `PATCH_CONFLICT` (409) — 선택한 수정안 사이에 충돌이 있으면 확정을 차단하고 **어느 두 수정안이 충돌하는지 지목**합니다. 시스템이 자동으로 하나를 해제하지 않습니다 (FR-PA-006).
	② `PATCH_STALE` (409) — 미리보기 이후 일정이 다른 경로로 변경되었으면 거부하고 재검토를 유도합니다. 오래된 스냅샷 기준 덮어쓰기를 막습니다 (EX-PA-002).
	③ `PATCH_STALE` (409) — 선택한 수정안의 **대상 일정이 사라졌으면** 통째로 거부합니다. 미리보기는 못 넣은 것을 알려 주기만 하면 되지만, 확정에서 나머지만 반영하면 사용자가 고르지 않은 조합이 일정이 됩니다.
	④ `PATCH_STALE` (409) — **검수가 진행 중이면** 받지 않습니다. `uq_job_active` 때문에 이때 만든 재검수 요청은 진행 중인 작업을 그대로 돌려받는데, 그 작업은 **패치 전 일정**을 보고 있어 바뀐 일정의 재검수가 영영 돌지 않습니다. 사유코드 39종에 "진행 중"이 없어 확정의 전제가 흔들린 경우로 묶습니다.
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
<td>PDF 리포트 생성 (서버 사이드 렌더링). 201 + `reportId`. **가장 최근 검수 실행만** 대상이며 아니면 409 `REPORT_FAILED`</td>
<td>FR-PA-060·066</td>
</tr>
<tr>
<td>GET</td>
<td>`/api/v1/reports/{reportId}/download`</td>
<td>PDF 다운로드. **인증 필수. 공개 링크를 발급하지 않는다**</td>
<td>PM-DA-007</td>
</tr>
</table>
<callout icon="🗂" color="orange_bg">
	**`reportId` 는 테이블 행이 아닙니다** (2026.08.29 · F11 구현)
	DB 명세서 6-4 가 PDF 를 서버에 남기지 못하게 하고 `report` 테이블은 엔터티 19종에 없습니다. `POST` 가 렌더까지 끝내고 결과를 **프로세스 메모리에 5분** 들고 있으며 `reportId` 는 그 보관 키입니다. `GET .../download` 는 그것을 스트리밍하고, 수명이 지났거나 소유자가 아니면 404 입니다 (존재 여부 비노출).
	두 단계를 합치지 않은 이유는 PM-DA-007 의 인수조건이 "리포트 다운로드 URL 을 로그아웃 상태에서 열면" 이라 열어 볼 URL 이 있어야 하기 때문입니다. 매번 재생성하지 않는 이유는 공사 재조회가 다운로드마다 나가기 때문입니다.
	⚠️ 인스턴스를 늘리면 만든 곳과 받는 곳이 갈려 깨집니다. 다중화 시 이 절을 다시 봅니다.
</callout>
<callout icon="📄" color="gray_bg">
	**가장 최근 검수 실행만 리포트로 만듭니다** (2026.08.29 · F11 구현)
	`audit_run` 에는 일정 스냅샷이 없어 일정표(FR-PA-061 ③)와 검수 제외 항목 건수(FR-PA-064)는 조회 시점의 `itinerary_item` 을 읽어야 나옵니다. 과거 실행으로 리포트를 만들면 **그때의 판정과 지금의 일정**이 한 문서에 섞입니다.
	거절은 409 `REPORT_FAILED` 이며 다시 검수한 뒤 내려받도록 안내합니다. 사유코드 39종에 "최신이 아님" 이 없어 재시도 유도가 붙은 리포트 생성 거절(EX-AU-011)로 묶었습니다.
</callout>
## 4-8. 수요·변경 레이더 (F12 \~ F14)
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
<td>레이더 요약 — 변경 콘텐츠 건수 · T1 · T2 · 영향 상품 수 · 마지막 배치 상태</td>
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
<td>수요 신호 T1 · T2. **`productId` 필수** — T2 조회 창이 그 상품의 여행일에서 나옵니다</td>
<td>FR-RU-110\~122</td>
</tr>
<tr>
<td>GET</td>
<td>`/api/v1/notifications`</td>
<td>알림 목록. `kind=RISK|OPPORTUNITY` · `unread=true`</td>
<td>FR-MO-033·035</td>
</tr>
<tr>
<td>POST</td>
<td>`/api/v1/notifications/{id}/read`</td>
<td>확인 처리</td>
<td>FR-CM-005</td>
</tr>
<tr>
<td>POST</td>
<td>`/api/v1/notifications/{id}/dismiss`</td>
<td>무시. **비표출 전환 알림이면 403 ****`FORBIDDEN_ACTION`**</td>
<td>FR-MO-037 · PM-NG-010 · EX-MO-010</td>
</tr>
</table>
<callout icon="📡" color="blue_bg">
	**T1 · T2 는 배치가 미리 산출합니다** (2026.08.30 결정 · DB 명세서 v1.9)
	조회 시점에 공사를 부르면 레이더 화면을 열 때마다 예산이 나갑니다. `SignalBatchJob` 이 변경 감지 배치에 이어 돌면서 지역 · 구간별로 `demand_signal` 에 넣고, **세 조회 경로는 공사 호출이 0건**입니다.
	같은 창은 한 번만 부릅니다 — 상품 열 개가 모두 강릉이면 T1 창이 같습니다. T2 는 여행일에서 나오므로 지역이 같아도 일정이 다르면 창이 다릅니다.
	**산출 전은 `null` 이고 0 이 아닙니다.** 0 은 「세어 보니 없었다」이고 `null` 은 「아직 안 세어 봤다」입니다. 화면이 둘을 구분해야 합니다.
</callout>
<callout icon="🔍" color="gray_bg">
	**`radar/changes` 의 판독 결과 변화는 있을 때만 실립니다** (FR-MO-006 · 2026.08.30)
	「휴무일 월 → 월·화」 형태는 `content_fingerprint.normalized_json` 을 전후로 맞대 만듭니다. 그 값은 **검수 실행에만 딸려 있어** 재검수가 돌아 지문이 두 번 이상 쌓인 콘텐츠에만 있습니다. 없으면 `readableChanges` 가 빈 배열이고 `hasReadableDiff` 가 `false` 입니다 — **빈 배열을 「바뀐 것 없음」으로 읽으면 안 됩니다.**
	지문 비교값(FR-MO-058)은 알림에 저장돼 있어 항상 실리되, 조건 2 · 3 은 지문 이력이 없어 둘 다 `null` 입니다.
</callout>
<callout icon="🔁" color="blue_bg">
	**"지금 재검수"는 별도 엔드포인트가 아닙니다.** `POST /products/{id}/audit-jobs` 에 `triggerType: "MANUAL"` 로 요청하며, 이 경로만 **예산 100%까지 허용**됩니다 (자동 배치는 80%에서 중지, FR-OP-003 · FR-MO-017).
</callout>
## 4-9. 운영 — 예산 · 설정 · 헬스 (F15 · F16)
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
<td>오늘 호출량 · 예산 대비 소진율 · **오퍼레이션별 상위 5개**. 집계값만 반환</td>
<td>FR-OP-005 · PM-DA-006</td>
</tr>
<tr>
<td>GET</td>
<td>`/api/v1/usage/calls`</td>
<td>일자별·오퍼레이션별 호출 이력 집계. 활용 증빙용. **개별 호출의 인증키·파라미터 미노출**</td>
<td>FR-OP-007 · NF-OB-002 · PM-SC-005</td>
</tr>
<tr>
<td>GET</td>
<td>`/api/v1/settings`</td>
<td>설정 10종 조회</td>
<td>FR-OP-021</td>
</tr>
<tr>
<td>PUT</td>
<td>`/api/v1/settings`</td>
<td>설정 저장. **다음 검수부터 적용, 과거 점수 소급 변경 없음**</td>
<td>FR-OP-026 · DR-CF-006</td>
</tr>
<tr>
<td>GET · PUT</td>
<td>`/api/v1/settings/target-profiles`</td>
<td>R10 기대 콘텐츠 프로파일 표 편집</td>
<td>FR-OP-022</td>
</tr>
<tr>
<td>GET · PUT</td>
<td>`/api/v1/settings/dwell-defaults`</td>
<td>중분류별 기본 체류시간 59행</td>
<td>FR-IN-011</td>
</tr>
<tr>
<td>GET · PUT</td>
<td>`/api/v1/settings/indoor-outdoor`</td>
<td>중분류별 실내·야외 매핑 59행</td>
<td>FR-RU-090</td>
</tr>
<tr>
<td>GET</td>
<td>`/health`</td>
<td>**인증 없이 접근 가능.** 애플리케이션 + DB 연결 상태. 내부 정보 비노출</td>
<td>NF-AV-004</td>
</tr>
<tr>
<td>POST</td>
<td>`/api/v1/demo/reset`</td>
<td>**데모 상품 초기 상태 복원.** 데모 계정(`is_demo`) 전용 — 데모 계정의 상품 · 검수 이력 · 알림을 삭제하고 리포지토리의 시드 정의로 재생성. 일반 계정 호출은 403 `FORBIDDEN_ACTION`</td>
<td>PM-TA-003 · DR-TD-007</td>
</tr>
</table>
<callout icon="⚙️" color="gray_bg">
	**설정 API에 규칙 개별 비활성화 파라미터를 두지 않습니다.** 어떤 주체도 규칙을 끌 수 없습니다 (PM-NG-003).
	**상품별 설정 덮어쓰기 파라미터도 제공하지 않습니다.** 설정 스코프는 계정 단위이며, 배치 실행 시각 · 일일 호출 예산 2종만 전역입니다 (FR-OP-024).
	**외부 시스템 연동용 API 토큰 발급 기능은 범위 밖입니다** (권한 10-2).
	**배치 실행 시각 · 일일 호출 예산은 서비스 전체에 적용되는 전역 설정입니다** (저장: 전역 1행 `system_setting`). `PUT /settings`의 이 두 항목은 전역 값을 갱신하며, 응답과 화면에 "서비스 전체 기준"을 명시합니다 (PM-DA-006 · DR-CF-007).
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
## 5-2. 상품 목록 (대시보드)
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
      "pendingMatches": 0
    }
  ],
  "page": 0, "size": 20, "totalElements": 1, "totalPages": 1
}
```
## 5-3. 장소 검색 · 확정
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
{ "contentid": "2668891" }

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
	실측상 콘텐츠 대부분이 `cpyrhtDivCd = Type3`(변경금지)이므로 **예외가 아니라 기본값으로 가정**하고 배지에 "변경금지"를 병기합니다 (FR-CM-011 · EI-KT-017).
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
	화면 이탈 후 재진입 시 `jobId`로 진행 상태를 이어서 표시합니다 (EX-AU-003).
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
    "weights": { "BLOCKER": 25, "ERROR": 10, "WARNING": 4, "UNVERIFIED": 3 }
  },
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
	`evidence.dataFingerprint`는 콘텐츠별 지문을 `kto_content_id` 오름차순으로 U+001F 연결 후 재해시한 **실행 대표 지문**의 앞 8자리입니다. 전체 값 확인 수단을 함께 제공합니다 (DR-FP-008 · UI-CM-032).
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
      "summary": "휴무일에 방문 일정이 등록되어 있습니다",
      "message": "오죽헌은 매주 월요일 휴관입니다. 10월 13일(월) 10:00 일정을 다른 날짜로 옮기거나 대체 관광지로 교체해 주세요.",
      "target": {
        "itemId": 101, "dayNo": 1, "seq": 1,
        "startTime": "10:00", "placeLabel": "오죽헌"
      },
      "targetSecondary": null,
      "requiresExternal": false,
      "externalSource": null,
      "sourceBadge": "TOURLINT_VERDICT",
      "evidenceView": {
        "aiNormalized": { "weeklyClosed": ["MON"], "confidence": "CONFIRMED" },
        "verdict": { "visitDate": "2026-10-13", "visitWeekday": "MON", "conflict": true }
      },
      "patches": [
        { "patchId": "p-1", "type": "REPLACE_CONTENT",
          "payload": { "ktoContentId": "126512", "distanceMeters": 4200 },
          "label": "선교장으로 대체 (연중무휴 · 4.2km)" },
        { "patchId": "p-2", "type": "TIME_SHIFT",
          "payload": { "newDayNo": 2, "newStartTime": "10:00" },
          "label": "방문 날짜를 10월 14일로 변경" },
        { "patchId": "p-3", "type": "REORDER",
          "payload": { "swapWithItemId": 103 },
          "label": "오죽헌과 안목해변 순서 교체" }
      ],
      "dismissible": false,
      "dismissedAt": null,
      "confirmedAt": null
    }
  ],
  "page": 0, "size": 20, "totalElements": 2, "totalPages": 1
}
```
<callout icon="📖" color="blue_bg">
	**`evidenceView`****가 판정 근거의 데이터 소스입니다.** 목록 응답에는 자체 산출물인 **AI 해석 · 판정 2단만** 담고, **공사 원문(****`ktoRaw`****)은 포함하지 않습니다.** 카드의 "판단 근거 보기" 펼침 시 `GET /api/v1/contents/{contentId}`로 그 1건만 실시간 조회해 3단 병기를 완성합니다 (FR-AU-013 · 061, 기본 접힘 — UI-S3-011 · 5-12절).
	펼침 시 표시하는 원문은 그 순간 조회한 실시간 값이며 DB에서 읽지 않습니다. `overview`를 AI로 요약·재작성해 담는 필드는 존재하지 않습니다 (FR-AU-062 · NF-CO-013).
	**`dismissible`****은 ****`severity !== "BLOCKER"`****일 때만 true**입니다. 화면 버튼 제어용이며, API·DB에서도 각각 독립적으로 차단합니다.
</callout>
**비표출 콘텐츠의 finding** — 명칭·주소를 재출력하지 않고 `contentid`와 전환 감지 시각만 담습니다 (FR-AU-071 · PM-NG-009).
```json
{
  "findingId": 9107,
  "ruleCode": "R06",
  "severity": "BLOCKER",
  "reasonCode": "CONTENT_HIDDEN",
  "summary": "표출이 중단된 콘텐츠입니다",
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
      "note": "공사 데이터의 D+1 구조적 시차로 자동 생성된 항목이며 감점 대상이 아닙니다"
    }
  ]
}
```
문의처가 없으면 `contact.tel`을 `null`로 두고 화면에 "정보 없음"을 표시합니다. **항목 자체를 숨기지 않습니다** (FR-AU-082 · EX-PS-010). 목록의 관광지명은 `place_label`(사용자 입력 · 0콜)로 표기하고, 공사 원문(`ktoRaw`) · 문의처는 **항목 펼침 시 1콜**로 실시간 조달합니다 (5-12절).
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
  "revertible": true
}
```
준비도가 하락했거나 차단이 늘어난 경우 **자동 롤백하지 않고** `warningBanner`에 경고 문구를 담고 되돌리기 수단을 제시합니다 (FR-PA-027 · EX-PA-005).
<callout icon="↩️" color="blue_bg">
	**되돌리기는 재검수를 돌리지 않습니다** (2026.08.23 · F09 구현에서 확정).
	되돌린 일정은 `before_audit_run_id`가 판정한 바로 그 일정이라, 이미 있는 결과가 곧 현재 결과입니다. 한 번 더 돌리면 같은 답을 받으려고 공사 호출을 다시 쓰는 셈입니다.
	```json
	// POST /api/v1/patch-applications/44/revert  →  200 OK
	{ "patchApplicationId": 44, "productId": 31,
	  "revertedAt": "2026-09-15T15:02:44+09:00", "restoredAuditRunId": 812 }
	```
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
      "defaultSeverity": "ERROR",      "requiresExternal": false, "basis": "KTO_ONLY" },
    { "code": "R04", "name": "콘텐츠 편중",            "version": "1.0.0",
      "defaultSeverity": "WARNING",    "requiresExternal": false, "basis": "KTO_ONLY" },
    { "code": "R05", "name": "데이터 검증 불가",       "version": "1.0.0",
      "defaultSeverity": "UNVERIFIED", "requiresExternal": false, "basis": "KTO_ONLY" },
    { "code": "R06", "name": "데이터 변경 감지",       "version": "1.0.0",
      "defaultSeverity": null,         "requiresExternal": false, "basis": "KTO_ONLY" },
    { "code": "R07", "name": "식사 · 휴식 누락",       "version": "1.0.0",
      "defaultSeverity": "WARNING",    "requiresExternal": false, "basis": "ITINERARY_ONLY" },
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
<td>1 대시보드</td>
<td>❌</td>
<td>DB — 준비도·등급 건수·알림 건수</td>
<td>**0**</td>
</tr>
<tr>
<td>2 상품 등록·일정 편집</td>
<td>❌</td>
<td>`place_label`</td>
<td>**0**</td>
</tr>
<tr>
<td>2 관광지 검색·확정</td>
<td>✅</td>
<td>그 순간 호출 (원래 그런 화면)</td>
<td>검색 1 + 확정 1</td>
</tr>
<tr color="blue_bg">
<td>**3 검수 결과 목록**</td>
<td>❌</td>
<td>`finding.message`가 DB에 저장됨</td>
<td>**0**</td>
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
<td>4 패치</td>
<td>⚠️ 대체 관광지만</td>
<td>`REPLACE_CONTENT` 수정안의 `ktoContentId` 조회</td>
<td>0\~3</td>
</tr>
<tr>
<td>5 전후 비교</td>
<td>❌</td>
<td>스냅샷 + `place_label`</td>
<td>**0**</td>
</tr>
<tr color="orange_bg">
<td>**6 PDF 리포트**</td>
<td>✅ 전량</td>
<td>생성 요청 시 재조회 (공식 명칭 + 원문 근거 필수). 콘텐츠당 `detailCommon2` + `detailIntro2` **2콜**</td>
<td>**콘텐츠 수 × 2** (8곳이면 16)</td>
</tr>
<tr>
<td>7 레이더·알림</td>
<td>❌</td>
<td>`affectedItemIds` → `place_label` 조인</td>
<td>**0**</td>
</tr>
<tr>
<td>8 설정</td>
<td>❌</td>
<td>수집된 `lcls_systm_code` 기준 테이블</td>
<td>**0**</td>
</tr>
</table>
<callout icon="📐" color="gray_bg">
	**왜 3번 화면을 접어두는가**
	3단 병기를 8개 전부 펼쳐놓으면 화면 진입 시마다 8콜이 나가고, 하루 20번만 열어도 160콜입니다. 접어두면 차단 2건의 근거만 확인해도 **2콜**입니다.
	이건 UX적으로도 낫습니다 — 근거 3단을 8개 펼쳐놓으면 화면이 읽히지 않습니다.
	예상 호출량 — 결과 화면 20회 열람 0콜 · 근거 10건 클릭 10콜 · 확인 필요 5건 5콜 · 패치 3회 9콜 · 리포트 2건 32콜 = **하루 약 56콜** (예산 800 기준 7%)
	리포트는 애초에 8콜로 적었으나 실측에서 콘텐츠당 2콜이었습니다 — `detailIntro2` 응답에 `title` 이 없고 `detailCommon2` 응답에 판정 필드가 없어(픽스처 대조) 공식 명칭과 원문 근거를 둘 다 실으려면 두 오퍼레이션이 모두 필요합니다.
</callout>
<callout icon="🔒" color="red_bg">
	**응답에 싣는 것과 저장하는 것은 다릅니다.**
	공사 원문(`ktoRaw`)과 `patches[].label`은 **근거 펼침 · 패치 화면 · 리포트 생성 등 필요한 시점의 응답에만** 실시간 조회 값으로 조립해 싣습니다. finding 목록 응답에는 포함하지 않으며(0콜 원칙), **DB에는 남지 않습니다.**
	저장되는 것은 `type` · `payload` · `reasonCode` 같은 구조화된 값뿐입니다 (DB 명세서 4-3 · 4-5절).
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
   │    weight_snapshot 기록                             │
   ├────────────────────────────────────────────────────┤
   │ 8) 수정안 생성  ← 판정 이후 별도 단계                │
   │    locationBasedList2 약 3콜 (대체 관광지)           │
   ├────────────────────────────────────────────────────┤
   │ 9) 저장                                             │
   │    audit_run + finding + content_fingerprint        │
   │    audit_job.status = DONE, audit_run_id 연결        │
   └────────────────────────────────────────────────────┘
```
<callout icon="⚡" color="orange_bg">
	**p95 목표(8곳 15초 · 12곳 20초)를 달성하는 지점은 2단계와 4단계의 병렬화입니다.**
	검수 1건은 공사 OpenAPI 약 29회(1박 2일 8곳)\~43회(2박 3일 12곳) 호출이 필요해 순차 실행으로는 목표를 맞출 수 없습니다. 동시 실행 수는 환경변수로 조정 가능하며 **기본값 8**입니다 (NF-PF-010).
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
<td>해당 콘텐츠만 확인 불가 · 나머지 정상 판정</td>
<td>`KTO_FETCH_FAILED`</td>
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
[3] LLM 정규화   스키마 고정 JSON 출력 · temperature 0 · 실패 시 1회 재시도
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
	회귀 테스트는 실측 287건(`operating_info.csv`)을 정답 데이터셋으로 사용하며 인공 데이터로 대체하지 않습니다. 골든 케이스 3건은 스키마·파서 변경 시 반드시 통과해야 합니다 (DR-TD-001\~003 · NF-MT-007).
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
<td>`https://apis.data.go.kr/B551011/KorService2`</td>
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
<td>개발계정 1일 1,000건 / 운영계정 1일 100,000건</td>
</tr>
<tr>
<td>데이터 신선도</td>
<td>국문 콘텐츠는 04:30 이후 최신 반영. 당일 수정분은 익일 조회 (D+1)</td>
</tr>
</table>
**사용 오퍼레이션 9종 (이외 호출 금지)**
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
<td>관광지 매칭 · 동명 장소 확정</td>
<td>전 규칙 선행</td>
</tr>
<tr>
<td>2</td>
<td>`detailCommon2`</td>
<td>좌표 · 수정일자 · 분류체계 · 저작권 유형</td>
<td>R06 · R08</td>
</tr>
<tr>
<td>3</td>
<td>`detailIntro2`</td>
<td>휴무일 · 운영시간 · 문의처</td>
<td>**R01 · R05**</td>
</tr>
<tr>
<td>4</td>
<td>`searchFestival2`</td>
<td>행사기간 검증 · 행사 밀도</td>
<td>**R02 · T2**</td>
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
<td>지역별 탐색 · 대체 후보 보강</td>
<td>수정안 · F13 · F14</td>
</tr>
<tr>
<td>7</td>
<td>`locationBasedList2`</td>
<td>대체 관광지 추천 (반경 20km 이내)</td>
<td>R01 · R02 · R08 수정안</td>
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
<td>실패 처리. 쿼터 초과 → 예산 관리자 통지 · 키 오류 → 운영자 알림. **둘 다 재시도하지 않음**</td>
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
- 공사 인증키와 **별개의 키**를 사용합니다 (EI-WX-001).
- 예보 결과는 발표분 단위로 캐시할 수 있습니다 (단기 1시간 · 중기 12시간). 이 캐시는 자체 판정 입력값이므로 무저장 원칙과 무관합니다 (EI-WX-007).
<callout icon="📊" color="gray_bg">
	**평년 강수일수를 파일로 받아 고정 테이블로 쓰는 것은 축소안이 아니라 정상 구현입니다.** 실시간 호출 의무는 한국관광공사 데이터에만 적용되며(SC-DT-014), 기상자료개방포털 통계는 공공누리 제1유형(출처표시)입니다.
</callout>
## 7-5. LLM 어댑터
<table fit-page-width="true" header-row="true">
<tr>
<td>허용 용도 2가지</td>
<td>금지</td>
</tr>
<tr>
<td>① F01 자연어 일정 구조화<br>② F03 운영정보 정규화 (사전 파서 실패 조각만)<br>③ finding 설명 문장 생성</td>
<td>**등급 · 점수 · 충돌 판정에 사용 금지**<br>근거 없이 휴무·운영시간·행사기간 생성 금지<br>판매량·수요 예측 금지<br>데이터 없는데 정상 판정 금지</td>
</tr>
</table>
- 정규화 호출은 **스키마 고정 JSON 출력 · temperature 0**. 출력은 스키마 검증을 거치며 불일치 시 확인 불가로 강등합니다.
- 실패·타임아웃 시 **1회 재시도** 후 해당 조각을 확인 불가로 확정하고 검수를 계속합니다.
- 전송 데이터는 해석 대상 원문 조각과 일정 텍스트로 한정합니다. 계정 정보·인증키·타 상품 데이터를 포함하지 않습니다.
- 제공자·모델명은 환경변수로 관리해 교체 가능하게 두며, 특정 모델의 응답 형식에 파서를 결합하지 않습니다.
<callout icon="🛡" color="blue_bg">
	**프롬프트 주입 방어** — 공사 원문과 사용자 입력은 LLM에 **데이터로만** 전달하고 지시문 영역과 명확히 분리합니다. 스키마 검증을 통과한 값만 사용하며, 실패하면 확인 불가로 강등합니다.
	구조적으로 **LLM 출력이 등급·점수·권한에 직접 영향을 주는 경로가 없으므로**, 주입이 성공해도 영향은 조각 1건의 확인 불가로 갇힙니다 (NF-SC-012 · EX-EI-026).
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
        ├─ 조회 0건 (평일)  → BATCH_EMPTY · last_covered 미갱신
        │                     공사 동기화 지연 신호로 간주
        ├─ 비표출 페이지 상한(20) 초과 → BATCH_HIDDEN_OVERFLOW
        │                     배치 중단 후 등록 상품 contentid 개별 확인으로 전환
        └─ 예산 소진율 80% 도달 → 중단하고 다음 회차로 이월
        │
[2단계] 변경분 중 등록 상품에 포함된 contentid만 상세 재호출
        detailCommon2 + detailIntro2
        │
[3단계] 지문 재생성 → 직전 지문과 비교 → 재판정
        │
[4단계] 영향 상품 탐색 (6조건) → notification 생성
        동일 contentid + 동일 변경 지문 쌍은 재노출하지 않음
        출발일이 지난 상품(출발일+1일 이후)은 알림 미생성
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
<td>분류체계 전체 수집 (배포 시 1회)</td>
<td>약 70콜</td>
</tr>
</table>
## 8-2. 예산 관리자 (F15)
```plain text
BudgetGuard — 공사 API 호출 직전 게이트

  소진율 < 80%   → 전부 허용
  80% <= 소진율  → BUDGET_THRESHOLD
                   자동 배치 즉시 중지
                   사용자 온디맨드 검수(MANUAL)는 계속 허용
  소진율 = 100%  → BUDGET_EXHAUSTED
                   신규 검수 차단 (429) + 재개 시점(익일 00:00 KST) 안내
                   진행 중인 검수는 끝까지 완료

공사 응답으로 쿼터 초과가 확인되면 자체 집계보다 우선해
즉시 차단하고 자체 카운터를 실제 값에 맞춰 보정한다.

quota_date는 반드시 KST 기준. UTC로 채우면 집계가 9시간 밀린다.

소진율 분모 = system_setting.daily_quota (전역 1행 · 계정별 예산 없음)
소진율 분자 = 당일 quota_date의 전역 api_call_log(provider=KTO) 합산
데모 계정 포함 전 계정이 같은 예산을 공유한다 (PM-DA-006 · DR-CF-007).
```
<callout icon="✅" color="green_bg">
	**호출 예산 관리자를 감춰진 방어 장치가 아니라 제품 기능으로 노출합니다.**
	오늘 호출량·소진율·오퍼레이션별 상위 5개를 대시보드 위젯으로 보여주며, 공공 API를 절제해 쓰는 설계 자체가 서비스의 성숙도를 드러내는 지표입니다 (NF-OB-002 · FR-OP-005).
	다만 응답은 **집계값만** 포함하며 개별 호출의 인증키·파라미터는 노출하지 않습니다 (PM-DA-006 · PM-SC-005).
</callout>
---
# 9. 오류 코드 체계
## 9-1. 사유 코드 38종과 HTTP 매핑
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
<td>400</td>
<td>거부. 누락 컬럼 명시 + 양식 링크</td>
</tr>
<tr>
<td>`UPLOAD_ROW_INVALID`</td>
<td>REQUEST</td>
<td>200</td>
<td>부분 수용. 실패 행 번호·사유 반환</td>
</tr>
<tr>
<td>`UPLOAD_LIMIT_EXCEEDED`</td>
<td>REQUEST</td>
<td>400</td>
<td>거부. 상한값 안내</td>
</tr>
<tr>
<td>`DAY_COUNT_MISMATCH`</td>
<td>REQUEST</td>
<td>400</td>
<td>거부. 비어 있는 일차 표시</td>
</tr>
<tr>
<td>`NL_STRUCTURE_FAILED`</td>
<td>REQUEST</td>
<td>400</td>
<td>거부 + 직접 입력 유도. 빈 상품 생성 금지</td>
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
<td>확인 불가. 검수는 계속</td>
</tr>
<tr>
<td>`KTO_FETCH_FAILED`</td>
<td>CONTENT</td>
<td>200</td>
<td>해당 콘텐츠만 확인 불가</td>
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
<td>신규 검수 차단</td>
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
<td>`INTERNAL_ERROR`</td>
<td>REQUEST</td>
<td>500</td>
<td>거부 + 로그 기록. **최후 수단**</td>
</tr>
</table>
<callout icon="🔀" color="yellow_bg">
	**`finding.reason_code`****에는 두 네임스페이스가 함께 기록됩니다.**
	규칙 판정 사유코드 — **15종** (R01: `REST_DAY_CONFLICT` `OPEN_HOUR_CONFLICT` `ADMISSION_CUTOFF` `IN_BREAK_TIME` `REST_DAY_UNCERTAIN` · R02: `EVENT_ENDED` `EVENT_NOT_STARTED` · R03: `TIME_OVERLAP` · R04: `CONTENT_IMBALANCE` · R07: `MEAL_REST_MISSING` `MEAL_TIME_SHORT` · R08: `TRAVEL_TIME_SHORT` · R09: `RAIN_RISK` · R10: `TARGET_MISMATCH` · F07: `PRE_DEPARTURE_CHECK`) — 전체 정의는 예외처리 4장 「규칙 판정 사유코드 목록」(EX-CM-022)
	예외 사유코드 — 위 38종
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
<td>지금 재검수</td>
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
<td>지금 재검수</td>
</tr>
<tr>
<td>지도 API</td>
<td>지수 백오프 2회</td>
<td>구간 단위 확인 불가</td>
<td>지금 재검수</td>
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
<td>일반 계정과 동일. 단 자동 배치 활성화 토글은 불가 (PM-TA)</td>
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
**용량 상한** — 동시 사용자 10명 · 계정당 상품 50건 · 상품당 일정 항목 30건 · 동시 검수 3건 · 업로드 5MB/500행 · 자연어 5,000자 · 공사 일일 호출 800건.
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
<td>FR-MO-017 지금 재검수</td>
<td>`triggerType: MANUAL` · 예산 100%까지 허용</td>
</tr>
<tr>
<td>FR-OP-005 예산 위젯</td>
<td>5-11절 `GET /usage/budget`</td>
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
<td>EX-CM-001\~011 예외 격리</td>
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
<td>NF-PF-001\~015 성능</td>
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
<td>인증 방식 상세</td>
<td>세션 쿠키 기반으로 확정했으나 세션 저장소(인메모리 vs DB)와 만료 시간이 미정</td>
<td>W2</td>
</tr>
<tr>
<td>엑셀 지정 양식 컬럼</td>
<td>양식 1종의 실제 컬럼 구성이 확정되지 않음</td>
<td>W2</td>
</tr>
<tr>
<td>LLM 제공자·모델</td>
<td>선정 및 키 발급. 파서 프로토타입과 함께 확정</td>
<td>W2</td>
</tr>
<tr>
<td>기상청 예보 API</td>
<td>공공데이터포털 활용신청(자동승인) 후 단기·중기 실호출 1회 검증</td>
<td>W3</td>
</tr>
<tr>
<td>카카오모빌리티 키</td>
<td>문서에 노출된 키 재발급 권장 · 배포 도메인 등록</td>
<td>W4</td>
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
	v1.4 (2026.08.19) — 상품 범위 확대(팀 합의 2026.08.19, 당일\~2박 3일 · 최대 12곳). **API 계약(엔드포인트 · 요청/응답 필드)은 변경 없음** — `nights`는 기존 필드이며 서버 검증 범위만 0\~2로 완화. 수치 갱신: 6-1 · 8-1 호출량(29→43콜 병기), 11장 성능 목표 이원화(8곳 15초 / 12곳 20초 — NF-PF-001 v1.1 정합), 4-3 업로드 상한 30→45건(NF-CP-003 정합).
	v1.5 (2026.08.21) — 6-4절 커버리지 목표에 분모 정의를 병기하고 기준선 수치를 재계산(71.4% · 71.1% → 85.8% · 76.7%). 종전 수치는 결측을 포함한 전체 287 기준이라 새 정의와 혼재하면 "착수 71.4% → 목표 90%"라는 틀린 서술이 남는다. API 계약(엔드포인트 · 요청/응답 필드)은 변경 없음. FR-AU-004 · DR-TD-003 · NF-OB-007 · 기획서 8-2와 동시 개정.
	v1.6 (2026.08.23) — F09 패치 확정 · 되돌리기 구현에서 확정. ① `previewToken`을 저장 키가 아니라 **일정 해시**로 정의(5-8 콜아웃) — F08이 아무것도 저장하지 않는다는 전제를 지키면서 EX-PA-002를 답할 수 있고, 충돌이 있어도 토큰은 그대로 내려간다 ② 확정 거부 조건에 ③대상 소실 · ④검수 진행 중 · ⑤예산 소진 추가(4-6 콜아웃) — 특히 ④는 진행 중인 작업을 재검수라며 내주면 패치 전 일정을 보는 작업 번호가 나가고 바뀐 일정의 재검수가 영영 돌지 않아서다 ③ 되돌리기는 **재검수를 돌리지 않고** `before_audit_run_id`를 가리킨다(5-9 콜아웃), `after_audit_run_id`가 빈 이력은 다음 사용자 검수가 채우되 되돌린 이력은 제외한다(EX-PA-004).
	v1.7 (2026.08.24) — R09 강수 판정 분기를 실측에 맞춰 정정. 중기육상예보가 **발표일 +5일부터** 시작해 `rnSt3` · `rnSt4` 필드가 없다(실호출 확인). D+3 을 중기로 보내면 빈 값을 받고 그걸 강수확률 0 으로 읽어 비 오는 날을 정상 판정하게 된다. 구간을 D+0–D+2 단기 / **D+3 단기 부분 커버리지** / **D+4–D+10 중기** / D+11 이상 평년 으로 바꾸고, 중기는 최신 발표분이 아니라 **대상 일자를 덮는 발표분**을 고르도록 했다. EI-WX-001 의 「공사 인증키와 별개의 키」 서술도 정정 — data.go.kr 은 계정당 키 하나이고 활용신청만 서비스별이다. 관련 이슈 #54 · #55.
	v1.8 (2026.08.24) — 구현 실측 대조. ① 백엔드를 Spring Boot 3 → **NestJS 10 + TypeScript** 로 정정. 아키텍처 다이어그램과 기술 스택 표가 실제와 달랐고, 기획서는 기능설명서의 원본이라 그대로 두면 제출 서류와 구동 코드가 어긋난다. 선택 근거(상시 구동 · 공용 상수 단일 출처 · eslint 로 강제하는 결정론성)도 함께 적었다 ② LLM 허용 용도를 셋 → **둘**로 정정 — finding 설명문 생성은 결정론성 때문에 쓰지 않기로 확정했고 구현의 `LlmPurpose` 도 `STRUCTURE` · `NORMALIZE` 둘뿐이다 ③ 배치를 Spring Scheduler → Node 프로세스 내 스케줄러, 배포를 Railway 로 구체화.
	v1.9 (2026.08.29) — F11 리포트 구현에서 확정. ① `reportId` 가 가리킬 행이 없다는 것을 4-7 콜아웃으로 명시 — DB 명세서 6-4 가 PDF 를 남기지 못하게 하고 `report` 테이블은 엔터티 18종에 없다. `POST` 가 렌더까지 끝내고 프로세스 메모리에 5분 들고, `GET .../download` 가 그것을 흘려보낸다 ② **가장 최근 검수 실행만** 리포트 대상이며 아니면 409 `REPORT_FAILED` — `audit_run` 에 일정 스냅샷이 없어 과거 실행으로 만들면 그때 판정과 지금 일정이 섞인다 ③ 5-12 리포트 호출 수를 8 → **콘텐츠 수 × 2** 로 정정(픽스처 실측). `detailIntro2` 에 `title` 이 없고 `detailCommon2` 에 판정 필드가 없어 둘 다 필요하다. 하루 예상 호출량 40 → 56콜 ④ 머리표 버전이 v1.5 인데 개정 이력은 v1.8 까지 있어 v1.9 로 맞췄다.
	v2.0 (2026.08.30) — F13 · F14 레이더 구현에서 확정. ① **T1 · T2 를 배치가 미리 산출**하고 조회는 읽기만 한다 — 요청 시 조회하면 화면을 열 때마다 예산이 나간다. `demand_signal` 신설(DB 명세서 v1.9) ② `radar/signals` 에 **`productId` 를 필수**로 했다 — T2 조회 창이 그 상품의 여행일에서 나오므로 상품 없이는 어느 기간의 행사를 세야 하는지 정할 수 없다 ③ `radar/changes` 의 판독 결과 변화는 `content_fingerprint.normalized_json` 전후 비교이며 재검수가 돌아 지문이 두 번 이상 쌓인 콘텐츠에만 있다. 없으면 `hasReadableDiff: false` 로 그 사실을 말한다 ④ 알림 응답에 `dismissable` 을 넣었다 — 비표출 전환 알림은 무시할 수 없는데(FR-MO-037 · PM-NG-010) 눌러 보고 403 을 받는 것은 화면이 규정을 모른다는 뜻이다 ⑤ 알림 응답에 관광지명을 담지 않는다. 화면이 `ktoContentId` 로 자기 일정의 `placeLabel` 을 붙인다(FR-MO-002).
</callout>
<callout icon="©️" color="gray_bg">
	출처: ⓒ한국관광공사
</callout>
