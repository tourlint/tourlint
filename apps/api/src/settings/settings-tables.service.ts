import { BadRequestException } from '@nestjs/common';
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
}
