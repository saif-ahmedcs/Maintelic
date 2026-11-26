import { TelemetryReadingDto } from '../dto/telemetry-reading.dto';

/**
 * A reading whose first insert hit a transient Postgres failure and which is
 * being held in Redis until it can be stored.
 */
export interface TelemetryPersistenceJobData {
  /**
   * Primary key of the `telemetry_readings` row, generated once when the
   * reading is first ingested. Every later attempt inserts the same id, so a
   * retry after an ambiguous failure (the connection died after the commit
   * but before the acknowledgement) hits the primary key instead of storing
   * the reading twice.
   */
  readingId: string;
  reading: TelemetryReadingDto;
  correlationId: string;
}
