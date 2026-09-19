import type { OpenAPIObject } from '@nestjs/swagger';
import { EXCEPTION_REASON_CODE, EXCEPTION_UNIT } from '@tourlint/shared';
import { INPUT_INVALID_MESSAGE } from '../common/all-exceptions.filter';
import { TAGS } from './tags';
import type { Endpoint, ErrorDoc, HttpMethod, ParamDoc, ResponseDoc } from './types';

/**
 * Nest 가 만든 문서에 `catalog/` 의 설명을 입힌다.
 *
 * Nest 가 알아서 채우는 것은 경로와 파라미터 이름뿐이다. 조회 파라미터는 전부 필수로 찍히고
 * (선택 입력인데도), 요청 본문 타입이 인터페이스라 본문은 하나도 잡히지 않는다. 그래서
 * 파라미터 · 본문 · 응답은 여기서 **덮어쓴다.**
 *
 * 문서 순서도 여기서 정한다. `paths` 를 카탈로그 순서로 다시 짜고 `tags` 를 흐름 순서로 둔다.
 */

export const SESSION_SCHEME = 'session';

type Operation = Record<string, unknown> & { parameters?: Parameter[] };
type Parameter = {
  name: string;
  in: string;
  required?: boolean;
  description?: string;
  example?: unknown;
  schema?: Record<string, unknown>;
};
type Schema = Record<string, unknown>;

export interface CatalogCoverage {
  /** 문서에 있는데 설명이 없는 라우트 */
  readonly undocumented: readonly string[];
  /** 설명은 있는데 문서에 없는 라우트 — 경로가 바뀌었거나 지워졌다 */
  readonly stale: readonly string[];
}

export function applyCatalog(document: OpenAPIObject, catalog: readonly Endpoint[]): CatalogCoverage {
  const source = document.paths as Record<string, Record<string, Operation>>;
  const ordered: Record<string, Record<string, Operation>> = {};
  const stale: string[] = [];
  const seen = new Set<string>();

  for (const entry of catalog) {
    const { method, path } = splitRoute(entry.route);
    const operation = source[path]?.[method.toLowerCase()];
    if (operation === undefined) {
      stale.push(entry.route);
      continue;
    }
    seen.add(`${method} ${path}`);
    decorate(operation, entry, path);
    (ordered[path] ??= {})[method.toLowerCase()] = operation;
  }

  // 설명이 없는 라우트도 버리지 않고 맨 뒤에 둔다. 테스트가 잡을 때까지 문서에서 사라지면 안 된다
  const undocumented: string[] = [];
  for (const [path, methods] of Object.entries(source)) {
    for (const [method, operation] of Object.entries(methods)) {
      const key = `${method.toUpperCase()} ${path}`;
      if (seen.has(key)) continue;
      undocumented.push(key);
      (ordered[path] ??= {})[method] = operation;
    }
  }

  document.paths = ordered as OpenAPIObject['paths'];
  document.tags = TAGS.map((t) => ({ name: t.name, description: t.description }));
  return { undocumented, stale };
}

function splitRoute(route: Endpoint['route']): { method: HttpMethod; path: string } {
  const space = route.indexOf(' ');
  return { method: route.slice(0, space) as HttpMethod, path: route.slice(space + 1) };
}

function decorate(operation: Operation, entry: Endpoint, path: string): void {
  operation.tags = [entry.tag];
  operation.summary = entry.summary;
  operation.description = describe(entry);
  operation.security = entry.public === true ? [] : [{ [SESSION_SCHEME]: [] }];
  operation.parameters = parameters(operation.parameters ?? [], entry.params ?? {}, path);

  if (entry.body !== undefined) {
    const body = entry.body;
    const contentType = body.contentType ?? 'application/json';
    const schema = schemaOf(body.schemaFrom ?? body.example, body.fields ?? {}, '', body.required);
    // 파일 필드는 글자 칸이 아니라 파일 선택 칸이어야 한다. 폼 본문은 예시 대신 스키마로 칸을 그린다
    const properties = schema.properties as Record<string, Schema> | undefined;
    for (const name of body.files ?? []) {
      if (properties?.[name] !== undefined) properties[name] = { ...properties[name], type: 'string', format: 'binary' };
    }
    operation.requestBody = {
      required: body.optional !== true,
      ...(body.description === undefined ? {} : { description: body.description }),
      content: {
        [contentType]: body.files === undefined ? { schema, example: body.example } : { schema },
      },
    };
  } else {
    delete operation.requestBody;
  }

  operation.responses = responses(entry);
}

