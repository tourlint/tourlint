import type { ExceptionReasonCode, ExceptionUnit } from '@tourlint/shared';
import type { TagName } from './tags';

/**
 * `/docs` 에 싣는 엔드포인트 설명 한 건.
 *
 * 설명을 컨트롤러 데코레이터에 흩어 두지 않고 `catalog/` 에 모은다. 심사위원이 읽는 문서라
 * 말투 · 길이 · 순서를 한 곳에서 맞춰야 하고, 무엇이 빠졌는지를 테스트 하나가 볼 수 있어야
 * 한다 (`test/openapi.spec.ts` — 라우트는 있는데 설명이 없거나, 설명은 있는데 라우트가
 * 없으면 빨갛다).
 */

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface ParamDoc {
  readonly description: string;
  /** 조회 파라미터의 필수 여부. 경로 파라미터는 늘 필수다. 기본값 false */
  readonly required?: boolean;
  readonly example?: string | number | boolean;
  readonly type?: 'string' | 'integer' | 'number' | 'boolean';
  readonly enum?: readonly string[];
}

export interface ResponseDoc {
  readonly description: string;
  /** 본문 예시. 운영에서 받은 응답을 줄여 쓴다 — 없는 필드를 지어내지 않는다 */
  readonly example?: unknown;
  /** 기본 `application/json`. 파일을 내려주면 그 형식을 적는다 */
  readonly contentType?: string;
}

export interface BodyDoc {
  readonly description?: string;
  /** Try it out 이 본문 칸에 미리 채우는 값. 그대로 눌러도 다른 사람 데이터가 바뀌지 않는 값으로 든다 */
  readonly example: unknown;
  /** 스키마를 뽑을 값. 예시에 다 넣기 곤란한 필드까지 보여 줄 때만 쓴다. 없으면 `example` */
  readonly schemaFrom?: unknown;
  /** 기본 `application/json` */
  readonly contentType?: string;
  /** 필드별 설명. 키는 점 경로(`items.0.start` 는 `items.start` 로 쓴다) */
  readonly fields?: Readonly<Record<string, string>>;
  /** 반드시 보내야 하는 최상위 필드 */
  readonly required?: readonly string[];
  /** 본문 없이 불러도 된다 */
  readonly optional?: true;
  /** `multipart/form-data` 에서 파일로 올리는 필드. Try it out 에 파일 선택 칸이 나온다 */
  readonly files?: readonly string[];
}

/**
 * 이 엔드포인트가 낼 수 있는 오류 하나. 응답 형식은 공통이다 (API 설계 3-2).
 *
 * **엔드포인트마다 다른 오류만 적는다.** 형식이 틀린 입력은 어디서나 400 `INPUT_INVALID` 라
 * 설명 본문에 「입력이 틀리면 400」 으로 적으면 `applyCatalog` 가 예시를 붙인다 (#612).
 */
export interface ErrorDoc {
  readonly status: number;
  readonly reasonCode: ExceptionReasonCode;
  /** 언제 나는가 */
  readonly when: string;
  /** 실제 응답 문구(코드의 DomainException 메시지). 없으면 `when` 을 쓴다 */
  readonly message?: string;
  /** 실패한 처리 단위. 기본 `REQUEST` */
  readonly unit?: ExceptionUnit;
}

export interface Endpoint {
  /** `'GET /api/v1/products/{productId}'` — OpenAPI 경로 표기 */
  readonly route: `${HttpMethod} /${string}`;
  readonly tag: TagName;
  /** 목록에 보이는 한 줄. 화면에서 하는 일로 쓴다 (예: `상품 목록`) */
  readonly summary: string;
  /** 펼쳤을 때 보이는 설명(마크다운). 무엇을 · 왜 · 주의할 점 */
  readonly description: string;
  /** 어느 화면의 어떤 버튼이 부르는가 */
  readonly screen?: string;
  /** 외부 호출과 예산. 없으면 `없음 — DB 만 읽는다` 처럼 적는다 */
  readonly calls?: string;
  /** 근거 요구사항 · 설계 절 */
  readonly spec?: string;
  /** 로그인 없이 부를 수 있다 */
  readonly public?: true;
  /** 경로 · 조회 파라미터 설명. 이름은 컨트롤러와 같아야 한다 */
  readonly params?: Readonly<Record<string, ParamDoc>>;
  readonly body?: BodyDoc;
  /** 성공 응답. 키는 상태 코드 */
  readonly responses: Readonly<Record<number, ResponseDoc>>;
  readonly errors?: readonly ErrorDoc[];
}
