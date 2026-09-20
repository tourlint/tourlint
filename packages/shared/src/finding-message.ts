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

/** 판정·감점은 유지하고 저장된 결과도 같은 말로 표시한다. 분류명을 추측하지 않는다. */
export function findingMessage(rule: string, original: string, evidence: Record<string, unknown>, names: ReadonlyMap<number, string> = new Map(), targetName?: string | null): string {
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
    if (typeof minutes === 'number') {
      const duration = `${Math.floor(minutes / 60)}시간${minutes % 60 ? ` ${minutes % 60}분` : ''}`;
      return original.replace(/연속 [\d.]+시간/, `전체 ${duration}`).replace('공백 구간에 식사를 넣어 주세요.', '일정 사이에 식사나 휴식을 넣어 주세요.');
    }
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
  return PLACE_RULES.has(rule) ? withPlaceName(original, targetName) : original;
}
