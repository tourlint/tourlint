import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ContentTypeId } from '@tourlint/shared';
import { buildContentFingerprint, buildRunFingerprint } from '../../engine/fingerprint';
import { InMemoryApiCallLogger } from '../api-call-log';
import { createKtoClient } from './kto.factory';

/**
 * D1(지문) ↔ D2(공사 어댑터) 관통 — 리플레이 응답만으로 검수 지문이 만들어지는지 본다.
 *
 * 이게 되면 이후 규칙 개발이 **공사 호출 예산을 쓰지 않고** 굴러간다.
 */
const FIXTURE_DIR = join(__dirname, '../../../../../fixtures/kto');
const env = { KTO_MODE: 'fixture', KTO_FIXTURE_DIR: FIXTURE_DIR };

const CASES: ReadonlyArray<[ContentTypeId, string]> = [
  [12, '125769'],
  [14, '129784'],
  [15, '695592'],
  [28, '2792194'],
  [32, '4074363'],
  [38, '1756581'],
  [39, '2868839'],
];

describe('픽스처 리플레이 → 검수 지문', () => {
  it('7개 유형 전부 호출 0건으로 지문까지 간다', async () => {
    const logger = new InMemoryApiCallLogger();
    const client = createKtoClient(logger, env);

    const entries = [];
    for (const [contentTypeId, ktoContentId] of CASES) {
      const raw = await client.detailIntro(ktoContentId, contentTypeId);
      const fp = buildContentFingerprint({ contentTypeId, raw });
      expect(fp.fieldHash, `유형 ${contentTypeId}`).toMatch(/^[0-9a-f]{64}$/);
      entries.push({ ktoContentId, fieldHash: fp.fieldHash });
    }

    expect(buildRunFingerprint(entries)).toMatch(/^[0-9a-f]{64}$/);
    // 리플레이는 증빙 로그를 남기지 않는다 (FR-OP-007). 예산도 그대로다
    expect(logger.entries).toEqual([]);
  });

  it('같은 리플레이는 같은 대표 지문을 낸다 (NF-MT-001)', async () => {
    const run = async (): Promise<string> => {
      const client = createKtoClient(new InMemoryApiCallLogger(), env);
      const entries = [];
      for (const [contentTypeId, ktoContentId] of CASES) {
        const raw = await client.detailIntro(ktoContentId, contentTypeId);
        entries.push({ ktoContentId, fieldHash: buildContentFingerprint({ contentTypeId, raw }).fieldHash });
      }
      return buildRunFingerprint(entries);
    };
    expect(await run()).toBe(await run());
  });

  it('구 코드체계 필드가 지워졌어도 지문 판정 필드는 온전하다', async () => {
    const raw = await createKtoClient(new InMemoryApiCallLogger(), env).detailIntro('125769', 12);
    expect(raw).not.toHaveProperty('cat1');
    expect(buildContentFingerprint({ contentTypeId: 12, raw }).fieldNames).toEqual(['restdate', 'usetime']);
  });
});
