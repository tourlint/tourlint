import { BadRequestException } from '@nestjs/common';
import { LCLS_SYSTM2 } from '@tourlint/shared';
import {
  SettingsTablesRepository,
  type DwellEntry,
  type IoEntry,
  type ProfileEntry,
} from './settings-tables.repository';
import { validateDwell, validateIo, validateProfiles } from './settings-tables.dto';

export class SettingsTablesService {
  constructor(private readonly repo: SettingsTablesRepository) {}

  async dwell(accountId: number): Promise<{ entries: DwellEntry[] }> {
    return { entries: await this.repo.dwell(accountId) };
  }

  async saveDwell(accountId: number, body: unknown): Promise<{ entries: DwellEntry[] }> {
    const { errors, entries } = validateDwell(body as { entries?: unknown } | undefined);
    if (entries === undefined) throw new BadRequestException(errors.join(' '));
    await this.repo.saveDwell(accountId, entries);
    return this.dwell(accountId);
  }

  async indoorOutdoor(accountId: number): Promise<{ entries: IoEntry[] }> {
    return { entries: await this.repo.indoorOutdoor(accountId) };
  }

  async saveIndoorOutdoor(accountId: number, body: unknown): Promise<{ entries: IoEntry[] }> {
    const { errors, entries } = validateIo(body as { entries?: unknown } | undefined);
    if (entries === undefined) throw new BadRequestException(errors.join(' '));
    await this.repo.saveIndoorOutdoor(accountId, entries);
    return this.indoorOutdoor(accountId);
  }

  async profiles(accountId: number): Promise<{ entries: ProfileEntry[] }> {
    return { entries: await this.repo.profiles(accountId) };
  }

  async saveProfiles(accountId: number, body: unknown): Promise<{ entries: ProfileEntry[] }> {
    const { errors, entries } = validateProfiles(body as { entries?: unknown } | undefined);
    if (entries === undefined) throw new BadRequestException(errors.join(' '));
    await this.repo.saveProfiles(accountId, entries);
    return this.profiles(accountId);
  }

  /** 중분류 59종 카탈로그(코드→이름). 프로파일 편집기의 기대 중분류 선택에 쓴다. 정적이다. */
  lcls(): { entries: { code: string; name: string }[] } {
    return {
      entries: Object.entries(LCLS_SYSTM2)
        .map(([code, v]) => ({ code, name: v.name }))
        .sort((a, b) => a.code.localeCompare(b.code)),
    };
  }
}
