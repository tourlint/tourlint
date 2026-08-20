import { Module } from '@nestjs/common';
import { HealthController } from './health/health.controller';
import { MockController } from './mock/mock.controller';

@Module({ controllers: [HealthController, MockController] })
export class AppModule {}
