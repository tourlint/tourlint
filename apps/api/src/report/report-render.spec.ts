import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SEVERITY_WEIGHT_DEFAULT } from '@tourlint/shared';
import { calculateReadiness } from '../engine/score';
import type { StoredFinding } from '../persistence/audit-result.repository';
import { assembleReport, type AssembleInput } from './report-model';
import { FONT_BOLD, FONT_REGULAR, fontsAvailable, missingGlyphs, renderReport } from './report-render';

function model(over: Partial<AssembleInput> = {}): ReturnType<typeof assembleReport> {
  const findings = [
    {
      id: 1, ruleCode: 'R01', severity: 'BLOCKER', reasonCode: 'CLOSED_ON_VISIT',
      targetItemId: 11, targetItemId2: null, message: '방문일이 휴무일입니다.',
      evidence: {}, requiresExternal: false, externalSource: null,
      dismissed: false, dismissReason: null, confirmed: false, needsConfirmation: false, patches: [],
    },
    {
      id: 2, ruleCode: 'R08', severity: 'UNVERIFIED', reasonCode: 'ROUTE_PROVIDER_FAILED',
      targetItemId: 12, targetItemId2: null, message: '이동 시간을 확인하지 못했습니다.',
      evidence: {}, requiresExternal: true, externalSource: 'KAKAO',
      dismissed: false, dismissReason: null, confirmed: false, needsConfirmation: true, patches: [],
    },
  ] as unknown as StoredFinding[];

  return assembleReport({
    run: {
      id: 5, productId: 3, executedAt: new Date('2026-08-29T01:00:00.000Z'),
      rulesetVersion: 'r1', storedScore: 70, isPartial: false, targetCount: 2, failedCount: 0,
      weights: SEVERITY_WEIGHT_DEFAULT, travelTotals: null, findings,
      current: calculateReadiness({
        findings, weights: SEVERITY_WEIGHT_DEFAULT, targetCount: 2, failedCount: 0,
      }),
    },
    product: {
      name: '강릉 커피와 바다 2일', region: '강원특별자치도 강릉시', startDate: '2026-10-28',
      nights: 1, dayCount: 2, headCount: 20, transport: 'BUS', releasedAt: null,
    },
    items: [
      {
        itemId: 11, dayNo: 1, seq: 1, start: '10:00', end: '11:30', place: '오죽헌',
        itemType: 'SIGHT', matchStatus: 'CONFIRMED', ktoContentId: '126508',
      },
      {
        itemId: 12, dayNo: 1, seq: 2, start: '12:00', end: '13:00', place: '동네 카페',
        itemType: 'MEAL', matchStatus: 'EXCLUDED', ktoContentId: null,
      },
    ],
    patches: [{
      appliedAt: '2026-08-28T05:00:00.000Z', reverted: false,
      beforeScore: 29, afterScore: 70, changes: ['시각 변경 — 오죽헌 10:00~11:00 → 10:00~11:30'],
    }],
    evidence: new Map([['126508', {
      ktoContentId: '126508', officialName: '오죽헌', imageUrl: 'https://x/a.jpg',
      homepageUrl: 'https://oj.kr',
      fields: [{ name: 'restdate', value: '매주 월요일 휴관' }, { name: 'usetime', value: '09:00~18:00' }],
      ktoModifiedTime: '20260801120000', hidden: false, unavailableReason: null,
    }]]),
    dataFingerprint: 'ab12cd34',
    generatedAt: new Date('2026-08-29T02:00:00.000Z'),
    ...over,
  });
}

describe('리포트 렌더', () => {
  it('폰트가 저장소에 있다', () => {
    expect(fontsAvailable()).toBe(true);
  });

  it('🔴 출처 표기의 모든 글자를 그릴 수 있다 (FR-PA-062)', () => {
    /*
     * 없는 글리프는 예외가 아니라 빈 네모로 조용히 나간다. Google Fonts 판 나눔고딕에
     * `ⓒ` 가 없어서 폰트를 GothicA1 으로 바꿨는데, 이 검사가 없으면 다음에 폰트를
     * 갈아 끼울 때 같은 사고가 소리 없이 재발한다.
     */
    expect(missingGlyphs('출처: ⓒ한국관광공사', FONT_REGULAR)).toEqual([]);
    expect(missingGlyphs('출처: ⓒ한국관광공사', FONT_BOLD)).toEqual([]);
  });

  it('리포트에 쓰는 문자를 전부 그릴 수 있다', () => {
    const sample = '검수 리포트 R01 2026-08-29 (BLOCKER) 93점 · 86km ~ 차단 오류 주의 확인 불가'
      + ' 무시됨 검수 제외 09:00~18:00 매주 월요일 휴관 일차 순서 장소 유형 상태';
    expect(missingGlyphs(sample)).toEqual([]);
  });

  it('A4 세로 PDF 가 나온다 (UI-S6-008)', async () => {
    const pdf = await renderReport(model());
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    // A4 세로 = 595 x 842pt. MediaBox 로 확인한다
    expect(pdf.toString('latin1')).toMatch(/MediaBox\s*\[\s*0\s+0\s+595\.\d+\s+841\.\d+\s*\]/);
  });

  it('🔴 같은 모델은 같은 바이트가 된다 — 렌더에 숨은 시각·난수가 없다', async () => {
    const [a, b] = await Promise.all([renderReport(model()), renderReport(model())]);
    expect(a.equals(b)).toBe(true);
  });

  it('🔴 이미지를 임베드하지 않는다 (FR-PA-063 · FR-PA-065)', async () => {
    /*
     * 관광지 이미지는 URL 링크로만, 공사 공식 CI · BI 로고는 아예 쓰지 않는다.
     * 산출물에서 확인한다 — 소스에 `doc.image(` 가 없는 것만 봐서는 나중에 헬퍼를
     * 거쳐 들어오는 경로를 못 잡는다.
     */
    const pdf = (await renderReport(model())).toString('latin1');
    expect(pdf).not.toContain('/Subtype /Image');
    expect(pdf).not.toContain('/XObject');
  });

  it('🔴 렌더러 소스에 이미지 삽입 호출이 없다 (FR-PA-063)', () => {
    // 주석은 걷어내고 본다 — 안 그러면 "이 파일에는 doc.image() 가 없다"는 설명이 걸린다
    const src = readFileSync(join(__dirname, 'report-render.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    expect(src).not.toMatch(/\bdoc\.image\s*\(/);
  });

  it('여러 페이지가 되면 쪽 번호가 붙는다', async () => {
    const many = model({
      items: Array.from({ length: 60 }, (_, i) => ({
        itemId: 100 + i, dayNo: Math.floor(i / 8) + 1, seq: (i % 8) + 1,
        start: '10:00', end: '11:00', place: `장소 ${i}`,
        itemType: 'SIGHT', matchStatus: 'CONFIRMED', ktoContentId: null,
      })),
    });
    const pdf = await renderReport(many);
    const pages = (pdf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) ?? []).length;
    expect(pages).toBeGreaterThan(1);
  });
});
