import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Post,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { createReadStream } from 'node:fs';
import { resolve } from 'node:path';
import { NlService } from './nl.service';
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

// 업로드 상한 (EX-IN-003 · NF-CP-005). 초과하면 파싱 전에 UPLOAD_LIMIT_EXCEEDED 로 거부한다.
const MAX_BYTES = 5 * 1024 * 1024;
// multer 메모리 안전망 — 상한보다 크게 둬서, 상한 초과는 우리가 안내 문구와 함께 거부하고
// 정말 큰 파일만 버퍼링 자체를 막는다.
const HARD_CAP_BYTES = 20 * 1024 * 1024;
const TEMPLATE_PATH = resolve(process.cwd(), '../../fixtures/excel/sample_3days_ok.xlsx');

@ApiTags('실엔진')
@Controller('api/v1/uploads')
export class UploadController {
  constructor(private readonly nl: NlService) {}

  /** 지정 양식 내려받기 (UI-S2-002) */
  @Get('template')
  template(@Res() res: Response): void {
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="tourlint_schedule_template.xlsx"');
    createReadStream(TEMPLATE_PATH).pipe(res);
  }

  /** 엑셀·CSV 업로드 파싱. 저장 전 편집용 결과만 돌려준다 (UI-S2-010·011) */
  @Post('schedule')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: HARD_CAP_BYTES } }))
  async schedule(@UploadedFile() file: UploadFile | undefined): Promise<ParseResult> {
    if (file === undefined) throw new BadRequestException('파일이 없습니다.');
    const name = file.originalname.toLowerCase();
    if (!name.endsWith('.xlsx') && !name.endsWith('.csv')) {
      throw new BadRequestException('지정 양식(.xlsx) 또는 CSV 파일만 업로드할 수 있습니다.');
    }
    // 파싱 전에 크기부터 거른다 (EX-IN-003). 행·항목 상한은 parseSchedule 이 본다.
    if (file.size > MAX_BYTES) {
      const mb = Math.round((file.size / 1024 / 1024) * 10) / 10;
      return {
        nights: 0,
        items: [],
        errors: [],
        rejected: {
          code: 'UPLOAD_LIMIT_EXCEEDED',
          message: `파일이 5MB 를 넘습니다(약 ${String(mb)}MB). 5MB 이하로 줄여 주세요.`,
        },
      };
    }
    const rows = await readSheetRows(file.buffer, file.originalname);
    return parseSchedule(rows);
  }

  /**
   * 자연어 붙여넣기 정형화 (UI-S2-001③ · FR-IN-003).
   *
   * 업로드와 같은 모양을 돌려준다 — 화면이 같은 편집 경로를 쓴다 (UI-S2-010).
   * 여기서도 **저장하지 않는다.**
   */
  @Post('schedule-text')
  async scheduleText(@Body() body: { text?: unknown }): Promise<ParseResult> {
    if (typeof body.text !== 'string') {
      throw new BadRequestException('일정 텍스트를 붙여넣어 주세요.');
    }
    return this.nl.structure(body.text);
  }
}
