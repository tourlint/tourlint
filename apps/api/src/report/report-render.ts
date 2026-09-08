import { existsSync } from 'node:fs';
import { join } from 'node:path';
import PDFDocument from 'pdfkit';
import { TRANSPORT_LABEL, type Transport } from '@tourlint/shared';
import type { ContentEvidence, ReportFinding, ReportModel } from './report-model';

/**
 * 7섹션 PDF 렌더링 (FR-PA-066 서버 사이드 · UI-S6-008 A4 세로).
 *
 * 브라우저를 쓰지 않는다. Railway 가 Nixpacks 자동 감지로 빌드하는데 Chromium 을 넣으려면
 * 빌드 설정과 시스템 라이브러리를 새로 얹어야 하고, 콜드 기동이 NF-PF-006(p95 10초)에
 * 그대로 얹힌다. pdfkit 은 순수 JS 라 배포에 손댈 것이 없다.
 *
 * ## 이미지가 하나도 없다
 *
 * 관광지 이미지는 **URL 문자열로만** 싣는다 (FR-PA-063). 공사 공식 CI · BI 로고도 쓰지
 * 않는다 (FR-PA-065). 그래서 이 파일에는 `doc.image()` 호출이 없고, 없어야 한다.
 *
 * ## 페이지가 잘리지 않게
 *
 * 표의 행을 그리기 전에 높이를 재서 남은 공간에 안 들어가면 페이지를 넘긴다. pdfkit 은
 * 알아서 넘겨 주지만 그 경우 행이 두 페이지에 걸쳐 쪼개진다.
 */

const FONT_DIR = join(__dirname, '../../assets/fonts');
export const FONT_REGULAR = join(FONT_DIR, 'GothicA1-Regular.ttf');
export const FONT_BOLD = join(FONT_DIR, 'GothicA1-Bold.ttf');

/**
 * 나눔고딕이 아닌 이유 — Google Fonts 판 나눔고딕에 `ⓒ` (U+24D2) 글리프가 없다.
 * FR-PA-062 가 `출처: ⓒ한국관광공사` 를 문자 그대로 요구하므로 쓸 수 없었다.
 * GothicA1 은 OFL 이고 22,709 글리프로 `ⓒ` 와 원문자를 모두 담는다.
 */
export function fontsAvailable(): boolean {
  return existsSync(FONT_REGULAR) && existsSync(FONT_BOLD);
}

/**
 * 그 글자를 실제로 그릴 수 있는지 본다. 못 그리는 것만 돌려준다.
 *
 * 없는 글리프는 예외가 아니라 **빈 네모**로 조용히 나간다. 출처 표기가 `출처: 한국관광공사`
 * 로 보이는 사고를 테스트로 잡으려면 이 확인이 필요하다.
 *
 * pdfkit 이 내부에 들고 있는 fontkit 폰트를 들여다본다 — 공개 API 에 대응물이 없다.
 */
export function missingGlyphs(sample: string, fontPath: string = FONT_REGULAR): readonly string[] {
  const doc = new PDFDocument();
  doc.registerFont('probe', fontPath);
  doc.font('probe');
  const font = (doc as unknown as {
    _font?: { font?: { hasGlyphForCodePoint?: (cp: number) => boolean } };
  })._font?.font;
  if (typeof font?.hasGlyphForCodePoint !== 'function') {
    throw new Error('pdfkit 내부 폰트를 읽지 못했다 — 글리프 확인 경로가 바뀌었다');
  }
  const has = font.hasGlyphForCodePoint.bind(font);
  return [...new Set([...sample])].filter((ch) => ch !== ' ' && !has(ch.codePointAt(0) as number));
}

const MARGIN = 48;
const BODY = 9;
const SMALL = 7.5;
const LINE = 1.35;
const GRAY = '#5b6470';
const RULE = '#d5d9df';
const HEAD_BG = '#f2f4f7';

const SEVERITY_LABEL: Readonly<Record<string, string>> = {
  BLOCKER: '차단', ERROR: '오류', WARNING: '주의', UNVERIFIED: '확인 불가',
};
const ITEM_TYPE_LABEL: Readonly<Record<string, string>> = {
  SIGHT: '관광', MEAL: '식사', LODGING: '숙박', REST: '휴식', MOVE: '이동', FREE: '자유',
};

interface Column {
  readonly header: string;
  readonly width: number;
  readonly align?: 'left' | 'right' | 'center';
}