/** 설명 한두 문장. 로그인이 필요한지는 자물쇠 표시가 말한다 */
function describe(entry: Endpoint): string {
  return entry.description.trim();
}

function parameters(existing: Parameter[], docs: Readonly<Record<string, ParamDoc>>, path: string): Parameter[] {
  const out: Parameter[] = [];
  const names = new Set<string>();

  for (const p of existing) {
    names.add(p.name);
    out.push(withDoc(p, docs[p.name]));
  }
  // 컨트롤러가 `@Query()` 로 통째로 받는 조회 파라미터는 Nest 가 모른다. 설명에 있으면 더한다
  for (const [name, doc] of Object.entries(docs)) {
    if (names.has(name)) continue;
    const inPath = path.includes(`{${name}}`);
    out.push(withDoc({ name, in: inPath ? 'path' : 'query' }, doc));
  }
  // 경로 파라미터가 먼저, 조회 파라미터는 설명에 적은 순서로. Nest 는 데코레이터 순서대로 늘어놓는다
  const order = Object.keys(docs);
  const rank = (p: Parameter): number =>
    (p.in === 'path' ? 0 : 1000) + (order.includes(p.name) ? order.indexOf(p.name) : 999);
  return out.sort((a, b) => rank(a) - rank(b));
}

function withDoc(p: Parameter, doc: ParamDoc | undefined): Parameter {
  const isPath = p.in === 'path';
  const type = doc?.type ?? (p.schema?.type === 'number' ? 'integer' : (p.schema?.type as string | undefined) ?? 'string');
  return {
    name: p.name,
    in: p.in,
    required: isPath ? true : doc?.required === true,
    ...(doc === undefined ? {} : { description: doc.description }),
    ...(doc?.example === undefined ? {} : { example: doc.example }),
    schema: { type, ...(doc?.enum === undefined ? {} : { enum: [...doc.enum] }) },
  };
}

function responses(entry: Endpoint): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [status, doc] of Object.entries(entry.responses)) out[status] = successResponse(doc);

  const errors = [...(entry.errors ?? [])];
  // 형식이 틀린 입력은 어디서나 400 INPUT_INVALID 다. 설명에 400 을 적은 엔드포인트에 예시를 붙인다
  if (/\b400\b/.test(entry.description) && !errors.some((e) => e.reasonCode === 'INPUT_INVALID')) {
    errors.push({
      status: 400,
      reasonCode: 'INPUT_INVALID',
      when: '보낸 값의 형식이 틀림',
      message: INPUT_INVALID_MESSAGE,
    });
  }
  // 로그인이 필요한 API 는 모두 401 을 낼 수 있다. 엔드포인트마다 적지 않는다
  if (entry.public !== true && !errors.some((e) => e.status === 401)) {
    errors.push({
      status: 401,
      reasonCode: 'NOT_AUTHENTICATED',
      when: '로그인하지 않았음',
      message: '로그인이 필요합니다.',
    });
  }
  const byStatus = new Map<number, ErrorDoc[]>();
  for (const e of errors) byStatus.set(e.status, [...(byStatus.get(e.status) ?? []), e]);
  for (const [status, list] of [...byStatus].sort((a, b) => a[0] - b[0])) {
    out[String(status)] = errorResponse(list);
  }
  return out;
}

