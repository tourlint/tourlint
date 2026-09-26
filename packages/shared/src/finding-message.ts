import { LCLS_SYSTM2 } from './lcls-systm';
import { TARGET_LABEL, CONCEPT_LABEL, type TargetKey, type ConceptKey } from './target-profile';

const CONTENT_NAMES: Record<string, string> = {
  '12': '관광지', '14': '문화시설', '15': '축제·행사', '28': '레포츠',
  '32': '숙박', '38': '쇼핑', '39': '음식점',
};

/** 메시지 앞에 `장소명 — ` 을 붙이는 규칙. 나머지 규칙은 상품 전체를 말해 이름이 없다 */
const PLACE_RULES = new Set(['R01', 'R02', 'R05', 'R06']);

/** 이름이 비어 저장된 자리 — 옛 결과에는 `" — 본문"` · `"null — 본문"` 으로 남아 있다 */
const EMPTY_LABEL = /^\s*(?:null\s*)?—\s*/;

/**
 * 장소 이름을 **표시할 때** 메시지 앞에 채운다 (#606).
 *
 * 규칙은 판정 시점에 `장소명 — 본문` 으로 문장을 굳히는데, 장소 담기 · 수정안 삽입으로 들어온
 * 항목은 `place_label` 이 비어 있다. 명칭이 공사 원문이라 저장하지 않기 때문이다
 * (DR-PR-001). 그래서 화면에 「 — 휴무일 정보를 확인할 수 없습니다」 가 떴다.
 *
 * 이름은 부르는 쪽이 정한다 — 사용자가 적은 이름이 있으면 그것, 없으면 표시 시점에 조회한
 * 공사 명칭이다. 이름을 못 얻으면 본문만 보여 준다. 지어내지 않는다.
 */
export function withPlaceName(message: string, name?: string | null): string {
  const core = message.replace(EMPTY_LABEL, '');
  const label = name?.trim() ?? '';
  if (label === '') return core;
  return core.startsWith(`${label} —`) ? core : `${label} — ${core}`;
}

/**
 * R07 「식사(이름)가 60분으로 …」 의 빈 괄호를 채운다 (#713).
 *
 * 장소 담기로 넣은 식당은 `place_label` 이 비어 저장된 문장이 「식사()가 60분으로」 다. 이름은
 * 공사 원문이라 저장할 수 없으니(DR-PR-001) 여기서 표시할 때 채운다. 이름을 못 얻으면 괄호를
 * 지운다 — 빈 괄호를 보이지도, 지어내지도 않는다.
 */
function fillMealName(message: string, name?: string | null): string {
  const label = name?.trim() ?? '';
  return message.replace(/(식사|휴식)\(\)/, (_, kind: string) => (label === '' ? kind : `${kind}(${label})`));
}

/** 두 곳을 잇는 규칙 — 문장 안에 대상 두 곳의 이름이 든다 (R03 겹침 · R08 이동) */
const PAIR_RULES = new Set(['R03', 'R08']);

/**
 * R03 · R08 문장의 빈 이름을 **표시할 때** 채운다.
 *
 * 두 규칙은 두 곳의 이름을 문장 안에 넣어 굳히는데, 이름을 저장하지 않은 곳(장소 담기 · 등록 화면에서
 * 고른 곳)은 자리가 비어 「(10:00~11:30) 와 …」 · 「 →  이동에 …」 가 된다 — 이름은 공사 명칭이라
 * 저장할 수 없다 (DR-PR-001). 저장된 이름은 그대로 두고 빈 자리만 부르는 쪽이 준 이름으로 채운다.
 * `first` 는 대상(`targetItemId`), `second` 는 두 번째 대상(`targetItemId2`)이다. 이름을 못 얻은
 * 자리는 빈 채로 둔다 — 지어내지 않는다.
 */