/** 리포트 한 부를 만든다. 파일로 쓰지 않고 버퍼로 돌려준다 (DB 명세서 6-4) */
export async function renderReport(model: ReportModel): Promise<Buffer> {
  const doc = new PDFDocument({
    size: 'A4',
    margins: { top: MARGIN, bottom: MARGIN + 18, left: MARGIN, right: MARGIN },
    bufferPages: true,
    info: {
      Title: `검수 리포트 — ${model.product.name}`,
      Creator: 'TourLint',
      /*
       * 렌더 시각이 아니라 **모델이 들고 있는 생성 시각**을 넣는다. 안 넣으면 pdfkit 이
       * `new Date()` 를 박아서 같은 입력이 매번 다른 바이트를 낸다 — 산출물이 입력만으로
       * 정해지지 않으면 무엇이 달라졌는지 비교할 수 없다.
       */
      CreationDate: new Date(model.provenance.generatedAt),
    },
  });
  doc.registerFont('body', FONT_REGULAR);
  doc.registerFont('bold', FONT_BOLD);
  doc.font('body').fontSize(BODY).lineGap(BODY * (LINE - 1));

  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  drawTitle(doc, model);
  drawProduct(doc, model);
  drawSummary(doc, model);
  drawItinerary(doc, model);
  drawFindings(doc, model);
  drawPatchHistory(doc, model);
  drawUnverified(doc, model);
  drawProvenance(doc, model);
  drawFooters(doc, model);

  doc.end();
  return done;
}

type Doc = PDFKit.PDFDocument;

const contentWidth = (doc: Doc): number => doc.page.width - MARGIN * 2;
const bottomLimit = (doc: Doc): number => doc.page.height - MARGIN - 18;

/** 남은 높이가 모자라면 페이지를 넘긴다. 넘겼으면 참 */
function ensure(doc: Doc, needed: number): boolean {
  if (doc.y + needed <= bottomLimit(doc)) return false;
  doc.addPage();
  return true;
}

function heading(doc: Doc, index: number, title: string): void {
  ensure(doc, 46);
  doc.moveDown(0.8);
  doc.font('bold').fontSize(12).fillColor('#111827')
    .text(`${index}. ${title}`, MARGIN, doc.y, { width: contentWidth(doc) });
  doc.moveDown(0.25);
  const y = doc.y;
  doc.moveTo(MARGIN, y).lineTo(doc.page.width - MARGIN, y).lineWidth(0.8).strokeColor(RULE).stroke();
  doc.moveDown(0.5);
  doc.font('body').fontSize(BODY).fillColor('#111827');
}

function paragraph(doc: Doc, text: string, opts: { color?: string; size?: number } = {}): void {
  const size = opts.size ?? BODY;
  doc.font('body').fontSize(size).fillColor(opts.color ?? '#111827');
  const h = doc.heightOfString(text, { width: contentWidth(doc) });
  ensure(doc, h);
  doc.text(text, MARGIN, doc.y, { width: contentWidth(doc) });
  doc.fillColor('#111827').fontSize(BODY);
}

/** 라벨 · 값 두 칸짜리 정의 목록 */
function definitions(doc: Doc, rows: readonly (readonly [string, string])[]): void {
  const labelW = 96;
  const valueW = contentWidth(doc) - labelW;
  for (const [label, value] of rows) {
    doc.fontSize(BODY);
    const h = Math.max(
      doc.font('body').heightOfString(value, { width: valueW }),
      doc.font('bold').heightOfString(label, { width: labelW }),
    );
    ensure(doc, h + 4);
    const y = doc.y;
    doc.font('bold').fillColor(GRAY).text(label, MARGIN, y, { width: labelW });
    doc.font('body').fillColor('#111827').text(value, MARGIN + labelW, y, { width: valueW });
    doc.y = y + h + 4;
  }
}

/**
 * 표를 그린다. 행 단위로 높이를 재서 페이지를 넘기고, 넘긴 뒤에는 머리행을 다시 그린다.
 *
 * 머리행을 다시 안 그리면 둘째 페이지부터 어느 칸이 무엇인지 알 수 없다.
 */
