import { readFileSync } from 'node:fs';
import ExcelJS from 'exceljs';
import type { Response } from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DomainException } from '../common/domain.exception';
import { contentLooksLike, mimeClearlyOther, sheetKindOf } from './file-check';
import { readSheetRows } from './read-sheet';
import { parseSchedule } from './schedule-parse';
import { TEMPLATE_PATH, UploadController } from './upload.controller';

/** `send` 로 받은 본문을 잡아 두는 가짜 응답 */
function fakeResponse(): { res: Response; sent: () => Buffer | undefined; headers: Map<string, string> } {
  let body: Buffer | undefined;
  const headers = new Map<string, string>();
  const res = {
    setHeader: (k: string, v: string) => { headers.set(k, v); },
    send: (b: Buffer) => { body = b; },
  } as unknown as Response;
  return { res, sent: () => body, headers };
}

describe('지정 양식 내려받기 (UI-S2-002 · #578)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('🔴 띄운 자리(cwd)가 달라도 양식을 찾는다', async () => {
    /*
     * 운영은 cwd 가 `/app` 이다. 경로를 cwd 기준으로 잡았을 때 `/fixtures/...` 가 되어
     * ENOENT 가 났고, 처리 안 된 스트림 오류로 API 프로세스가 재시작했다.
     */
    vi.spyOn(process, 'cwd').mockReturnValue('/app');
    vi.resetModules();
    const { UploadController } = await import('./upload.controller');
    const controller = new UploadController({} as never);

    const { res, sent, headers } = fakeResponse();
    await controller.template(res);

    const body = sent();
    expect(body).toBeInstanceOf(Buffer);
    expect(headers.get('Content-Disposition')).toContain('.xlsx');

    // 내려준 양식을 그대로 올리면 오류 없이 읽혀야 한다
    const parsed = parseSchedule(await readSheetRows(body as Buffer, 'template.xlsx'));
    expect(parsed.rejected).toBeUndefined();
    expect(parsed.errors).toEqual([]);
    expect(parsed.items.length).toBeGreaterThan(0);
  });
});

describe('올린 파일의 형식 (NF-SC-006 · EX-IN-011 · #868)', () => {
  const controller = new UploadController({} as never);
  const upload = (originalname: string, buffer: Buffer, mimetype?: string) =>
    controller.schedule({ originalname, buffer, size: buffer.length, ...(mimetype === undefined ? {} : { mimetype }) });
  const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  const template = readFileSync(TEMPLATE_PATH);

  /** 사유 코드로 거절됐는지. 500 으로 새면 DomainException 이 아니다 */
  async function rejection(run: Promise<unknown>): Promise<{ status: number; reasonCode: string; message: string }> {
    const e = await run.then(() => null, (x: unknown) => x);
    expect(e, '거절돼야 한다').toBeInstanceOf(DomainException);
    const d = e as DomainException;
    return { status: d.getStatus(), reasonCode: d.reasonCode, message: d.message };
  }

  it('🔴 이름만 .xlsx 인 PDF 는 500 이 아니라 400 UPLOAD_FORMAT_INVALID 다', async () => {
    const r = await rejection(upload('일정.xlsx', Buffer.from('%PDF-1.4\n1 0 obj\n'), XLSX_MIME));
    expect(r).toMatchObject({ status: 400, reasonCode: 'UPLOAD_FORMAT_INVALID' });
    expect(r.message).toContain('이름만 바꾼');
  });

  it('🔴 ZIP(PK) 으로 시작하지 않으면 엑셀 파서에 넘기지도 않는다', async () => {
    const parser = vi.spyOn(ExcelJS.Workbook.prototype, 'xlsx', 'get');
    try {
      await rejection(upload('일정.xlsx', Buffer.from('%PDF-1.4'), XLSX_MIME));
      expect(parser).not.toHaveBeenCalled();
    } finally {
      parser.mockRestore();
    }
  });

  it('🔴 ZIP 이지만 엑셀이 아닌 파일도 파서 오류를 500 으로 흘리지 않는다', async () => {
    // `PK` 로 시작해 첫 검사는 지나고, 엑셀 파서가 던진다
    const r = await rejection(upload('일정.xlsx', Buffer.from('PK\x03\x04 이건 엑셀이 아니다')));
    expect(r).toMatchObject({ status: 400, reasonCode: 'UPLOAD_FORMAT_INVALID' });
  });

  it('🔴 MIME 이 이미지 · PDF 면 거절한다', async () => {
    const csv = Buffer.from('일차,시작시간,종료시간,장소명,유형\n1,10:00,11:00,오죽헌,관광\n');
    expect(await rejection(upload('일정.csv', csv, 'image/png'))).toMatchObject({ reasonCode: 'UPLOAD_FORMAT_INVALID' });
    expect(await rejection(upload('일정.csv', csv, 'application/pdf'))).toMatchObject({ reasonCode: 'UPLOAD_FORMAT_INVALID' });
  });

  it('🔴 NUL 이 든 CSV(UTF-16 저장 등)는 글자로 읽을 수 없다고 거절한다', async () => {
    const utf16 = Buffer.from('\ufeff일차,시작시간\n', 'utf16le');
    expect(await rejection(upload('일정.csv', utf16, 'text/csv'))).toMatchObject({ reasonCode: 'UPLOAD_FORMAT_INVALID' });
  });

  it('확장자가 다르면 사유 코드를 싣고 거절한다', async () => {
    expect(await rejection(upload('일정.pdf', Buffer.from('%PDF')))).toMatchObject({ status: 400, reasonCode: 'UPLOAD_FORMAT_INVALID' });
  });

  it('🔴 지정 양식은 브라우저가 어떤 MIME 을 붙여도 읽힌다 — 가이드 4단계 업로드', async () => {
    // 허용 목록으로 좁히면 브라우저 · 운영체제마다 다른 값에서 멀쩡한 양식이 막힌다
    for (const mime of [XLSX_MIME, 'application/octet-stream', 'application/zip', '', undefined]) {
      const parsed = await upload('tourlint_schedule_template.xlsx', template, mime);
      expect(parsed.rejected, String(mime)).toBeUndefined();
      expect(parsed.items.length, String(mime)).toBeGreaterThan(0);
    }
    const csv = Buffer.from('일차,시작시간,종료시간,장소명,유형\n1,10:00,11:00,오죽헌,관광\n');
    for (const mime of ['text/csv', 'application/vnd.ms-excel', 'text/plain', 'application/octet-stream']) {
      expect((await upload('일정.csv', csv, mime)).items, mime).toHaveLength(1);
    }
  });

  it('형식 판정 도우미', () => {
    expect(sheetKindOf('A.XLSX')).toBe('xlsx');
    expect(sheetKindOf('a.csv')).toBe('csv');
    expect(sheetKindOf('a.xls')).toBeNull();
    expect(mimeClearlyOther('image/jpeg')).toBe(true);
    expect(mimeClearlyOther('video/mp4')).toBe(true);
    expect(mimeClearlyOther('text/csv')).toBe(false);
    expect(mimeClearlyOther(undefined)).toBe(false);
    expect(contentLooksLike('xlsx', Buffer.from('P'))).toBe(false);
    expect(contentLooksLike('xlsx', Buffer.alloc(0))).toBe(false);
    expect(contentLooksLike('csv', Buffer.alloc(0))).toBe(true);
  });
});