export function withPairNames(rule: string, message: string, evidence: Record<string, unknown>, first?: string | null, second?: string | null): string {
  if (!PAIR_RULES.has(rule)) return message;
  const a = first?.trim() ?? '';
  const b = second?.trim() ?? '';
  if (rule === 'R08') {
    const m = /^(.*?) → (.*?) (이동에 약 |구간별 대중교통 |이동시간을 조회하지 )/.exec(message);
    if (m === null) return message;
    return `${(m[1] ?? '').trim() || a} → ${(m[2] ?? '').trim() || b} ${m[3] ?? ''}${message.slice(m[0].length)}`;
  }
  const m = /^(.*?)\((\d{2}:\d{2}~\d{2}:\d{2})\) 와 (.*?)\((\d{2}:\d{2}~\d{2}:\d{2})\) 가 /.exec(message);
  if (m === null) return message;
  const n1 = (m[1] ?? '').trim() || a;
  const n2 = (m[3] ?? '').trim() || b;
  let rest = message.slice(m[0].length);
  // 「(ㄱ · ㄴ 은 기본 체류시간을 적용한 값입니다)」 — 끝 시각을 채운 곳의 이름이 든다. 근거로 어느 곳인지 안다
  const sources = [evidence.first, evidence.second].map((x) => (x as { endTimeSource?: unknown } | undefined)?.endTimeSource);
  if (sources.every((x) => typeof x === 'string')) {
    const estimated = [n1, n2].filter((_, i) => sources[i] !== 'INPUT');
    rest = rest.replace(/ \((.*) 은 기본 체류시간을 적용한 값입니다\)$/, ` (${estimated.join(' · ')} 은 기본 체류시간을 적용한 값입니다)`);
  }
  return `${n1}(${m[2] ?? ''}) 와 ${n2}(${m[4] ?? ''}) 가 ${rest}`;
}

/** 판정·감점은 유지하고 저장된 결과도 같은 말로 표시한다. 분류명을 추측하지 않는다. */
export function findingMessage(rule: string, original: string, evidence: Record<string, unknown>, names: ReadonlyMap<number, string> = new Map(), targetName?: string | null, secondName?: string | null): string {
  if (rule === 'R04' && typeof evidence.count === 'number' && typeof evidence.threshold === 'number') {
    const places = Array.isArray(evidence.itemIds)
      ? [...new Set(evidence.itemIds.map(id => names.get(Number(id))).filter((name): name is string => !!name))].slice(0, 3) : [];
    const parentName = LCLS_SYSTM2[String(evidence.key).slice(0, 4)]?.name;
    const kind = evidence.axis === 'contentTypeId' ? CONTENT_NAMES[String(evidence.key)] ?? '비슷한 종류의 장소' : parentName ? `${parentName}에 속한 비슷한 관광지` : '비슷한 종류의 관광지';
    const scope = evidence.scope === 'DAY' ? `${evidence.dayNo}일차` : '전체 일정';
    return `${scope}에 ${kind} 방문이 ${evidence.count}곳으로 몰려 있어요.${places.length ? ` 해당 장소: ${places.join(', ')}${evidence.count > places.length ? ' 등' : ''}.` : ''} 같은 종류를 ${evidence.threshold}곳 이상 방문하면 주의가 표시됩니다. 한 곳을 다른 즐길 거리로 바꿔 보세요.`;
  }
  if (rule === 'R07') {
    const span = evidence.span as { minutes?: number } | undefined;
    const minutes = span?.minutes;
    const named = fillMealName(original, targetName);
    if (typeof minutes === 'number') {
      const duration = `${Math.floor(minutes / 60)}시간${minutes % 60 ? ` ${minutes % 60}분` : ''}`;
      return named.replace(/연속 [\d.]+시간/, `전체 ${duration}`).replace('공백 구간에 식사를 넣어 주세요.', '일정 사이에 식사나 휴식을 넣어 주세요.');
    }
    return named;
  }
  if (rule === 'R10' && evidence.unverified === true) {
    const target = TARGET_LABEL[evidence.targetKey as TargetKey] ?? '선택한 고객';
    const concept = CONCEPT_LABEL[evidence.conceptKey as ConceptKey] ?? '여행 주제';
    return `${target} · ${concept} 여행에 맞는 구성 기준이 아직 없어 확인하지 못했어요. 검수 기준 설정을 확인해 주세요.`;
  }
  if (rule === 'R10' && Array.isArray(evidence.missingLcls2)) {
    const missing = evidence.missingLcls2.map(code => LCLS_SYSTM2[String(code)]?.name ?? '다른 즐길 거리');
    if (evidence.expectsNight === true && evidence.hasNight === false) missing.push(`${evidence.nightSlotFrom ?? '저녁'} 이후 일정`);
    const profile = original.split(' 상품인데 ')[0];
    if (missing.length && original.includes(' 상품인데 ')) return `${profile} 여행에 어울리는 ${missing.join('·')} 방문이 아직 없어요. 해당 장소를 추가해 일정을 보완해 보세요.`;
  }
  if (PAIR_RULES.has(rule)) return withPairNames(rule, original, evidence, targetName, secondName);
  return PLACE_RULES.has(rule) ? withPlaceName(original, targetName) : original;
}