function successResponse(doc: ResponseDoc): Record<string, unknown> {
  if (doc.example === undefined && doc.contentType === undefined) return { description: doc.description };
  const contentType = doc.contentType ?? 'application/json';
  const binary = !contentType.includes('json');
  return {
    description: doc.description,
    content: {
      [contentType]: binary
        ? { schema: { type: 'string', format: 'binary' } }
        : { schema: schemaOf(doc.example, {}, ''), example: doc.example },
    },
  };
}

function errorResponse(list: readonly ErrorDoc[]): Record<string, unknown> {
  return {
    description: list.map((e) => `\`${e.reasonCode}\` — ${e.when}`).join('<br>'),
    content: {
      'application/json': {
        schema: ERROR_SCHEMA,
        examples: Object.fromEntries(list.map((e, i) => [
          list.filter((x) => x.reasonCode === e.reasonCode).length > 1 ? `${e.reasonCode}_${String(i + 1)}` : e.reasonCode,
          { summary: e.when, value: errorBody(e) },
        ])),
      },
    },
  };
}

function errorBody(e: ErrorDoc): Record<string, unknown> {
  return {
    reasonCode: e.reasonCode,
    message: e.message ?? e.when,
    unit: e.unit ?? 'REQUEST',
    traceId: '9f2c1a7b3e4d5f60',
    occurredAt: '2026-09-20T01:23:45.678Z',
  };
}

/** 모든 오류의 공통 모양 (API 설계 3-2 · `AllExceptionsFilter`) */
const ERROR_SCHEMA: Schema = {
  type: 'object',
  required: ['reasonCode', 'message', 'unit', 'traceId', 'occurredAt'],
  properties: {
    reasonCode: { type: 'string', enum: [...EXCEPTION_REASON_CODE], description: '오류 종류' },
    message: { type: 'string', description: '사용자에게 보여 줄 안내 문구' },
    unit: { type: 'string', enum: [...EXCEPTION_UNIT], description: '오류가 난 범위' },
    fieldErrors: {
      type: 'array',
      description: '입력 값 오류일 때 항목별 사유',
      items: { type: 'object', properties: { field: { type: 'string' }, message: { type: 'string' } } },
    },
    traceId: { type: 'string', description: '오류 추적 번호' },
    occurredAt: { type: 'string', format: 'date-time' },
  },
};

const OMITTED = /^…외 \d+개$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

/**
 * 예시 값에서 스키마를 뽑는다. 예시와 스키마가 따로 놀지 않게 하려는 것이다 — 필드를
 * 예시에만 더하고 스키마에 안 더하는 일이 없다.
 */
export function schemaOf(
  value: unknown,
  fields: Readonly<Record<string, string>>,
  path: string,
  required?: readonly string[],
): Schema {
  const note = fields[path];
  const withNote = (s: Schema): Schema => (note === undefined ? s : { ...s, description: note });

  if (value === null || value === undefined) return withNote({ nullable: true });
  if (Array.isArray(value)) {
    const sample = value.find((v) => !(typeof v === 'string' && OMITTED.test(v)));
    const items = sample === undefined ? {} : schemaOf(sample, fields, path, undefined);
    // 배열의 설명을 항목에 한 번 더 달지 않는다 — 화면에 같은 문장이 두 번 보인다
    if (note !== undefined && items.description === note) delete items.description;
    return withNote({ type: 'array', items });
  }
  switch (typeof value) {
    case 'string':
      return withNote({
        type: 'string',
        ...(DATE_TIME.test(value) ? { format: 'date-time' } : DATE.test(value) ? { format: 'date' } : {}),
      });
    case 'number':
      return withNote({ type: Number.isInteger(value) ? 'integer' : 'number' });
    case 'boolean':
      return withNote({ type: 'boolean' });
    case 'object': {
      const entries = Object.entries(value as Record<string, unknown>);
      return withNote({
        type: 'object',
        ...(required === undefined || required.length === 0 ? {} : { required: [...required] }),
        properties: Object.fromEntries(entries.map(([k, v]) => [k, schemaOf(v, fields, path === '' ? k : `${path}.${k}`)])),
      });
    }
    default:
      return withNote({});
  }
}
