import { parseOperatingInfo } from '../engine/normalize/parse';
import type { HolidayCalendar } from '../engine/calendar/holidays';
import { R01OperatingRule, hasNoRestDayField } from '../engine/rules/r01-operating';
import type { AuditItem, AuditSettings } from '../engine/rules/types';
import { isKtoError, type KtoClient } from '../external/kto';
import type { ReplaceContentPayload } from './patch-types';

/**
 * 후보가 그 자리에 **여는 것이 확인되는가** (R10 야간 자리 · #579).
 *
 * 따로 기준을 만들지 않고 **R01 을 그대로 돌린다.** 수정안이 규칙과 다른 기준으로 고르면
 * 반영 후 재검수에서 또 걸린다. R01 이 아무 말도 안 해야 통과다 — 휴무 · 시간 충돌은 물론
 * 확인 불가(운영시간을 못 읽음)도 떨어뜨린다. 모르는 곳을 밤 일정으로 권하지 않는다
 * (FR-RU-051).
 *
 * 소개정보를 한 번 부른다. 해석은 사전 파서까지다 — 후보 하나 고르자고 LLM 폴백을 부르지
 * 않는다. 조회한 원문은 판정에만 쓰고 어디에도 남기지 않는다 (DR-PR-001).
 */
export interface OpenCheckInput {
  readonly kto: KtoClient;
  readonly candidate: ReplaceContentPayload;
  readonly date: string;
  readonly slot: { readonly dayNo: number; readonly startTime: string; readonly endTime: string };
  readonly holidays: HolidayCalendar;
  readonly settings: AuditSettings;
}

const r01 = new R01OperatingRule();

export async function opensDuring(input: OpenCheckInput): Promise<boolean> {
  const { candidate, slot } = input;
  // 축제 · 숙박은 R01 대상이 아니다 (FR-RU-015). 아무 말도 안 하는 것이 「연다」는 뜻이 아니다
  if (hasNoRestDayField(candidate.contentTypeId)) return false;

  let intro: Record<string, unknown>;
  try {
    intro = await input.kto.detailIntro(candidate.ktoContentId, candidate.contentTypeId);
  } catch (e) {
    if (isKtoError(e)) return false;
    throw e;
  }

  const probe: AuditItem = {
    id: -1, dayNo: slot.dayNo, seq: 0, date: input.date,
    startTime: slot.startTime, endTime: slot.endTime, endTimeSource: 'INPUT',
    lclsSystm1: null, lclsSystm2: candidate.lclsSystm2, lclsSystm3: null,
    mapX: candidate.mapx, mapY: candidate.mapy,
    itemType: 'SIGHT', placeLabel: '', matchStatus: 'CONFIRMED',
    content: {
      ktoContentId: candidate.ktoContentId, contentTypeId: candidate.contentTypeId,
      normalized: parseOperatingInfo({ contentTypeId: candidate.contentTypeId, raw: intro }),
      showFlag: 1, eventPeriod: null, changeVerdict: null,
    },
  };

  const findings = r01.evaluate({
    productId: 0, items: [probe], holidays: input.holidays, settings: input.settings,
  });
  return findings.length === 0;
}
