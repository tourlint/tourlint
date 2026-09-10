import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import type { Pool } from 'pg';
import { CatalogService } from '../catalog/catalog.service';
import { DomainException } from '../common/domain.exception';
import { buildRunFingerprint, shortFingerprint } from '../engine/fingerprint';
import { createKtoClient } from '../external/kto';
import { DB_POOL } from '../persistence/db';
import { PgApiCallLogger } from '../persistence/api-call-log.repository';
import { AuditResultRepository, type StoredAuditRun } from '../persistence/audit-result.repository';
import { collectEvidence } from './report-evidence';
import {
  assembleReport, describeItineraryChanges,
  type ReportModel, type ReportPatch,
} from './report-model';
import { fontsAvailable, renderReport } from './report-render';
import { ReportRepository, type ProductRow } from './report.repository';
import { ReportStore, type ReportEntry } from './report-store';

/**
 * 검수 리포트 PDF (F11 · FR-PA-060 ~ 066).
 *
 * ## 만들기와 내려받기를 나눈 이유
 *
 * API 설계 4-7 이 `POST .../reports` → 201 + `reportId` 와 `GET /reports/{id}/download` 를
 * 규정한다. 그런데 DB 명세서 6-4 는 PDF 를 남기지 말라고 하고 `report` 테이블은 엔터티
 * 20종에 없다 — `reportId` 가 가리킬 행이 없다.
 *
 * 만드는 쪽에서 렌더까지 끝내고 결과를 **프로세스 메모리에** 짧게 들고, 내려받기는 그것을
 * 흘려보낸다. 디스크에도 DB 에도 남지 않고, 공사 재조회는 리포트당 한 번만 나간다.
 *
 * ## 가장 최근 실행만 만든다
 *
 * `audit_run` 에는 일정 스냅샷이 없다. 일정표(③)와 검수 제외 건수(FR-PA-064)는 지금의
 * `itinerary_item` 을 읽어야 나오는데, 과거 실행으로 리포트를 뽑으면 **그때 판정과 지금
 * 일정**이 한 문서에 섞인다. 섞인 문서를 내보내느니 거절한다.
 */
@Injectable()
export class ReportService {
  private readonly reports: ReportRepository;
  private readonly results: AuditResultRepository;
  private readonly store = new ReportStore();
  private readonly callLogger: PgApiCallLogger;

  constructor(
    @Inject(DB_POOL) pool: Pool,
    private readonly catalog: CatalogService,
  ) {
    this.reports = new ReportRepository(pool);
    this.results = new AuditResultRepository(pool);
    this.callLogger = new PgApiCallLogger(pool);
  }

  /** 만든다. 렌더까지 끝내고 `reportId` 를 준다 (201) */
  async create(auditRunId: number, accountId: number): Promise<{ reportId: string }> {
    const owned = await this.reports.runOwnedBy(auditRunId, accountId);
    // 남의 것도 없는 것도 똑같이 404 다 (PM-DA-002 · EX-SY-003)
    if (owned === null) throw notFound();

    const latest = await this.reports.latestRunIdOf(owned.productId);
    if (latest !== auditRunId) {
      throw new DomainException(
        HttpStatus.CONFLICT, 'REPORT_FAILED',
        '가장 최근 검수 결과로만 리포트를 만들 수 있습니다. 그 뒤로 일정이 바뀌었을 수 있어 '
        + '지금 다시 검수한 뒤 내려받아 주세요.',
      );
    }

    const model = await this.buildModel(owned.auditRunId, owned.productId);
    const pdf = await this.render(model);
    const reportId = this.store.put({
      accountId,
      auditRunId,
      fileName: fileNameOf(model),
      pdf,
    });
    return { reportId };
  }

  /**
   * 내려받는다. 소유자가 아니거나 수명이 지났으면 404 다.
   *
   * `reportId` 만으로 열리면 그게 공개 링크다 (PM-DA-007). 계정을 대조한다.
   */
  download(reportId: string, accountId: number): ReportEntry {
    const hit = this.store.get(reportId, accountId);
    if (hit === null) throw notFound();
    return hit;
  }

  /** 7섹션 모델. 공사 재조회가 여기서 나간다 */
  private async buildModel(auditRunId: number, productId: number): Promise<ReportModel> {
    const [run, productRow, items, fingerprints, patchRows] = await Promise.all([
      this.results.findById(auditRunId),
      this.reports.product(productId),
      this.reports.items(productId),
      this.reports.fingerprints(auditRunId),
      this.reports.patches(productId),
    ]);
    if (run === null || productRow === null) throw notFound();

    const [evidence, region] = await Promise.all([
      collectEvidence({ kto: createKtoClient(this.callLogger), fingerprints }),
      this.regionName(productRow),
    ]);

    return assembleReport({
      run,
      product: {
        name: productRow.name,
        region,
        startDate: productRow.startDate,
        nights: productRow.nights,
        dayCount: productRow.nights + 1,
        headCount: productRow.headCount,
        transport: productRow.transport,
        releasedAt: productRow.releasedAt,
      },
      items,
      patches: await this.toPatchHistory(patchRows),
      evidence,
      dataFingerprint: runFingerprintOf(fingerprints),
      // 원문이 YYYYMMDDHHmmss 라 사전순 최대가 곧 최신이다 (DR-PR-008)
      ktoModifiedAt: fingerprints.reduce<string | null>(
        (latest, f) => (latest === null || f.ktoModifiedTime > latest ? f.ktoModifiedTime : latest),
        null,
      ),
      generatedAt: new Date(),
    });
  }

