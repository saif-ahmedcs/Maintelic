import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AssetsModule } from '../assets/assets.module';
import { TelemetryController } from './telemetry.controller';
import { TelemetryLatestController } from './telemetry-latest.controller';
import { TelemetryReadingsController } from './telemetry-readings.controller';
import { TelemetrySummaryController } from './telemetry-summary.controller';
import { TelemetryService } from './telemetry.service';
import { TelemetryPersistenceProcessor } from './telemetry-persistence.processor';
import { TelemetryQueueMaintenanceService } from './telemetry-queue-maintenance.service';
import {
  telemetryPersistenceQueueRegistration,
  telemetryQueueRegistration,
} from './telemetry-queue.config';
import { TelemetryReading } from './entities/telemetry-reading.entity';

@Module({
  imports: [
    BullModule.registerQueue(
      telemetryQueueRegistration,
      telemetryPersistenceQueueRegistration,
    ),
    TypeOrmModule.forFeature([TelemetryReading]),
    AssetsModule,
  ],
  controllers: [
    TelemetryController,
    TelemetryReadingsController,
    TelemetrySummaryController,
    TelemetryLatestController,
  ],
  providers: [
    TelemetryService,
    TelemetryQueueMaintenanceService,
    TelemetryPersistenceProcessor,
  ],
})
export class TelemetryModule {}
