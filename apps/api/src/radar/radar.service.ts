import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import type { Pool } from 'pg';
import { DomainException } from '../common/domain.exception';
import { t1Window, t2Window, T1_DEFAULT_DAYS } from '../engine/signals';
import { DemandSignalRepository, type StoredSignal } from '../persistence/demand-signal.repository';
import { DB_POOL } from '../persistence/db';
import { diffNormalized } from './change-diff';
import { notificationCopy } from './notification-copy';
import { RadarRepository, type ChangeRow } from './radar.repository';

/**
 * 수요 · 변경 레이더 (F12 ~ F14 · FR-MO-050 · 006 · 058 · FR-RU-110 ~ 122).
 *
 * **아무것도 새로 산출하지 않는다.** 조건 판정과 T1 · T2 산출은 배치가 끝냈고 여기서는
 * 저장된 것을 계정 범위로 읽어 표시 형태로 바꿀 뿐이다. 공사 호출이 0건이다.
 */
@Injectable()
export class RadarService {
  private readonly radar: RadarRepository;
  private readonly signals: DemandSignalRepository;

  constructor(@Inject(DB_POOL) pool: Pool) {
    this.radar = new RadarRepository(pool);
    this.signals = new DemandSignalRepository(pool);
  }

  /** 요약 (FR-MO-050 · NF-OB-004) */
  async summary(accountId: number): Promise<Record<string, unknown>> {
    const [counts, batch] = await Promise.all([
      this.radar.counts(accountId),
      this.radar.batchState(),
    ]);
    return {
      risk: counts.risk,
      opportunity: counts.opportunity,
      unread: counts.unread,
      affectedProducts: counts.affectedProducts,
      changedContents: counts.changedContents,
      lastBatch: batch === null ? null : {
        runAt: batch.lastRunAt === null ? null : batch.lastRunAt.toISOString(),
        covered: batch.lastCovered,
        status: batch.lastStatus,
        itemCount: batch.lastItemCount,
      },
    };
  }

  /** 변경 감지 내역 (FR-MO-006 · 058) */
  async changes(accountId: number, page: number, size: number): Promise<Record<string, unknown>> {
    const found = await this.radar.changes(accountId, page, size);
    return {
      content: found.rows.map(toChangeResponse),
      page, size, totalElements: found.total,
    };
  }

  /**
   * 수요 신호 (FR-RU-110 ~ 122 · FR-MO-056).
   *
   * 배치가 산출해 둔 값을 읽는다. **없으면 `null` 이고 0 이 아니다** — 0 은 「세어 보니
   * 없었다」이고 `null` 은 「아직 안 세어 봤다」다. 화면이 그 둘을 구분해야 한다.
   */
  async signalsOf(accountId: number, productId: number): Promise<Record<string, unknown>> {
    const product = await this.radar.product(accountId, productId);
    if (product === null) {
      throw new DomainException(
        HttpStatus.NOT_FOUND, 'NOT_FOUND', '상품을 찾을 수 없습니다. 목록에서 다시 선택해 주세요.',
      );
    }

    const region = {
      ldongRegnCd: product.ldongRegnCd,
      ldongSignguCd: product.ldongSignguCd,
    };
    const today = new Date().toISOString().slice(0, 10);
    const w1 = t1Window(today, region, T1_DEFAULT_DAYS);
    const w2 = t2Window(product.startDate, product.nights, region);

    const [t1, t2] = await Promise.all([
      w1 === null ? Promise.resolve(null) : this.signals.find('T1', w1),
      w2 === null ? Promise.resolve(null) : this.signals.find('T2', w2),
    ]);

    return {
      productId: product.productId,
      t1: toSignalResponse(t1),
      t2: toSignalResponse(t2),
      /*
       * FR-RU-121 — 강도 점수를 만들지 않는다. 건수와 유형 분포뿐이다.
       * FR-RU-122 · FR-MO-055 — SNS · 검색 트렌드 · 혼잡도를 쓰지 않고 판매량 · 흥행을
       * 말하지 않는다. 응답에 그런 필드를 두지 않는 것이 그 약속의 이행이다.
       */
      notice: '관측된 건수와 유형 분포입니다. 판매량 · 흥행을 예측하지 않습니다.',
    };
  }
}

/**
 * 신호 하나. 산출 전이면 `null` 이다.
 *
 * `window` 를 그대로 실어 화면이 「최근 30일」처럼 조회 조건을 적을 수 있게 한다 (FR-MO-056).
 */
function toSignalResponse(s: StoredSignal | null): Record<string, unknown> | null {
  if (s === null) return null;
  return {
    count: s.count,
    byType: s.byType,
    window: { from: s.window.from, to: s.window.to },
    computedAt: s.computedAt.toISOString(),
  };
}

/**
 * 변경 한 줄 (FR-MO-006 · 058).
 *
 * 관광지명은 **사용자가 입력한 `place_label`** 이다. 공사 원문을 싣지 않는다 (FR-MO-002).
 */
function toChangeResponse(row: ChangeRow): Record<string, unknown> {
  const copy = notificationCopy(row.condition, row.hidden);
  const readable = diffNormalized(row.normalizedBefore, row.normalizedAfter);
  return {
    notificationId: row.notificationId,
    productId: row.productId,
    productName: row.productName,
    ktoContentId: row.ktoContentId,
    placeLabel: row.placeLabel,
    condition: row.condition,
    hidden: row.hidden,
    what: copy.what,
    detectedAt: row.detectedAt.toISOString(),
    modifiedTime: row.modifiedTime,
    // FR-MO-058 — 지문 비교값. 조건 2·3 은 지문 이력이 없어 둘 다 null 이다
    fingerprint: { from: row.hashFrom, to: row.hashTo },
    /*
     * FR-MO-006 — 판독 결과 기준 변화. 재검수가 돌아 지문이 두 번 이상 쌓인 콘텐츠에만
     * 있다. 없으면 빈 배열이고, 화면은 「판독 결과 비교 없음」으로 적어야 한다.
     * 비어 있는 것을 「바뀐 것 없음」으로 읽으면 안 된다.
     */
    readableChanges: readable,
    hasReadableDiff: row.normalizedBefore !== null && row.normalizedAfter !== null,
  };
}
