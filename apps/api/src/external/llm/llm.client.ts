import { createHash } from 'node:crypto';
import type { ApiCallLogger, CallStatus } from '../api-call-log';
import { AnthropicProvider } from './anthropic.provider';
import { LlmError, LlmNotConfiguredError, LlmUnavailableError } from './llm.errors';
import type { LlmProvider, LlmPurpose, LlmStructuredRequest, LlmStructuredResult } from './llm.types';

/**
 * 용도별 모델을 고르고, 실패를 정해진 만큼만 되돌린다 (EI-LM-003).
 *
 * **재시도는 1회다.** 그 뒤에는 해당 조각을 확인 불가로 확정하고 검수를 계속한다 —
 * LLM 이 안 된다고 검수가 서면 안 된다 (FR-AU-010).
 */

export interface LlmConfig {
  readonly provider: string;
  readonly apiKey: string;
  /** F01 자연어 일정 구조화 */
  readonly modelStructure: string;
  /** F03 운영정보 정규화 폴백 */
  readonly modelNormalize: string;
}

/** 설정이 없으면 null 이다. 없다고 던지지 않는다 — LLM 없이도 검수는 돈다 */
export function readLlmConfig(env: NodeJS.ProcessEnv = process.env): LlmConfig | null {
  const get = (k: string): string => (env[k] ?? '').trim();
  const apiKey = get('LLM_API_KEY');
  if (apiKey === '') return null;
  const provider = get('LLM_PROVIDER');
  return {
    provider: provider === '' ? 'anthropic' : provider,
    apiKey,
    modelStructure: get('LLM_MODEL_STRUCTURE'),
    modelNormalize: get('LLM_MODEL_NORMALIZE'),
  };
}

/** 설정에서 제공자를 만든다. 아는 이름이 아니면 조용히 넘어가지 않는다 (EI-LM-006) */
export function createProvider(
  config: LlmConfig,
  options: { fetchImpl?: typeof globalThis.fetch } = {},
): LlmProvider {
  switch (config.provider) {
    case 'anthropic':
      return new AnthropicProvider(config.apiKey, options);
    default:
      throw new LlmNotConfiguredError(`모르는 LLM 제공자입니다: ${config.provider}`);
  }
}

export class LlmClient {
  private readonly provider: LlmProvider;
  private readonly config: LlmConfig;
  private readonly logger: ApiCallLogger | undefined;
  private readonly auditRunId: number | null;

  constructor(opts: {
    provider: LlmProvider;
    config: LlmConfig;
    logger?: ApiCallLogger;
    auditRunId?: number | null;
  }) {
    this.provider = opts.provider;
    this.config = opts.config;
    this.logger = opts.logger;
    this.auditRunId = opts.auditRunId ?? null;
  }

  /** 용도마다 모델이 다르다. 병목이 다르기 때문이다 (이슈 #6) */
  modelFor(purpose: LlmPurpose): string {
    const model = purpose === 'STRUCTURE' ? this.config.modelStructure : this.config.modelNormalize;
    if (model === '') throw new LlmNotConfiguredError(`${purpose} 용 모델이 설정되지 않았습니다`);
    return model;
  }

  /**
   * 부르고, 한 번만 되돌린다.
   *
   * 스키마 불일치는 재시도하지 않는다 — 같은 모델에 같은 입력이면 같은 모양이 온다.
   * 되돌릴 값어치가 있는 건 네트워크 · 타임아웃 · 429 · 5xx 뿐이다.
   */
  async structured(req: LlmStructuredRequest): Promise<LlmStructuredResult> {
    const model = this.modelFor(req.purpose);
    let last: LlmError | undefined;

    for (let attempt = 0; attempt <= 1; attempt++) {
      const startedAt = Date.now();
      try {
        const result = await this.provider.structured(req, model);
        this.log(req.purpose, model, startedAt, 'OK', null);
        return result;
      } catch (e) {
        const err = e instanceof LlmError ? e : new LlmUnavailableError((e as Error).name);
        const status: CallStatus = err.message.includes('TIMEOUT') ? 'TIMEOUT' : 'FAIL';
        this.log(req.purpose, model, startedAt, status, err.reasonCode);
        if (!err.retryable) throw err;
        last = err;
      }
    }
    throw last ?? new LlmUnavailableError('알 수 없는 실패');
  }

  /**
   * 호출 로그. **프롬프트도 응답도 남기지 않는다.**
   *
   * 둘 다 공사 원문 조각을 담고 있어 저장 경계 밖이다. 남기는 건 언제 · 어느 모델을 ·
   * 얼마나 걸려 불렀는지와 결과뿐이다 (NF-OB-006 · DB 명세서 6-4 누출 경로 ①).
   */
  private log(
    purpose: LlmPurpose,
    model: string,
    startedAt: number,
    status: CallStatus,
    resultCode: string | null,
  ): void {
    if (this.logger === undefined) return;
    try {
      // 모델명은 설정값이지 원문이 아니다. 어느 모델이 얼마나 실패하는지 봐야 한다
      void this.logger.record({
        provider: 'LLM',
        operation: `${purpose}:${model}`,
        calledAt: new Date(startedAt),
        status,
        httpStatus: null,
        resultCode,
        latencyMs: Date.now() - startedAt,
        auditRunId: this.auditRunId,
      });
    } catch {
      // 로그가 실패해도 호출 결과를 덮지 않는다
    }
  }
}

/**
 * 조각을 식별하는 해시.
 *
 * **원문 대신 이걸 저장한다.** 같은 조각을 두 번 부르지 않게 하고(EI-LM-005), 같은
 * 입력에 같은 결과가 나오게 한다(NF-MT-001) — LLM 은 temperature 0 이어도 매번 같은
 * 답을 보장하지 않는다. 모델명을 섞는 이유는 모델을 바꾸면 답도 달라지기 때문이다.
 */
export function fragmentKey(purpose: LlmPurpose, model: string, input: string): string {
  return createHash('sha256').update(`${purpose}${model}${input}`).digest('hex');
}
