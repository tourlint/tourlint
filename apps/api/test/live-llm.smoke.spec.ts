import { describe, expect, it } from 'vitest';
import { LlmClient, createProvider, readLlmConfig } from '../src/external/llm';
import { NL_SCHEMA, NL_SYSTEM, toParseResult } from '../src/upload/nl-parse';

/**
 * 실호출 스모크. `LIVE_LLM=1` 일 때만 돈다.
 *
 * 어댑터가 실제 API 에 붙는지는 가짜 응답으로 확인할 수 없다. 도구 강제 · temperature 0 ·
 * 응답 모양은 제공자가 바꿀 수 있는 것들이라 한 번은 진짜로 부딪쳐 봐야 한다.
 */
const LIVE = process.env.LIVE_LLM === '1';
const config = readLlmConfig();

describe.skipIf(!LIVE || config === null)('LLM 실호출 스모크', () => {
  it('구조화 출력이 실제로 스키마대로 온다', async () => {
    const client = new LlmClient({ provider: createProvider(config!), config: config! });
    const out = await client.structured({
      purpose: 'NORMALIZE',
      system: '한국어 관광지 운영정보 조각을 읽고 휴무 요일만 뽑는다. 확실하지 않으면 빈 배열을 준다.',
      input: '매주 월요일 휴관 (공휴일인 경우 익일 휴관)',
      schemaName: 'closed_days',
      schema: {
        type: 'object',
        properties: {
          weeklyClosed: { type: 'array', items: { type: 'string', enum: ['MON','TUE','WED','THU','FRI','SAT','SUN'] } },
        },
        required: ['weeklyClosed'],
        additionalProperties: false,
      },
    });

    expect(out.value).toMatchObject({ weeklyClosed: ['MON'] });
    // 실제로 응답한 모델을 남긴다. 설정과 다를 수 있다
    expect(out.model).toContain('claude');
  }, 30_000);
});

/**
 * 자연어 일정 정형화 실호출 (FR-IN-003 AC).
 *
 * 붙여넣은 문장이 실제로 표가 되는지는 모델을 불러야 안다. 스키마를 통과하는지까지는
 * 가짜로 볼 수 있지만(`nl-parse.spec.ts`), **문장을 옮기는 것 자체**는 여기서만 확인된다.
 */
describe.skipIf(!LIVE || config === null)('자연어 일정 정형화 실호출 (FR-IN-003)', () => {
  it('명세 AC 문장이 5개 항목으로 온다', async () => {
    const client = new LlmClient({ provider: createProvider(config!), config: config! });
    const { value } = await client.structured({
      purpose: 'STRUCTURE',
      system: NL_SYSTEM,
      input: '1일차 / 10시 오죽헌 들렀다가 / 12시쯤 중앙시장에서 점심 / 2시 안목해변 / 저녁 6시 식사하고 8시 숙소',
      schema: NL_SCHEMA,
      schemaName: 'itinerary',
    });

    const out = toParseResult(value);
    expect(out.rejected).toBeUndefined();
    expect(out.items).toHaveLength(5);
    // 일차 · 시각 · 유형이 함께 나와야 한다 (13_기능요구사항 484행)
    expect(out.items.every((i) => i.day === 1)).toBe(true);
    expect(out.items.map((i) => i.start)).toEqual(['10:00', '12:00', '14:00', '18:00', '20:00']);
    expect(out.items.map((i) => i.itemType)).toEqual(['SIGHT', 'MEAL', 'SIGHT', 'MEAL', 'LODGING']);
  }, 60_000);
});
