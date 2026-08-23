import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  LEGACY_CODE_FIELDS,
  parseKtoResponse,
  stripLegacyCodeFields,
} from './envelope';
import { KtoAuthError, KtoFetchError, KtoQuotaExceededError } from './kto.errors';

const FIXTURES = join(__dirname, '../../../../../fixtures/kto');
const read = (file: string): string => readFileSync(join(FIXTURES, file), 'utf8');

/**
 * 아래 `body*()` 들은 **합성 응답**이다. 실호출 스냅샷(`fixtures/kto/`)에는 정상 응답만 있어서
 * 오류 경로를 재현할 수 없다. 정답셋을 합성 데이터로 오염시키지 않으려고 여기 인라인으로 둔다.
 */
const okBody = (body: Record<string, unknown>): string =>
  JSON.stringify({ response: { header: { resultCode: '0000', resultMsg: 'OK' }, body } });

describe('parseKtoResponse — 실측 함정 5가지', () => {
  // ① XML 오류 (EI-KT-002)
  describe('① 인증 실패·쿼터 초과는 JSON 이 아니라 XML 로 온다', () => {
    const xml = (code: string, authMsg: string): string =>
      `<?xml version="1.0" encoding="UTF-8"?>\n<OpenAPI_ServiceResponse><cmmMsgHeader>` +
      `<errMsg>SERVICE ERROR</errMsg><returnAuthMsg>${authMsg}</returnAuthMsg>` +
      `<returnReasonCode>${code}</returnReasonCode></cmmMsgHeader></OpenAPI_ServiceResponse>`;

    it('미등록 인증키(30) → KTO_AUTH_ERROR', () => {
      try {
        parseKtoResponse('searchKeyword2', xml('30', 'SERVICE_KEY_IS_NOT_REGISTERED_ERROR'));
        expect.unreachable('던졌어야 한다');
      } catch (e) {
        expect(e).toBeInstanceOf(KtoAuthError);
        expect((e as KtoAuthError).reasonCode).toBe('KTO_AUTH_ERROR');
        expect((e as KtoAuthError).retryable).toBe(false);
      }
    });

    it('한도 초과(22) → KTO_QUOTA_EXCEEDED', () => {
      const e = catchError(() =>
        parseKtoResponse('detailIntro2', xml('22', 'LIMITED_NUMBER_OF_SERVICE_REQUESTS_EXCEEDS_ERROR')),
      );
      expect(e).toBeInstanceOf(KtoQuotaExceededError);
      expect((e as KtoQuotaExceededError).retryable).toBe(false);
    });

    it.each([
      ['20', 'SERVICE_ACCESS_DENIED_ERROR'],
      ['31', 'DEADLINE_HAS_EXPIRED_ERROR'],
      ['32', 'UNREGISTERED_IP_ERROR'],
      ['33', 'UNSIGNED_CALL_ERROR'],
    ])('인증 계열 %s 도 KTO_AUTH_ERROR 다', (code, msg) => {
      expect(catchError(() => parseKtoResponse('detailCommon2', xml(code, msg)))).toBeInstanceOf(KtoAuthError);
    });

    it('코드가 없어도 인증 메시지로 판별한다', () => {
      const noCode = '<OpenAPI_ServiceResponse><cmmMsgHeader><returnAuthMsg>SERVICE_KEY_IS_NOT_REGISTERED_ERROR</returnAuthMsg></cmmMsgHeader></OpenAPI_ServiceResponse>';
      expect(catchError(() => parseKtoResponse('searchKeyword2', noCode))).toBeInstanceOf(KtoAuthError);
    });

    it('선행 공백이 있어도 XML 로 알아본다', () => {
      expect(catchError(() => parseKtoResponse('searchKeyword2', `\n  ${xml('22', 'X')}`))).toBeInstanceOf(
        KtoQuotaExceededError,
      );
    });

    it('오류 메시지에 응답 본문 전체를 담지 않는다 — 원문 누출 경로다', () => {
      const withText = xml('30', 'SERVICE_KEY_IS_NOT_REGISTERED_ERROR');
      const e = catchError(() => parseKtoResponse('searchKeyword2', withText));
      expect((e as Error).message).not.toContain('OpenAPI_ServiceResponse');
      expect((e as Error).message).not.toContain('<');
    });

    it('JSON 파싱 실패는 XML 오류와 구분해 KTO_FETCH_FAILED 로 둔다', () => {
      const e = catchError(() => parseKtoResponse('searchKeyword2', 'not json at all'));
      expect(e).toBeInstanceOf(KtoFetchError);
      expect((e as KtoFetchError).retryable).toBe(true);
    });
  });

  // ② resultCode (EI-KT-003)
  describe('② resultCode 가 0000 이 아니면 HTTP 200 이어도 실패다', () => {
    const withCode = (code: string, msg = '오류'): string =>
      JSON.stringify({ response: { header: { resultCode: code, resultMsg: msg }, body: {} } });

    it('일반 오류코드는 KTO_FETCH_FAILED 이고 코드를 보존한다', () => {
      const e = catchError(() => parseKtoResponse('searchKeyword2', withCode('0001', 'APPLICATION ERROR'), 200));
      expect(e).toBeInstanceOf(KtoFetchError);
      expect((e as KtoFetchError).resultCode).toBe('0001');
    });

    it('한도·인증 계열은 XML 과 같은 사유코드로 모은다', () => {
      expect(catchError(() => parseKtoResponse('detailIntro2', withCode('22')))).toBeInstanceOf(KtoQuotaExceededError);
      expect(catchError(() => parseKtoResponse('detailIntro2', withCode('0030')))).toBeInstanceOf(KtoAuthError);
    });

    it('0000 이면 통과한다', () => {
      expect(parseKtoResponse('searchKeyword2', okBody({ items: '' })).resultCode).toBe('0000');
    });
  });

  // ③ 0건 (EI-KT-004)
  describe('③ 0건일 때 items 는 빈 배열이 아니라 빈 문자열이다', () => {
    it('items: "" 를 0건으로 정상 처리한다', () => {
      const env = parseKtoResponse('searchFestival2', okBody({ items: '', numOfRows: 10, pageNo: 1, totalCount: 0 }));
      expect(env.items).toEqual([]);
      expect(env.totalCount).toBe(0);
    });

    it('items.item 이 빈 문자열인 형태도 0건이다', () => {
      expect(parseKtoResponse('searchFestival2', okBody({ items: { item: '' } })).items).toEqual([]);
    });

    it('items 가 아예 없어도 0건이다 — 던지지 않는다', () => {
      expect(parseKtoResponse('searchFestival2', okBody({})).items).toEqual([]);
    });
  });

  // ④ 1건 객체 / 2건 배열 (EI-KT-005)
  describe('④ items.item 은 1건이면 객체, 2건 이상이면 배열이다', () => {
    it('객체 1건을 길이 1 배열로 편다', () => {
      const env = parseKtoResponse('detailIntro2', okBody({ items: { item: { contentid: '125266', restdate: '연중무휴' } } }));
      expect(env.items).toHaveLength(1);
      expect(env.items[0]?.restdate).toBe('연중무휴');
    });

    it('배열이면 그대로 편다', () => {
      const env = parseKtoResponse('searchKeyword2', okBody({ items: { item: [{ contentid: '1' }, { contentid: '2' }] } }));
      expect(env.items.map((i) => i.contentid)).toEqual(['1', '2']);
    });

    it('두 형태가 같은 결과를 낸다 — 호출자는 형태를 몰라도 된다', () => {
      const one = { contentid: '125266', usetime: '09:00~18:00' };
      expect(parseKtoResponse('detailIntro2', okBody({ items: { item: one } })).items).toEqual(
        parseKtoResponse('detailIntro2', okBody({ items: { item: [one] } })).items,
      );
    });
  });

  // ⑤ 구 코드체계 (EI-KT-006 · 018)
  describe('⑤ 구 코드체계 필드는 값이 있어도 읽지 않는다', () => {
    it('파싱 단계에서 지운다 — 없는 필드는 실수로도 읽을 수 없다', () => {
      const env = parseKtoResponse(
        'searchKeyword2',
        okBody({ items: { item: { contentid: '1', areacode: '32', sigungucode: '1', cat1: 'A01', cat2: 'A0101', cat3: 'A01010100' } } }),
      );
      const item = env.items[0] ?? {};
      for (const f of LEGACY_CODE_FIELDS) expect(item, f).not.toHaveProperty(f);
      expect(item.contentid).toBe('1');
    });

    it('신 코드체계 필드는 남긴다', () => {
      const env = parseKtoResponse(
        'searchKeyword2',
        okBody({ items: { item: { lDongRegnCd: '51', lDongSignguCd: '150', lclsSystm1: 'NA', lclsSystm2: 'NA01', contenttypeid: '12' } } }),
      );
      expect(env.items[0]).toEqual({ lDongRegnCd: '51', lDongSignguCd: '150', lclsSystm1: 'NA', lclsSystm2: 'NA01', contenttypeid: '12' });
    });

    it('stripLegacyCodeFields 는 원본을 바꾸지 않는다', () => {
      const src = { contentid: '1', cat1: 'A01' };
      expect(stripLegacyCodeFields(src)).toEqual({ contentid: '1' });
      expect(src.cat1).toBe('A01');
    });
  });
});

