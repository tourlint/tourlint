# apps/api — TourLint API 스켈레톤 (mock)

API 명세 v1.4 계약의 **모든 엔드포인트를 목업으로** 제공한다. 응답 본문은 명세 5장 JSON 예시를 그대로 사용한다(손으로 지어내지 않음).

## 설치

```bash
cd ~/tourlint/apps/api
pnpm install
```

## 실행

```bash
# 로컬 DB를 띄운 상태에서 (STEP 6)
export DATABASE_URL='postgresql://tourlint:tourlint@localhost:5432/tourlint'
pnpm start:dev
```

→ http://localhost:3001

## 확인

```bash
curl -s localhost:3001/health | jq            # {"status":"ok","db":"up",...}
curl -s localhost:3001/api/v1/products | jq   # 명세 5-2 예시 그대로
curl -s -X POST localhost:3001/api/v1/products/31/audit-jobs | jq   # 202 + jobId
curl -s localhost:3001/api/v1/audit-jobs/5501 | jq   # 호출할 때마다 QUEUED→RUNNING→DONE
```

## 지역·분류 코드 목업을 실데이터로 교체 (선택)

```bash
cd ~/tourlint
cp fixtures/kto/01_ldongCode2_sido.json      apps/api/src/mocks/ldong_codes.json
cp fixtures/kto/03_lclsSystmCode2_lv1.json   apps/api/src/mocks/lcls_codes.json
```

## 구조

| 파일 | 역할 |
|---|---|
| `src/main.ts` | 부트스트랩 · 전역 예외 필터 등록 · CORS |
| `src/common/all-exceptions.filter.ts` | **에러 응답을 만드는 유일한 지점** + traceId (확정안 ⑤ · NF-SC-009) |
| `src/health/health.controller.ts` | `/health` — DB 연결 확인 포함, 인증 불필요 (NF-AV-004) |
| `src/mock/mock.controller.ts` | API v1.4 전 엔드포인트 목업 |
| `src/mocks/*.json` | 명세 5장 응답 예시 15종 |

## W1 전환 규칙

도메인 모듈을 구현할 때마다 **해당 엔드포인트를 `mock.controller.ts`에서 제거**한다. 목업이 실제 구현을 가리는 일이 없도록.
⚠️ FR-OP-009 · NF-CO-002 — 공사 API 호출을 목업으로 **전면 대체하지 않는다.** 이 목업은 개발 단계 한정이며 배포본에는 실호출 경로가 살아 있어야 한다.
