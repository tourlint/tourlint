import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { InMemoryApiCallLogger } from '../api-call-log';
import { createKtoClient, createKtoTransport } from './kto.factory';

const FIXTURE_DIR = join(__dirname, '../../../../../fixtures/kto');

describe('createKtoTransport — KTO_MODE 스위치', () => {
  it('기본은 실호출이다', () => {
    expect(createKtoTransport({ KTO_SERVICE_KEY: 'k' }).kind).toBe('http');
  });

  it('KTO_MODE=fixture 면 리플레이다 — 예산을 쓰지 않는다', () => {
    expect(createKtoTransport({ KTO_MODE: 'fixture', KTO_FIXTURE_DIR: FIXTURE_DIR }).kind).toBe('fixture');
  });

  it('운영에서 리플레이를 켜면 조용히 넘어가지 않고 막는다 (FR-OP-009)', () => {
    // 설정 실수를 배포 후에 알게 되면 늦다
    expect(() => createKtoTransport({ KTO_MODE: 'fixture', NODE_ENV: 'production' })).toThrow(/심사에서 제외/);
  });

  it('실호출 모드인데 인증키가 없으면 기동 단계에서 막는다', () => {
    expect(() => createKtoTransport({})).toThrow(/인증키/);
  });

  it('리플레이 클라이언트로 상세 조회가 관통한다', async () => {
    const client = createKtoClient(new InMemoryApiCallLogger(), { KTO_MODE: 'fixture', KTO_FIXTURE_DIR: FIXTURE_DIR });
    await expect(client.detailIntro('125769', 12)).resolves.toHaveProperty('contentid', '125769');
  });
});