function table(doc: Doc, cols: readonly Column[], rows: readonly (readonly string[])[]): void {
  const PAD = 4;
  const drawHeader = (): void => {
    const h = 16;
    ensure(doc, h + 12);
    const y = doc.y;
    doc.rect(MARGIN, y, contentWidth(doc), h).fill(HEAD_BG);
    let x = MARGIN;
    doc.font('bold').fontSize(SMALL).fillColor(GRAY);
    for (const c of cols) {
      doc.text(c.header, x + PAD, y + 4.5, { width: c.width - PAD * 2, align: c.align ?? 'left' });
      x += c.width;
    }
    doc.y = y + h;
    doc.font('body').fontSize(SMALL).fillColor('#111827');
  };

  drawHeader();
  for (const row of rows) {
    doc.font('body').fontSize(SMALL);
    const cellH = cols.map((c, i) =>
      doc.heightOfString(row[i] ?? '', { width: c.width - PAD * 2 }));
    const h = Math.max(...cellH, 10) + PAD * 2;
    if (ensure(doc, h)) drawHeader();

    const y = doc.y;
    let x = MARGIN;
    doc.fillColor('#111827');
    for (const [i, c] of cols.entries()) {
      doc.text(row[i] ?? '', x + PAD, y + PAD, { width: c.width - PAD * 2, align: c.align ?? 'left' });
      x += c.width;
    }
    doc.y = y + h;
    doc.moveTo(MARGIN, doc.y).lineTo(doc.page.width - MARGIN, doc.y)
      .lineWidth(0.5).strokeColor(RULE).stroke();
  }
  doc.font('body').fontSize(BODY).fillColor('#111827');
  doc.moveDown(0.4);
}

function drawTitle(doc: Doc, m: ReportModel): void {
  doc.font('bold').fontSize(19).fillColor('#111827')
    .text('관광상품 출시 검수 리포트', MARGIN, doc.y, { width: contentWidth(doc) });
  doc.moveDown(0.3);
  doc.font('body').fontSize(BODY).fillColor(GRAY)
    .text(`${m.product.name}   ·   검수 실행 #${m.auditRunId}`, { width: contentWidth(doc) });
  doc.moveDown(0.2);
  doc.fontSize(SMALL).text(`생성 ${stamp(m.provenance.generatedAt)}`, { width: contentWidth(doc) });
  doc.fillColor('#111827').fontSize(BODY);
  doc.moveDown(0.4);
}

function drawProduct(doc: Doc, m: ReportModel): void {
  heading(doc, 1, '상품 개요');
  const p = m.product;
  definitions(doc, [
    ['상품명', p.name],
    ['지역', p.region],
    ['일정', `${p.startDate} 출발 · ${p.nights}박 ${p.dayCount}일`],
    ['인원', p.headCount === null ? '미지정' : `${p.headCount}명`],
    // 저장 값은 enum 이고 사람에게는 한글로 보인다 (공용 표기 · UI-CM-004)
    ['이동수단', TRANSPORT_LABEL[p.transport as Transport] ?? p.transport],
    ['출시 상태', p.releasedAt === null ? '미출시' : `출시 ${stamp(p.releasedAt)}`],
  ]);
}

function drawSummary(doc: Doc, m: ReportModel): void {
  heading(doc, 2, '검수 요약');
  const s = m.summary;

  const score = s.score === null
    ? '산출하지 않음 (부분 검수)'
    : `${s.score}점 / 100점`;
  definitions(doc, [
    ['출시 준비도', score],
    ['산출식', s.breakdown],
    ['출시 가능 여부', s.releasable ? '출시 가능' : `출시 불가 — ${s.releaseBlockedReason ?? ''}`],
  ]);
  doc.moveDown(0.3);

  table(doc, [
    { header: '차단', width: 82, align: 'right' },
    { header: '오류', width: 82, align: 'right' },
    { header: '주의', width: 82, align: 'right' },
    { header: '확인 불가', width: 82, align: 'right' },
    { header: '검수 대상', width: 85, align: 'right' },
    { header: '조회 실패', width: 86, align: 'right' },
  ], [[
    `${s.counts.BLOCKER}건`, `${s.counts.ERROR}건`, `${s.counts.WARNING}건`,
    `${s.counts.UNVERIFIED}건`, `${s.targetCount}곳`, `${s.failedCount}곳`,
  ]]);

  // FR-PA-064 · UI-S6-004 — 두 건수를 반드시 명시한다
  paragraph(doc,
    `무시된 항목 ${s.dismissedCount}건 · 검수 제외 항목 ${s.excludedItemCount}건 · `
    + `직접 확인 필요 ${s.needsConfirmationCount}건`);
  if (s.isPartial) {
    paragraph(doc,
      '조회 실패가 절반을 넘어 부분 검수로 처리했습니다. 출시 준비도는 산출하지 않습니다.',
      { color: GRAY, size: SMALL });
  }
}

