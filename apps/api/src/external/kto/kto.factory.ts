import { resolve } from 'node:path';
import type { ApiCallLogger } from '../api-call-log';
import { KtoClient } from './kto.client';
import { FixtureKtoTransport, HttpKtoTransport, type KtoTransport } from './transport';

/**
 * 환경변수 하나로 실호출 ↔ 픽스처 리플레이를 고른다.
 *
 *   KTO_MODE=fixture   `fixtures/kto/` 스냅샷 리플레이 — 개발·테스트 전용, 예산을 쓰지 않는다
 *   그 밖             실호출 (기본)
 *
 * ⚠️ **운영에서는 리플레이를 금지한다** (FR-OP-009 · NF-CO-002).
 *    공사 호출을 모의 응답으로 전면 대체한 채 제출하면 심사에서 제외된다.
 */
export const KTO_MODE_FIXTURE = 'fixture';

export interface KtoEnvLike {
  readonly KTO_MODE?: string;
  readonly KTO_SERVICE_KEY?: string;
  readonly KTO_BASE_URL?: string;
  readonly KTO_TIMEOUT_MS?: string;
  readonly KTO_FIXTURE_DIR?: string;
  readonly NODE_ENV?: string;
}

export function createKtoTransport(env: KtoEnvLike = process.env): KtoTransport {
  if (env.KTO_MODE === KTO_MODE_FIXTURE) {
    if (env.NODE_ENV === 'production') {
      // 조용히 실호출로 넘어가지 않는다 — 설정 실수를 배포 후에 알게 되면 늦다
      throw new Error(
        'KTO_MODE=fixture 는 운영에서 쓸 수 없다. 공사 호출을 모의 응답으로 대체하면 심사에서 제외된다 (FR-OP-009)',
      );
    }
    return new FixtureKtoTransport(env.KTO_FIXTURE_DIR ?? defaultFixtureDir());
  }

  return new HttpKtoTransport({
    serviceKey: env.KTO_SERVICE_KEY ?? '',
    baseUrl: env.KTO_BASE_URL,
    timeoutMs: env.KTO_TIMEOUT_MS === undefined ? undefined : Number(env.KTO_TIMEOUT_MS),
  });
}

export function createKtoClient(logger: ApiCallLogger, env: KtoEnvLike = process.env): KtoClient {
  return new KtoClient({ transport: createKtoTransport(env), logger });
}

/** 레포 루트의 `fixtures/kto`. 빌드 산출물(`dist/`) 위치와 무관하게 찾도록 cwd 기준으로 잡는다 */
function defaultFixtureDir(): string {
  return resolve(process.cwd(), '../../fixtures/kto');
}