describe('parseKtoResponse — 실호출 스냅샷', () => {
  it.each([
    ['04_searchKeyword2.json', 'searchKeyword2', 10],
    ['06_locationBasedList2.json', 'locationBasedList2', 10],
    ['07_searchFestival2.json', 'searchFestival2', 1],
    ['09_detailCommon2.json', 'detailCommon2', 1],
    ['10_detailIntro2_12.json', 'detailIntro2', 1],
  ] as const)('%s 를 해석한다', (file, operation, minItems) => {
    const env = parseKtoResponse(operation, read(file));
    expect(env.resultCode).toBe('0000');
    expect(env.items.length).toBeGreaterThanOrEqual(minItems);
    expect(env.items.every((i) => typeof i === 'object')).toBe(true);
  });

  it('실호출 응답에서도 구 코드체계 필드가 남지 않는다', () => {
    const env = parseKtoResponse('searchKeyword2', read('04_searchKeyword2.json'));
    for (const item of env.items) {
      for (const f of LEGACY_CODE_FIELDS) expect(item).not.toHaveProperty(f);
    }
  });

  it('문자열로 오는 숫자 필드를 숫자로 읽는다', () => {
    const env = parseKtoResponse('searchKeyword2', read('04_searchKeyword2.json'));
    expect(typeof env.totalCount).toBe('number');
    expect(typeof env.pageNo).toBe('number');
  });

  it('같은 입력이면 언제나 같은 결과다 (NF-MT-001)', () => {
    const raw = read('10_detailIntro2_12.json');
    expect(parseKtoResponse('detailIntro2', raw)).toEqual(parseKtoResponse('detailIntro2', raw));
  });
});

function catchError(fn: () => unknown): unknown {
  try {
    fn();
  } catch (e) {
    return e;
  }
  throw new Error('던졌어야 한다');
}