function drawItinerary(doc: Doc, m: ReportModel): void {
  heading(doc, 3, '일정표 (수정 반영본)');
  if (m.itinerary.length === 0) {
    paragraph(doc, '일정 항목이 없습니다.', { color: GRAY });
    return;
  }
  for (const day of m.itinerary) {
    ensure(doc, 40);
    doc.font('bold').fontSize(BODY).fillColor('#111827')
      .text(`${day.dayNo}일차`, MARGIN, doc.y, { width: contentWidth(doc) });
    doc.moveDown(0.2);
    table(doc, [
      { header: '순서', width: 36, align: 'right' },
      { header: '시각', width: 84 },
      { header: '장소', width: 231 },
      { header: '유형', width: 52 },
      { header: '상태', width: 96 },
    ], day.items.map((it) => [
      String(it.seq),
      it.end === null ? it.start : `${it.start} ~ ${it.end}`,
      it.place,
      ITEM_TYPE_LABEL[it.itemType] ?? it.itemType,
      it.excluded ? '검수 제외' : it.matchStatus === 'PENDING' ? '미확정' : '',
    ]));
  }
}

function drawFindings(doc: Doc, m: ReportModel): void {
  heading(doc, 4, '판정 내역 및 공사 원문 근거');
  if (m.findings.length === 0) {
    paragraph(doc, '감점이 걸린 판정이 없습니다.', { color: GRAY });
    return;
  }
  for (const f of m.findings) drawFindingBlock(doc, f);
}

function drawUnverified(doc: Doc, m: ReportModel): void {
  heading(doc, 6, '직접 확인 필요 목록');
  if (m.unverified.length === 0) {
    paragraph(doc, '직접 확인이 필요한 항목이 없습니다.', { color: GRAY });
    return;
  }
  paragraph(doc,
    '아래 항목은 공사 데이터만으로 판정할 수 없어 운영기관에 직접 확인해야 합니다. '
    + '정보가 없다는 이유로 정상으로 판정하지 않습니다.',
    { color: GRAY, size: SMALL });
  doc.moveDown(0.3);
  for (const f of m.unverified) drawFindingBlock(doc, f);
}

/** 판정 한 건 + 그 근거. 제목과 근거가 다른 페이지로 갈리지 않게 최소 높이를 잡고 시작한다 */
function drawFindingBlock(doc: Doc, f: ReportFinding): void {
  ensure(doc, 54);
  const badge = SEVERITY_LABEL[f.severity] ?? f.severity;
  const marks = [
    f.dismissed ? '무시됨' : '',
    f.confirmed ? '확인함' : '',
    f.excludedFromScore ? '감점 없음' : '',
  ].filter((s) => s !== '');

  doc.font('bold').fontSize(SMALL).fillColor(GRAY);
  doc.text(
    `[${badge}] ${f.ruleCode}${f.targetPlace === null ? '' : ` · ${f.targetPlace}`}`
    + (marks.length === 0 ? '' : `   (${marks.join(' · ')})`),
    MARGIN, doc.y, { width: contentWidth(doc) },
  );
  doc.moveDown(0.15);
  paragraph(doc, f.message);
  drawEvidence(doc, f.evidence);
  doc.moveDown(0.45);
}

/**
 * 공사 원문 근거 (UI-S6-002).
 *
 * 비표출 콘텐츠는 명칭 · 주소 · 이미지를 싣지 않는다 (PM-NG-009). 조회에 실패했으면
 * 실패했다고 적는다 — 근거 없는 자리를 비워 두면 근거가 있는 것처럼 읽힌다.
 */
function drawEvidence(doc: Doc, e: ContentEvidence | null): void {
  if (e === null) return;
  doc.moveDown(0.15);

  if (e.hidden) {
    paragraph(doc, '공사에서 표출이 중단된 콘텐츠입니다. 명칭 · 주소 · 이미지를 표시하지 않습니다.',
      { color: GRAY, size: SMALL });
    return;
  }
  if (e.unavailableReason !== null) {
    paragraph(doc, `공사 원문을 조회하지 못했습니다 (${e.unavailableReason}).`,
      { color: GRAY, size: SMALL });
    return;
  }

  const rows: (readonly string[])[] = e.fields.map((f) => [f.name, f.value === '' ? '(값 없음)' : f.value]);
  if (e.ktoModifiedTime !== null) rows.push(['modifiedtime', e.ktoModifiedTime]);
  if (rows.length > 0) {
    table(doc, [
      { header: '판정 필드', width: 132 },
      { header: '공사 원문', width: 367 },
    ], rows);
  }
  // FR-PA-063 — 이미지를 넣지 않고 URL 로만 적는다
  const links = [
    e.imageUrl === null ? '' : `이미지 ${e.imageUrl}`,
    e.homepageUrl === null ? '' : `홈페이지 ${e.homepageUrl}`,
  ].filter((s) => s !== '');
  if (links.length > 0) paragraph(doc, links.join('   '), { color: GRAY, size: SMALL });
}

