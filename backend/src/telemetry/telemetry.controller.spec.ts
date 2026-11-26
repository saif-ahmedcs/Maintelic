import { Logger } from '@nestjs/common';
import {
  RECORDED_AT_FUTURE_TOLERANCE_MS,
  RECORDED_AT_PAST_TOLERANCE_MS,
} from './dto/telemetry-reading.dto';
import { TelemetryController } from './telemetry.controller';

describe('TelemetryController', () => {
  let controller: TelemetryController;
  let telemetryService: { ingest: jest.Mock };

  const validPayload = {
    assetId: 'd57d9ca9-0d4a-4151-ad92-88c8ab13b930',
    temperature: 45,
    vibration: 2.2,
    pressure: 6,
    recordedAt: '',
  };

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    telemetryService = { ingest: jest.fn(async () => undefined) };
    controller = new TelemetryController(telemetryService as any);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('ingests a reading whose recordedAt matches the server clock', async () => {
    await controller.handleTelemetry({
      ...validPayload,
      recordedAt: new Date().toISOString(),
    });

    expect(telemetryService.ingest).toHaveBeenCalledTimes(1);
  });

  it('ingests a reading just inside the tolerance window', async () => {
    const justInside = new Date(
      Date.now() + RECORDED_AT_FUTURE_TOLERANCE_MS - 1000,
    ).toISOString();

    await controller.handleTelemetry({
      ...validPayload,
      recordedAt: justInside,
    });

    expect(telemetryService.ingest).toHaveBeenCalledTimes(1);
  });

  it('drops a reading whose recordedAt is forged far in the future, without ingesting it', async () => {
    const farFuture = new Date(
      Date.now() + RECORDED_AT_FUTURE_TOLERANCE_MS + 60_000,
    ).toISOString();

    await controller.handleTelemetry({
      ...validPayload,
      recordedAt: farFuture,
    });

    expect(telemetryService.ingest).not.toHaveBeenCalled();
  });

  it('ingests a reading the broker queued for hours while the backend was down (BJM-3)', async () => {
    const queuedForHours = new Date(
      Date.now() - 6 * 60 * 60 * 1000,
    ).toISOString();

    await controller.handleTelemetry({
      ...validPayload,
      recordedAt: queuedForHours,
    });

    expect(telemetryService.ingest).toHaveBeenCalledTimes(1);
  });

  it('ingests a reading just inside the past tolerance window', async () => {
    const justInside = new Date(
      Date.now() - RECORDED_AT_PAST_TOLERANCE_MS + 60_000,
    ).toISOString();

    await controller.handleTelemetry({
      ...validPayload,
      recordedAt: justInside,
    });

    expect(telemetryService.ingest).toHaveBeenCalledTimes(1);
  });

  it('drops a reading whose recordedAt is older than the broker can have queued it, without ingesting it', async () => {
    const tooOld = new Date(
      Date.now() - RECORDED_AT_PAST_TOLERANCE_MS - 60_000,
    ).toISOString();

    await controller.handleTelemetry({ ...validPayload, recordedAt: tooOld });

    expect(telemetryService.ingest).not.toHaveBeenCalled();
  });

  it('keeps the future tolerance tight even though the past tolerance is wide', async () => {
    const slightlyAhead = new Date(
      Date.now() + RECORDED_AT_FUTURE_TOLERANCE_MS + 60_000,
    ).toISOString();

    await controller.handleTelemetry({
      ...validPayload,
      recordedAt: slightlyAhead,
    });

    expect(telemetryService.ingest).not.toHaveBeenCalled();
  });

  it('still drops a malformed payload before the recordedAt check ever runs', async () => {
    await controller.handleTelemetry({
      ...validPayload,
      recordedAt: new Date().toISOString(),
      temperature: 'hot',
    });

    expect(telemetryService.ingest).not.toHaveBeenCalled();
  });

  it('still drops a non-object payload', async () => {
    await controller.handleTelemetry('not-an-object');

    expect(telemetryService.ingest).not.toHaveBeenCalled();
  });
});
