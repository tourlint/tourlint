import { describe, expect, it } from 'vitest';
import { LlmClient, createProvider, readLlmConfig } from '../src/external/llm';

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
