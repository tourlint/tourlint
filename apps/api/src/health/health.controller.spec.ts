import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildCommit, EXPECTED_TABLE_COUNT, HealthController } from './health.controller';
import { KtoReachability, RETRY_FAST_MS, RETRY_FAST_TIMES, RETRY_SLOW_MS, retryDelayMs } from './kto-reachability';

/**
 * `/health` 는 **배포 후 확인 목록**이다. 값이 아니라 상태만 말한다.
 */
describe('HealthController', () => {
  const controller = new HealthController();
  const saved = { ...process.env };

  beforeEach(() => {
    delete process.env.DATABASE_URL;
    delete process.env.KTO_SERVICE_KEY;
    delete process.env.KTO_MODE;
    delete process.env.KAKAO_REST_API_KEY;
    delete process.env.KMA_SERVICE_KEY;
    delete process.env.LLM_API_KEY;
    delete process.env.RAILWAY_GIT_COMMIT_SHA;
  });

  afterEach(() => {
    process.env = { ...saved };
  });

  it('인증키 값을 절대 내보내지 않는다 (NF-SC-009 · PM-SC-003)', async () => {
    process.env.KTO_SERVICE_KEY = 'SUPER-SECRET-SERVICE-KEY-1234567890';
    const body = await controller.check();
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain('SUPER-SECRET');
    // 있고 없고만 말한다
    expect((body.checks as Record<string, unknown>).ktoServiceKey).toBe('ok');
  });

  describe('공사에 닿는가 — 못 닿는 컨테이너는 배포 검사를 통과하지 못한다 (#700)', () => {
    const noSleep = (): Promise<void> => Promise.resolve();
    function statusSpy(): { status: (code: number) => void; code: number | null } {
      const spy = { code: null as number | null, status: (code: number): void => { spy.code = code; } };
      return spy;
    }

    it('🔴 실호출 모드에서 예열이 실패했으면 503 이다', async () => {
      process.env.KTO_SERVICE_KEY = 'k';
      const reach = new KtoReachability();
      let tries = 0;
      // 첫 시도 실패 뒤 다시 시도를 멈춰 세운다 — 두 번째 sleep 에서 영영 기다린다
      void reach.track(() => { tries += 1; return Promise.resolve(false); }, undefined, () => new Promise(() => undefined));
      await Promise.resolve();
      await Promise.resolve();
      const res = statusSpy();
      const body = await new HealthController(reach).check(res);
      expect(tries).toBe(1);
      expect(res.code).toBe(503);
      expect(body.ready).toBe(false);
      expect((body.checks as Record<string, unknown>).ktoReachable).toBe('failed');
    });

    it('🔴 예열 결과가 나오기 전에도 503 이다 — 그 몇 초를 200 으로 흘리면 검사가 헛돈다', async () => {
      process.env.KTO_SERVICE_KEY = 'k';
      const res = statusSpy();
      await new HealthController(new KtoReachability()).check(res);
      expect(res.code).toBe(503);
    });

    it('닿았으면 상태 코드를 건드리지 않는다', async () => {
      process.env.KTO_SERVICE_KEY = 'k';
      const reach = new KtoReachability();
      await reach.track(() => Promise.resolve(true), undefined, noSleep);
      const res = statusSpy();
      const body = await new HealthController(reach).check(res);
      expect(res.code).toBeNull();
      expect((body.checks as Record<string, unknown>).ktoReachable).toBe('ok');
    });

    it('픽스처 모드 · 키가 없는 부팅은 공사 연결로 가르지 않는다 — 로컬과 CI 가 503 이면 안 된다', async () => {
      process.env.KTO_SERVICE_KEY = 'k';
      process.env.KTO_MODE = 'fixture';
      const fixture = statusSpy();
      await new HealthController(new KtoReachability()).check(fixture);
      expect(fixture.code).toBeNull();

      delete process.env.KTO_MODE;
      delete process.env.KTO_SERVICE_KEY;
      const noKey = statusSpy();
      await new HealthController(new KtoReachability()).check(noKey);
      expect(noKey.code).toBeNull();
    });

    it('🔴 실패한 뒤에도 다시 시도해 닿으면 ok 로 바뀐다 — 잠깐 막힌 길은 검사 시간 안에 풀린다', async () => {
      const reach = new KtoReachability();
      const results = [false, false, true];
      const waits: number[] = [];
      const lines: string[] = [];
      await reach.track(
        () => Promise.resolve(results.shift() ?? true),
        (line) => lines.push(line),
        (ms) => { waits.push(ms); return Promise.resolve(); },
      );
      expect(reach.state).toBe('ok');
      expect(waits).toEqual([RETRY_FAST_MS, RETRY_FAST_MS]);
      // 못 닿았다는 줄은 한 번만, 회복은 몇 번 만인지와 함께
      expect(lines.filter((l) => l.includes('닿지 못했다'))).toHaveLength(1);
      expect(lines.some((l) => l.includes('회복') && l.includes('2번'))).toBe(true);
    });

    it('던지는 예열도 실패로 센다 — 여기서 새는 예외가 부팅을 죽이면 안 된다', async () => {
      const reach = new KtoReachability();
      let first = true;
      await reach.track(() => {
        if (first) { first = false; return Promise.reject(new Error('KTO_TIMEOUT')); }
        return Promise.resolve(true);
      }, undefined, noSleep);
      expect(reach.state).toBe('ok');
    });

    it('🔴 다시 시도는 처음 5분만 촘촘하다 — 시간 초과도 호출 기록에 남아 예산 계산에 들어간다', () => {
      expect(retryDelayMs(1)).toBe(RETRY_FAST_MS);
      expect(retryDelayMs(RETRY_FAST_TIMES)).toBe(RETRY_FAST_MS);
      expect(retryDelayMs(RETRY_FAST_TIMES + 1)).toBe(RETRY_SLOW_MS);
      expect(RETRY_FAST_MS * RETRY_FAST_TIMES).toBeGreaterThanOrEqual(300_000);
      // 느린 구간에서 하루 호출이 200건을 넘지 않는다
      expect(86_400_000 / RETRY_SLOW_MS).toBeLessThanOrEqual(200);
    });
  });

  it('인증키가 없으면 missing 이다 — 앱은 뜨지만 검수는 전부 실패한다', async () => {
    expect(((await controller.check()).checks as Record<string, unknown>).ktoServiceKey).toBe('missing');
    process.env.KTO_SERVICE_KEY = '   ';
    expect(((await controller.check()).checks as Record<string, unknown>).ktoServiceKey).toBe('missing');
  });

  it('🔴 응답에 배포본 커밋이 들어 있다', async () => {
    /*
     * 함수만 맞고 응답에 안 실리면 아무 소용이 없다 — 배포가 밀려도 여전히 알 방법이 없다.
     * 모를 때도 키는 있어야 화면이 「확인 불가」로 표시한다.
     */
    process.env.RAILWAY_GIT_COMMIT_SHA = 'aebc1768e2c9f1a4b0d3';
    expect(await controller.check()).toHaveProperty('commit', 'aebc176');

    delete process.env.RAILWAY_GIT_COMMIT_SHA;
    const body = await controller.check();
    expect(Object.keys(body)).toContain('commit');
    expect(body.commit).toBeNull();
  });

  it('리플레이 모드를 사실대로 말한다 (NF-CO-002)', async () => {
    expect((await controller.check()).mode).toBe('live');
    process.env.KTO_MODE = 'fixture';
    expect((await controller.check()).mode).toBe('fixture');
  });

  it('DB 가 설정되지 않았으면 not-configured 다 — down 과 구분한다', async () => {
    const body = await controller.check();
    expect(body.db).toBe('not-configured');
    expect((body.checks as Record<string, unknown>).schema).toBe('unknown');
  });

  it('ready 는 전부 맞아야 true 다', async () => {
    // DB 없이 키만 있으면 준비된 것이 아니다
    process.env.KTO_SERVICE_KEY = 'k';
    process.env.KAKAO_REST_API_KEY = 'k';
    expect((await controller.check()).ready).toBe(false);
  });

  it('LLM 키 유무는 알리되 ready 를 막지 않는다 — 없어도 검수는 돈다', async () => {
    process.env.LLM_API_KEY = 'SECRET-LLM-KEY';
    const body = await controller.check();
    expect(JSON.stringify(body)).not.toContain('SECRET-LLM');
    expect((body.checks as Record<string, unknown>).llmApiKey).toBe('ok');
  });

  it('카카오 키도 값 없이 유무만 말한다 — R08 이 쓴다', async () => {
    process.env.KAKAO_REST_API_KEY = 'SECRET-KAKAO-KEY';
    const body = await controller.check();
    expect(JSON.stringify(body)).not.toContain('SECRET-KAKAO');
    expect((body.checks as Record<string, unknown>).kakaoRestApiKey).toBe('ok');
  });

  it('기상청 키도 값 없이 유무만 말한다 — R09 가 쓴다 (EI-WX-001)', async () => {
    process.env.KMA_SERVICE_KEY = 'SECRET-KMA-KEY';
    const body = await controller.check();
    expect(JSON.stringify(body)).not.toContain('SECRET-KMA');
    expect((body.checks as Record<string, unknown>).kmaServiceKey).toBe('ok');
  });

  it('🔴 기상청 키가 없으면 ready 가 아니다 — 우천 리스크가 전부 확인 불가로 나온다', async () => {
    process.env.KTO_SERVICE_KEY = 'k';
    process.env.KAKAO_REST_API_KEY = 'k';
    process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? '';
    const withoutKma = await controller.check();
    expect((withoutKma.checks as Record<string, unknown>).kmaServiceKey).toBe('missing');
    expect(withoutKma.ready).toBe(false);
  });

  it('연결 문자열을 응답에 담지 않는다', async () => {
    process.env.DATABASE_URL = 'postgres://user:PASSWORD@host:5432/db';
    const serialized = JSON.stringify(await controller.check());
    expect(serialized).not.toContain('PASSWORD');
    expect(serialized).not.toContain('postgres://');
  });
});

