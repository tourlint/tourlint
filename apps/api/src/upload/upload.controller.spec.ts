import type { Response } from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readSheetRows } from './read-sheet';
import { parseSchedule } from './schedule-parse';

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
