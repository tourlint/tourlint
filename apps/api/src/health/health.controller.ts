import { Controller, Get } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Client } from 'pg';
import { Public } from '../auth/public.decorator';

/**
 * `/health` — 애플리케이션 · DB · 설정 상태 확인 (NF-AV-004).
 *
 * 인증 없이 접근할 수 있고 Railway 의 Healthcheck Path 로 쓴다.
 *
 * **배포 후 확인해야 할 것들을 여기서 다 보여준다.** 스키마가 적용됐는지, 인증키가
 * 주입됐는지를 알려면 원래 DB 나 대시보드에 붙어야 하는데, 그건 배포한 사람만 할 수 있다.
 * 브라우저로 이 주소만 열면 되게 만들어 두면 확인이 몇 초로 줄어든다.
 *
 * ⚠️ **값은 절대 담지 않는다.** 인증키는 있고 없고만, DB 는 연결되고 안 되고만 말한다
 * (NF-SC-009 · PM-SC-003).
 */

/** DB 명세서 2-3 의 엔터티 18종 + 로그인 세션 1종. 이보다 적으면 스키마가 덜 적용된 것이다 */
const EXPECTED_TABLE_COUNT = 19;

/**
 * 지금 돌고 있는 빌드의 커밋 (7자리). 모르면 `null`.
 *
 * **배포가 조용히 밀린 것을 잡으려고 넣는다.** 2026-08-29 에 `main` 머지 두 건이 두 시간
 * 밀렸는데, 그동안 `/health` 는 계속 `ok` 였고 아무도 몰랐다. 옛 코드가 돌고 있어도
 * 살아 있는 것은 사실이라 상태만으로는 구분이 안 된다.
 *
 * `git rev-parse HEAD` 와 대조하면 한눈에 알 수 있다. Railway 가 넣어 주는 값을 먼저
 * 보고, 없으면 흔한 다른 이름들을 본다 — 배포처를 옮겨도 이 검사가 살아 있게.
 */
export function buildCommit(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env.RAILWAY_GIT_COMMIT_SHA ?? env.GIT_COMMIT_SHA ?? env.SOURCE_COMMIT ?? '';
  return /^[0-9a-f]{7,40}$/.test(raw) ? raw.slice(0, 7) : null;
}

type Check = 'ok' | 'missing' | 'unknown';

@ApiTags('실엔진')
@Controller('health')
export class HealthController {
  @Public()
  @Get()
  async check(): Promise<Record<string, unknown>> {
    const started = Date.now();
    const url = process.env.DATABASE_URL;

    let db: 'up' | 'down' | 'not-configured' = url === undefined || url === '' ? 'not-configured' : 'down';
    let schema: Check = 'unknown';
    let tableCount: number | null = null;

    if (url !== undefined && url !== '') {
      const client = new Client({
        connectionString: url,
        ssl: isLocal(url) ? undefined : { rejectUnauthorized: false },
        connectionTimeoutMillis: 3000,
      });
      try {
        await client.connect();
        db = 'up';
        // 스키마가 적용됐는지 — 이게 배포 후 가장 자주 어긋나는 지점이다
        const { rows } = await client.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM information_schema.tables
            WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`,
        );
        tableCount = Number(rows[0]?.n ?? 0);
        schema = tableCount >= EXPECTED_TABLE_COUNT ? 'ok' : 'missing';
      } catch {
        db = 'down';
      } finally {
        await client.end().catch(() => undefined);
      }
    }

    /*
     * 공사 인증키는 **있고 없고만** 말한다. 값도, 길이도, 앞자리도 내보내지 않는다.
     * 키가 없으면 앱은 정상 기동하고 검수 요청만 전부 실패한다 — 그 상태를 배포 직후에
     * 알 수 있게 하려고 넣는다.
     */
    const ktoKey: Check = hasValue(process.env.KTO_SERVICE_KEY) ? 'ok' : 'missing';
  // R08 이 쓴다. 없으면 이동시간이 전부 확인 불가로 나온다
  const kakaoKey: Check = hasValue(process.env.KAKAO_REST_API_KEY) ? 'ok' : 'missing';
  // R09 가 쓴다. 없으면 우천 리스크가 전부 확인 불가로 나온다 (EI-WX-001)
  const kmaKey: Check = hasValue(process.env.KMA_SERVICE_KEY) ? 'ok' : 'missing';
  /*
   * F01 자연어 구조화 · F03 정규화 폴백이 쓴다. 없어도 검수는 돌기 때문에 `ready` 에
   * 넣지 않는다 — 사전 파서 커버리지가 이미 목표(90%)를 넘겼고, 폴백은 그 위의 몫이다
   */
  const llmKey: Check = hasValue(process.env.LLM_API_KEY) ? 'ok' : 'missing';

    /*
     * 'mock' 을 고정으로 박아두면 실엔진으로 바뀐 뒤에도 목업처럼 보인다.
     * 공사 호출을 모의로 전면 대체했는지는 심사 항목이므로(NF-CO-002) 사실대로 보여준다.
     */
    const mode = process.env.KTO_MODE === 'fixture' ? 'fixture' : 'live';

    const ready = db === 'up' && schema === 'ok' && ktoKey === 'ok'
      && kakaoKey === 'ok' && kmaKey === 'ok' && mode === 'live';

    return {
      status: db === 'up' ? 'ok' : db === 'not-configured' ? 'ok' : 'degraded',
      ready,
      db,
      mode,
      checks: {
        database: db,
        schema,
        tableCount,
        expectedTableCount: EXPECTED_TABLE_COUNT,
        ktoServiceKey: ktoKey,
        kakaoRestApiKey: kakaoKey,
        kmaServiceKey: kmaKey,
        llmApiKey: llmKey,
      },
      // 배포본이 최신인지 대조하는 값. `git rev-parse --short HEAD` 와 비교한다
      commit: buildCommit(),
      latencyMs: Date.now() - started,
      timestamp: new Date().toISOString(),
    };
  }
}

function isLocal(url: string): boolean {
  // sslmode=disable 명시 시 TLS 를 끈다 — 도커 컴포즈의 `db` 호스트는 localhost 규칙에
  // 안 걸린다 (db.ts 의 같은 함수와 맞춘다)
  return url.includes('localhost') || url.includes('127.0.0.1') || url.includes('sslmode=disable');
}

function hasValue(v: string | undefined): boolean {
  return v !== undefined && v.trim() !== '';
}
