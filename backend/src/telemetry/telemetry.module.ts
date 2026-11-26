import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AssetsModule } from '../assets/assets.module';
import { TelemetryController } from './telemetry.controller';
import { TelemetryLatestController } from './telemetry-latest.controller';
import { TelemetryReadingsController } from './telemetry-readings.controller';
import { TelemetrySummaryController } from './telemetry-summary.controller';
import { TelemetryService } from './telemetry.service';
import { TelemetryQueueMaintenanceService } from './telemetry-queue-maintenance.service';
import { telemetryQueueRegistration } from './telemetry-queue.config';
import { TelemetryReading } from './entities/telemetry-reading.entity';

@Module({
  imports: [
    BullModule.registerQueue(telemetryQueueRegistration),
    TypeOrmModule.forFeature([TelemetryReading]),
    AssetsModule,
  ],
  controllers: [
    TelemetryController,
    TelemetryReadingsController,
    TelemetrySummaryController,
    TelemetryLatestController,
  ],
  providers: [TelemetryService, TelemetryQueueMaintenanceService],
})
export class TelemetryModule {}
