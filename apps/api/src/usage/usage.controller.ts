import { BadRequestException, Controller, Get, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { CALL_PROVIDER, type CallProvider } from '../external/api-call-log';
import { UsageService } from './usage.service';

/**
 * 호출 예산 · 활용 증빙 (F15).
 *
 * mock 을 대체한다. 숫자가 고정값이면 화면이 예산 경계(80% · 100%)를 실제로 밟아 볼 수
 * 없고, 증빙으로도 쓸 수 없다 (FR-OP-001 · DR-LC-004).
 */
@ApiTags('실엔진')
@Controller('api/v1/usage')
export class UsageController {
  constructor(private readonly service: UsageService) {}

  /** 오늘 소진 상태. 위젯이 2분마다 폴링한다 (FR-OP-005) */
  @Get('budget')
  async budget(): Promise<Record<string, unknown>> {
    return { ...(await this.service.budget()) };
  }

  /**
   * 일자별 · 오퍼레이션별 집계. 기본 구간은 오늘 포함 최근 7일.
   *
   * 개별 호출 행은 내보내지 않는다 — 증빙에 필요한 건 집계이고, 행을 그대로 흘리면
   * 나중에 컬럼이 늘었을 때 같이 새어 나간다 (PM-SC-005).
   */
  @Get('calls')
  async calls(
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('provider') provider?: string,
  ): Promise<Record<string, unknown>> {
    return {
      ...(await this.service.calls({
        from: readDate(from, 'from'),
        to: readDate(to, 'to'),
        provider: readProvider(provider),
      })),
    };
  }
}

/**
 * 날짜를 읽는다. 모양이 아니면 **조용히 무시하지 않고 튕긴다.**
 *
 * 잘못된 값을 기본값으로 떨어뜨리면 화면은 자기가 요청한 구간을 받은 줄 알고 다른 구간의
 * 숫자를 증빙이라며 보여준다.
 */
function readDate(value: string | undefined, field: string): string | undefined {
  if (value === undefined || value === '') return undefined;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new BadRequestException(`${field} 는 YYYY-MM-DD 형식이어야 합니다.`);
  }
  return value;
}

function readProvider(value: string | undefined): CallProvider | undefined {
  if (value === undefined || value === '') return undefined;
  if (!CALL_PROVIDER.includes(value as CallProvider)) {
    throw new BadRequestException(`provider 는 ${CALL_PROVIDER.join(' · ')} 중 하나여야 합니다.`);
  }
  return value as CallProvider;
}