function drawPatchHistory(doc: Doc, m: ReportModel): void {
  heading(doc, 5, '수정 이력');
  if (m.patchHistory.length === 0) {
    paragraph(doc, '반영한 수정안이 없습니다.', { color: GRAY });
    return;
  }
  for (const p of m.patchHistory) {
    ensure(doc, 44);
    const score = `${p.beforeScore ?? '—'}점 → ${p.afterScore ?? '—'}점`;
    doc.font('bold').fontSize(SMALL).fillColor(GRAY).text(
      `${stamp(p.appliedAt)}   ${score}${p.reverted ? '   (되돌림)' : ''}`,
      MARGIN, doc.y, { width: contentWidth(doc) },
    );
    doc.moveDown(0.15);
    doc.font('body').fontSize(SMALL).fillColor('#111827');
    for (const c of p.changes) {
      const h = doc.heightOfString(c, { width: contentWidth(doc) - 10 });
      ensure(doc, h);
      doc.text(`· ${c}`, MARGIN + 8, doc.y, { width: contentWidth(doc) - 10 });
    }
    doc.fontSize(BODY);
    doc.moveDown(0.4);
  }
}

function drawProvenance(doc: Doc, m: ReportModel): void {
  heading(doc, 7, '데이터 출처');
  const p = m.provenance;
  definitions(doc, [
    ['조회 시각', stamp(p.fetchedAt)],
    ['대상 콘텐츠', `${p.targetContentCount}곳`],
    ['데이터 지문', p.dataFingerprint ?? '산출하지 않음'],
    ['규칙셋 버전', p.rulesetVersion],
    ['데이터 최종 수정일', ktoStamp(p.ktoModifiedAt)],
  ]);
  doc.moveDown(0.2);
  paragraph(doc, p.delayNotice, { color: GRAY, size: SMALL });
  doc.moveDown(0.2);
  doc.font('bold').fontSize(SMALL).fillColor('#111827')
    .text(p.source, MARGIN, doc.y, { width: contentWidth(doc) });
}

/**
 * 모든 페이지에 출처와 쪽 번호를 넣는다 (FR-CM-009 · UI-S6-005).
 *
 * 본문을 다 그린 뒤에 돈다 — 전체 쪽수는 마지막에야 안다.
 */
function drawFooters(doc: Doc, m: ReportModel): void {
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i += 1) {
    doc.switchToPage(i);
    /*
     * 꼬리말은 하단 여백 자리에 그린다. 그대로 쓰면 pdfkit 이 "본문이 넘쳤다"고 보고
     * 페이지를 새로 만들고, 그 페이지에 또 꼬리말을 그리느라 쪽수가 곱절이 된다 —
     * 실제로 2쪽짜리가 6쪽으로 나갔다. 그리는 동안만 여백을 0 으로 둔다.
     */
    const saved = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    const y = doc.page.height - MARGIN - 6;
    doc.font('body').fontSize(SMALL).fillColor(GRAY);
    doc.text(m.provenance.source, MARGIN, y, { width: contentWidth(doc) / 2, lineBreak: false });
    doc.text(`${i - range.start + 1} / ${range.count}`,
      MARGIN + contentWidth(doc) / 2, y,
      { width: contentWidth(doc) / 2, align: 'right', lineBreak: false });
    doc.page.margins.bottom = saved;
  }
}

/** ISO 를 화면 표기로. 시간대는 서버 기준을 그대로 쓴다 */
/** 공사 원문 `YYYYMMDDHHmmss` 를 날짜까지만 읽는다. 변환하지 않고 잘라서 보인다 */
function ktoStamp(raw: string | null): string {
  if (raw === null || raw.length < 8) return '알 수 없음';
  return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
}

function stamp(iso: string): string {
  return iso.replace('T', ' ').slice(0, 16);
}
