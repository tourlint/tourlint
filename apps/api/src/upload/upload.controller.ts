import {
  BadRequestException,
  Controller,
  Get,
  Post,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { createReadStream } from 'node:fs';
import { resolve } from 'node:path';
import { readSheetRows } from './read-sheet';
import { parseSchedule, type ParseResult } from './schedule-parse';

/**
 * 상품 등록 업로드 (F01 · UI-S2-001②·002·010·011).
 *
 * 파싱만 하고 **저장하지 않는다** — 결과는 화면에서 편집한 뒤 저장한다 (UI-S2-010).
 * `products/:id` 계열 라우트와 겹치지 않도록 `uploads` 아래에 둔다.
 */
interface UploadFile {
  buffer: Buffer;
  originalname: string;
  size: number;
}

const MAX_BYTES = 2 * 1024 * 1024;
const TEMPLATE_PATH = resolve(process.cwd(), '../../fixtures/excel/sample_3days_ok.xlsx');

@Controller('api/v1/uploads')
export class UploadController {
  /** 지정 양식 내려받기 (UI-S2-002) */
  @Get('template')
  template(@Res() res: Response): void {
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="tourlint_schedule_template.xlsx"');
    createReadStream(TEMPLATE_PATH).pipe(res);
  }

  /** 엑셀·CSV 업로드 파싱. 저장 전 편집용 결과만 돌려준다 (UI-S2-010·011) */
  @Post('schedule')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_BYTES } }))
  async schedule(@UploadedFile() file: UploadFile | undefined): Promise<ParseResult> {
    if (file === undefined) throw new BadRequestException('파일이 없습니다.');
    const name = file.originalname.toLowerCase();
    if (!name.endsWith('.xlsx') && !name.endsWith('.csv')) {
      throw new BadRequestException('지정 양식(.xlsx) 또는 CSV 파일만 업로드할 수 있습니다.');
    }
    const rows = await readSheetRows(file.buffer, file.originalname);
    return parseSchedule(rows);
  }
}
