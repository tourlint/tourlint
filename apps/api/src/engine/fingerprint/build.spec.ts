import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FINGERPRINT_FIELDS, UNIT_SEPARATOR } from '@tourlint/shared';
import {
  NonScalarFieldError,
  UnsupportedContentTypeError,
  buildContentFingerprint,
  buildRunFingerprint,
  shortFingerprint,
} from './build';

const FIXTURES = join(__dirname, '../../../../../fixtures/kto');

/** 실호출 스냅샷에서 `items.item` 을 꺼낸다. 1건이면 객체, 2건 이상이면 배열이다 (EI-KT-005). */
function loadIntro(file: string): Record<string, unknown> {
  const raw = JSON.parse(readFileSync(join(FIXTURES, file), 'utf8'));
  const item = raw.response.body.items.item;
  return Array.isArray(item) ? item[0] : item;
}

describe('buildContentFingerprint', () => {
  it('SHA-256 소문자 16진 64자를 낸다 (DR-FP-001)', () => {
    const { fieldHash } = buildContentFingerprint({
      contentTypeId: 12,
      raw: loadIntro('12_125790.json'),
    });
    expect(fieldHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('사용한 필드명을 순서 그대로 기록한다 (DR-FP-003)', () => {
    const { fieldNames } = buildContentFingerprint({
      contentTypeId: 14,
      raw: loadIntro('14_129784.json'),
    });
    expect(fieldNames).toEqual(['restdateculture', 'usetimeculture']);
  });

  it('입력은 판정 필드를 U+001F 로 이어붙인 원문이다 (DR-FP-002)', async () => {
    const raw = loadIntro('14_129784.json');
    const { fieldHash } = buildContentFingerprint({ contentTypeId: 14, raw });

    const { createHash } = await import('node:crypto');
    const expected = createHash('sha256')
      .update(`${raw.restdateculture}${UNIT_SEPARATOR}${raw.usetimeculture}`, 'utf8')
      .digest('hex');

    expect(fieldHash).toBe(expected);
  });

  // ── DR-TD-004 양방향 ────────────────────────────────────────
  describe('DR-TD-004 — 판정 필드 변경은 잡고, 판정 무관 필드 변경은 무시한다', () => {
    it('판정 필드를 1글자만 바꿔도 해시가 달라진다', () => {
      const raw = loadIntro('14_129784.json');
      const before = buildContentFingerprint({ contentTypeId: 14, raw });
      const after = buildContentFingerprint({
        contentTypeId: 14,
        // 매표시간 09:00~17:00 → 09:00~18:00. 한 글자다.
        raw: { ...raw, usetimeculture: String(raw.usetimeculture).replace('17:00', '18:00') },
      });
      expect(after.fieldHash).not.toBe(before.fieldHash);
    });

    it('공백 하나만 늘려도 해시가 달라진다 — 전처리하지 않기 때문이다 (DR-FP-004)', () => {
      const raw = loadIntro('12_125790.json');
      const before = buildContentFingerprint({ contentTypeId: 12, raw });
      const after = buildContentFingerprint({
        contentTypeId: 12,
        raw: { ...raw, restdate: `${raw.restdate} ` },
      });
      expect(after.fieldHash).not.toBe(before.fieldHash);
    });

    it('판정에 쓰지 않는 필드가 바뀌어도 해시가 유지된다', () => {
      const raw = loadIntro('12_125790.json');
      const before = buildContentFingerprint({ contentTypeId: 12, raw });
      const after = buildContentFingerprint({
        contentTypeId: 12,
        raw: { ...raw, infocenter: '033-000-0000', parking: '가능', expguide: '완전히 다른 문장' },
      });
      expect(after.fieldHash).toBe(before.fieldHash);
    });
  });

  it('필드 순서를 바꾸면 해시가 달라진다 — 순서가 계약이다', async () => {
    const { createHash } = await import('node:crypto');
    const raw = loadIntro('14_129784.json');
    const asSpecified = buildContentFingerprint({ contentTypeId: 14, raw }).fieldHash;
    const reversed = createHash('sha256')
      .update(`${raw.usetimeculture}${UNIT_SEPARATOR}${raw.restdateculture}`, 'utf8')
      .digest('hex');
    expect(asSpecified).not.toBe(reversed);
  });

  it('null · undefined · 빈 문자열을 구분하지 않는다 (DR-FP-005)', () => {
    const base = { restdate: '연중무휴' };
    const withNull = buildContentFingerprint({ contentTypeId: 12, raw: { ...base, usetime: null } });
    const withUndef = buildContentFingerprint({ contentTypeId: 12, raw: base });
    const withEmpty = buildContentFingerprint({ contentTypeId: 12, raw: { ...base, usetime: '' } });
    expect(withNull.fieldHash).toBe(withUndef.fieldHash);
    expect(withNull.fieldHash).toBe(withEmpty.fieldHash);
  });

  it('구분자 덕분에 값 경계가 모호해지지 않는다', () => {
    // 구분자가 없다면 ('AB','C') 와 ('A','BC') 가 같은 입력이 된다.
    const ab_c = buildContentFingerprint({ contentTypeId: 12, raw: { restdate: 'AB', usetime: 'C' } });
    const a_bc = buildContentFingerprint({ contentTypeId: 12, raw: { restdate: 'A', usetime: 'BC' } });
    expect(ab_c.fieldHash).not.toBe(a_bc.fieldHash);
  });

  it('같은 입력이면 언제나 같은 해시다 (NF-MT-001 결정론성)', () => {
    const raw = loadIntro('39_2868839.json');
    const hashes = new Set(
      Array.from({ length: 5 }, () => buildContentFingerprint({ contentTypeId: 39, raw }).fieldHash),
    );
    expect(hashes.size).toBe(1);
  });

  it('7개 유형 전부 실호출 픽스처로 지문이 만들어진다', () => {
    const cases: ReadonlyArray<[number, string]> = [
      [12, '12_125790.json'],
      [14, '14_129784.json'],
      [15, 'type15_695592.json'],
      [28, '28_2792194.json'],
      [32, '32_4074363.json'],
      [38, '38_1756581.json'],
      [39, '39_2868839.json'],
    ];
    for (const [contentTypeId, file] of cases) {
      const fp = buildContentFingerprint({ contentTypeId, raw: loadIntro(file) });
      expect(fp.fieldHash, `contentTypeId ${contentTypeId}`).toMatch(/^[0-9a-f]{64}$/);
      expect(fp.fieldNames).toEqual(FINGERPRINT_FIELDS[contentTypeId as 12]);
    }
  });

  it('지원하지 않는 유형은 빈 지문을 만들지 않고 던진다', () => {
    // 조용히 ''를 해시하면 영원히 "변경 없음"으로 읽혀 그 콘텐츠의 변경을 영구히 놓친다.
    expect(() => buildContentFingerprint({ contentTypeId: 25, raw: {} })).toThrow(
      UnsupportedContentTypeError,
    );
  });

  it('판정 필드가 스칼라가 아니면 던진다 — 응답 파서가 잘못됐다는 신호다', () => {
    expect(() =>
      buildContentFingerprint({ contentTypeId: 12, raw: { restdate: { nested: true } } }),
    ).toThrow(NonScalarFieldError);
  });
});

describe('buildRunFingerprint — 실행 대표 지문 (DR-FP-008)', () => {
  const entries = [
    { ktoContentId: '999', fieldHash: 'a'.repeat(64) },
    { ktoContentId: '1000', fieldHash: 'b'.repeat(64) },
    { ktoContentId: '2668891', fieldHash: 'c'.repeat(64) },
  ];

  it('입력 순서가 달라도 같은 대표 지문을 낸다', () => {
    const forward = buildRunFingerprint(entries);
    const backward = buildRunFingerprint([...entries].reverse());
    expect(forward).toBe(backward);
    expect(forward).toMatch(/^[0-9a-f]{64}$/);
  });

  it('정렬은 숫자가 아니라 **문자열 비교**다', async () => {
    const { createHash } = await import('node:crypto');
    // 문자열 비교: '1000' < '2668891' < '999'   (숫자 비교였다면 999 가 맨 앞)
    const stringOrder = ['b', 'c', 'a'].map((c) => c.repeat(64)).join(UNIT_SEPARATOR);
    const numericOrder = ['a', 'b', 'c'].map((c) => c.repeat(64)).join(UNIT_SEPARATOR);

    expect(buildRunFingerprint(entries)).toBe(
      createHash('sha256').update(stringOrder, 'utf8').digest('hex'),
    );
    expect(buildRunFingerprint(entries)).not.toBe(
      createHash('sha256').update(numericOrder, 'utf8').digest('hex'),
    );
  });

  it('콘텐츠 하나의 지문이 바뀌면 대표 지문도 바뀐다', () => {
    const changed = [...entries.slice(1), { ktoContentId: '999', fieldHash: 'd'.repeat(64) }];
    expect(buildRunFingerprint(changed)).not.toBe(buildRunFingerprint(entries));
  });

  it('중복 contentid 는 던진다 — 실행당 콘텐츠별 1행이다 (DR-FP-007)', () => {
    expect(() =>
      buildRunFingerprint([entries[0]!, { ktoContentId: '999', fieldHash: 'e'.repeat(64) }]),
    ).toThrow(/중복 contentid/);
  });

  it('축약 표기는 앞 8자리다 (UI-CM-032)', () => {
    const hash = buildRunFingerprint(entries);
    expect(shortFingerprint(hash)).toBe(hash.slice(0, 8));
    expect(shortFingerprint(hash)).toHaveLength(8);
  });
});