  /** 지역 코드를 이름으로. 실패하면 코드를 그대로 둔다 — 리포트를 못 내보낼 이유가 아니다 */
  private async regionName(row: ProductRow): Promise<string> {
    try {
      const regn = (await this.catalog.regions()).find((c) => c.code === row.ldongRegnCd)?.name;
      if (row.ldongSignguCd === null) return regn ?? row.ldongRegnCd;
      const signgu = (await this.catalog.signgus(row.ldongRegnCd))
        .find((c) => c.code === row.ldongSignguCd)?.name;
      return [regn ?? row.ldongRegnCd, signgu ?? row.ldongSignguCd].join(' ');
    } catch {
      return [row.ldongRegnCd, row.ldongSignguCd].filter((s) => s !== null).join(' ');
    }
  }

  /**
   * 수정 이력 (⑤ · FR-PA-043).
   *
   * 점수는 저장값이 아니라 **조회 시점 재계산값**을 쓴다 — 전후 비교 화면이 그 값을 보여주므로
   * 저장값을 쓰면 같은 패치가 화면과 PDF 에서 다른 점수로 보인다 (FR-AU-046).
   */
  private async toPatchHistory(
    rows: Awaited<ReturnType<ReportRepository['patches']>>,
  ): Promise<readonly ReportPatch[]> {
    return Promise.all(rows.map(async (r) => {
      const [before, after] = await Promise.all([
        this.findRun(r.beforeAuditRunId),
        this.findRun(r.afterAuditRunId),
      ]);
      return {
        appliedAt: r.appliedAt.toISOString(),
        reverted: r.revertedAt !== null,
        beforeScore: before?.current.score ?? null,
        afterScore: after?.current.score ?? null,
        changes: describeItineraryChanges(r.before.items, r.after.items),
      };
    }));
  }

  private async findRun(id: number | null): Promise<StoredAuditRun | null> {
    return id === null ? null : this.results.findById(id);
  }

  /**
   * 렌더. 여기서 실패하면 `REPORT_FAILED` 로 거절하고 재시도를 유도한다 (EX-AU-011).
   *
   * **검수 결과 자체는 영향받지 않는다** — 리포트가 안 나온 것과 검수가 잘못된 것은 다르다.
   */
  private async render(model: ReportModel): Promise<Buffer> {
    if (!fontsAvailable()) throw reportFailed();
    try {
      return await renderReport(model);
    } catch {
      // 원인을 메시지에 담지 않는다 — 렌더 예외에 공사 원문이 섞여 있을 수 있다 (DB 명세서 6-4)
      throw reportFailed();
    }
  }
}

/** 존재 여부를 노출하지 않는다 (EX-SY-003 · PM-DA-003) */
function notFound(): DomainException {
  return new DomainException(
    HttpStatus.NOT_FOUND, 'NOT_FOUND', '요청하신 리포트를 찾을 수 없습니다.',
  );
}

function reportFailed(): DomainException {
  return new DomainException(
    HttpStatus.INTERNAL_SERVER_ERROR, 'REPORT_FAILED',
    '리포트를 만들지 못했습니다. 잠시 후 다시 시도해 주세요.',
  );
}

/**
 * 대표 지문 앞 8자리 (DR-FP-008 · FR-PA-062).
 *
 * 지문이 없는 실행(대상 0곳)은 `null` 이다. 없는 것을 빈 문자열로 적으면 근거가 있는
 * 것처럼 읽힌다.
 */
export function runFingerprintOf(
  fingerprints: readonly { readonly ktoContentId: string; readonly fieldHash: string }[],
): string | null {
  if (fingerprints.length === 0) return null;
  return shortFingerprint(buildRunFingerprint(
    fingerprints.map((f) => ({ ktoContentId: f.ktoContentId, fieldHash: f.fieldHash })),
  ));
}

/** 파일명. 공사 원문(관광지명)이 아니라 사용자가 지은 상품명이라 담아도 된다 */
function fileNameOf(model: ReportModel): string {
  const safe = model.product.name.replace(/[^\p{L}\p{N}._-]+/gu, '_').slice(0, 60);
  return `검수리포트_${safe}_${model.provenance.fetchedAt.slice(0, 10)}.pdf`;
}