describe('HealthController — 실 DB', () => {
  const URL = process.env.TEST_DATABASE_URL;

  it.skipIf(URL === undefined)('스키마가 적용됐으면 ok 이고 테이블 수를 알려준다', async () => {
    process.env.DATABASE_URL = URL;
    const body = await new HealthController().check();
    const checks = body.checks as Record<string, unknown>;
    expect(body.db).toBe('up');
    expect(checks.schema).toBe('ok');
    expect(Number(checks.tableCount)).toBeGreaterThanOrEqual(18);
  });
});

describe('배포본 커밋 (배포 지연 감지)', () => {
  it('Railway 가 넣어 주는 값을 읽고 7자리로 자른다', () => {
    expect(buildCommit({ RAILWAY_GIT_COMMIT_SHA: 'aebc1768e2c9f1a4b0d3' })).toBe('aebc176');
  });

  it('배포처를 옮겨도 흔한 이름들을 본다', () => {
    expect(buildCommit({ GIT_COMMIT_SHA: 'abcdef1234' })).toBe('abcdef1');
    expect(buildCommit({ SOURCE_COMMIT: 'fedcba9876' })).toBe('fedcba9');
  });

  it('🔴 커밋이 아닌 값을 커밋인 척하지 않는다', () => {
    /*
     * 아무 문자열이나 실으면 `main` 과 대조할 때 늘 다르게 보여 경보가 무뎌진다.
     * 모르면 모른다고 한다 — 화면이 「확인 불가」로 표시할 수 있다.
     */
    for (const bad of ['', 'unknown', 'HEAD', 'abc', 'ZZZZZZZ', 'main']) {
      expect(buildCommit({ RAILWAY_GIT_COMMIT_SHA: bad }), bad).toBeNull();
    }
    expect(buildCommit({})).toBeNull();
  });
});

describe('기대 테이블 수', () => {
  it('🔴 schema.sql 의 CREATE TABLE 수와 맞는다', () => {
    /*
     * 비교가 `>=` 라 상수를 안 올리면 새 표가 통째로 없어도 `ok` 가 나간다.
     * 2026-08-30 `demand_signal` 을 넣고 상수를 안 올려서 운영 /health 가
     * `tableCount: 20 · expectedTableCount: 19` 로 어긋난 채 `ok` 를 냈다.
     *
     * 표를 늘리면 이 검사가 먼저 걸린다.
     */
    const schema = readFileSync(join(__dirname, '../../../../db/schema.sql'), 'utf8');
    const tables = (schema.match(/^CREATE TABLE /gm) ?? []).length;
    expect(EXPECTED_TABLE_COUNT).toBe(tables);
  });
});
