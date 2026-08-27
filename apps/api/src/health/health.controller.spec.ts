import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HealthController } from './health.controller';

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

  it('인증키가 없으면 missing 이다 — 앱은 뜨지만 검수는 전부 실패한다', async () => {
    expect(((await controller.check()).checks as Record<string, unknown>).ktoServiceKey).toBe('missing');
    process.env.KTO_SERVICE_KEY = '   ';
    expect(((await controller.check()).checks as Record<string, unknown>).ktoServiceKey).toBe('missing');
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
