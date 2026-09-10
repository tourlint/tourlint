import { LlmClient, createProvider, readLlmConfig } from '../external/llm/llm.client';
import { isLlmError } from '../external/llm/llm.errors';
import type { ApiCallLogger } from '../external/api-call-log';
import { NL_MAX_CHARS, NL_SCHEMA, NL_SYSTEM, toParseResult } from './nl-parse';
import type { ParseResult } from './schedule-parse';

/**
 * 자연어 일정 정형화 (FR-IN-003).
 *
 * **저장하지 않는다.** 결과는 화면이 편집한 뒤 사용자가 저장한다 (UI-S2-010).
 *
 * LLM 이 없거나 실패하면 `NL_STRUCTURE_FAILED` 로 **거부한다** — 빈 상품을 만들지 않고
 * 직접 입력 · 양식 업로드로 유도한다 (EX-IN-010 · 19_예외처리 604행).
 */
export class NlService {
  constructor(private readonly logs?: ApiCallLogger) {}

  async structure(text: string): Promise<ParseResult> {
    const input = text.trim();
    if (input === '') {
      return reject('붙여넣은 일정이 비어 있습니다. 일정 텍스트를 붙여넣어 주세요.');
    }
    if (input.length > NL_MAX_CHARS) {
      return {
        nights: 0,
        items: [],
        errors: [],
        rejected: {
          code: 'UPLOAD_LIMIT_EXCEEDED',
          message: `붙여넣은 글이 ${String(input.length)}자입니다. ${String(NL_MAX_CHARS)}자 이하로 줄여 주세요.`,
        },
      };
    }

    const config = readLlmConfig();
    if (config === null) {
      return reject('자연어 변환을 쓸 수 없습니다. 직접 입력하거나 지정 양식으로 올려 주세요.');
    }

    try {
      const llm = new LlmClient({ provider: createProvider(config), config, logger: this.logs });
      const { value } = await llm.structured({
        purpose: 'STRUCTURE',
        system: NL_SYSTEM,
        input,
        schema: NL_SCHEMA,
        schemaName: 'itinerary',
      });
      return toParseResult(value);
    } catch (e) {
      // 모델 쪽 사정은 사용자 문구로 바꾼다. 스택도 원문도 응답에 담지 않는다 (NF-SC-009)
      if (isLlmError(e)) {
        return reject('자연어를 일정으로 바꾸지 못했습니다. 직접 입력하거나 지정 양식으로 올려 주세요.');
      }
      throw e;
    }
  }
}

function reject(message: string): ParseResult {
  return { nights: 0, items: [], errors: [], rejected: { code: 'NL_STRUCTURE_FAILED', message } };
}
