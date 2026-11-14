import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { AppModule } from './../src/app.module';
import { RoleName } from './../src/users/entities/role.entity';
import { registerAndLogin } from './utils/register-and-login';

describe('Telemetry Batch Latest (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let adminToken: string;
  let assetOneId: string;
  let assetTwoId: string;
  let assetThreeId: string;

  const t0 = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const isoPlusMs = (ms: number) => new Date(t0.getTime() + ms).toISOString();

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    dataSource = moduleFixture.get(DataSource);
    await app.init();

    adminToken = (
      await registerAndLogin(app, dataSource, {
        role: RoleName.ADMIN,
        emailPrefix: 'telemetry-latest-batch-e2e-admin',
      })
    ).accessToken;

    const tag = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

    const plantId = (
      await request(app.getHttpServer())
        .post('/plants')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ name: `Telemetry-latest-batch-e2e Plant ${tag}` })
        .expect(201)
    ).body.id;

    const locationId = (
      await request(app.getHttpServer())
        .post('/locations')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ plantId, name: `Telemetry-latest-batch-e2e Location ${tag}` })
        .expect(201)
    ).body.id;

    const assetTypeId = (
      await request(app.getHttpServer())
        .post('/asset-types')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ name: `Telemetry-latest-batch-e2e Sensor ${tag}` })
        .expect(201)
    ).body.id;

    const createAsset = async (suffix: string): Promise<string> =>
      (
        await request(app.getHttpServer())
          .post('/assets')
          .set('Authorization', `Bearer ${adminToken}`)
          .send({ assetTypeId, locationId, tag: `PUMP-${tag}-${suffix}` })
          .expect(201)
      ).body.id;

    assetOneId = await createAsset('1');
    assetTwoId = await createAsset('2');
    assetThreeId = await createAsset('3');

    const insertReading = (
      assetId: string,
      recordedAt: string,
      temperature: number,
    ) =>
      dataSource.query(
        `INSERT INTO telemetry_readings (asset_id, temperature, vibration, pressure, recorded_at)
         VALUES ($1, $2, 2, 6, $3)`,
        [assetId, temperature, recordedAt],
      );

    await insertReading(assetOneId, isoPlusMs(0), 50.0);
    await insertReading(assetOneId, isoPlusMs(5 * 60 * 1000), 60.0);
    await insertReading(assetTwoId, isoPlusMs(10 * 60 * 1000), 70.0);
    await insertReading(assetTwoId, isoPlusMs(20 * 60 * 1000), 72.5);
    await insertReading(assetTwoId, isoPlusMs(15 * 60 * 1000), 71.0);
  });

  afterAll(async () => {
    await app.close();
  });

  const getLatestBatch = (assetIds: string[]) =>
    request(app.getHttpServer())
      .get('/telemetry/latest')
      .query({ assetIds: assetIds.join(',') })
      .set('Authorization', `Bearer ${adminToken}`);

  it('returns the latest reading per asset, keyed by asset ID', async () => {
    const res = await getLatestBatch([assetOneId, assetTwoId]).expect(200);

    expect(res.body[assetOneId]).toMatchObject({
      assetId: assetOneId,
      temperature: 60,
    });
    expect(res.body[assetTwoId]).toMatchObject({
      assetId: assetTwoId,
      temperature: 72.5,
    });
  });

  it('omits an asset with no readings and an asset ID that does not exist at all', async () => {
    const unknownAssetId = '00000000-0000-4000-8000-000000000000';

    const res = await getLatestBatch([
      assetOneId,
      assetThreeId,
      unknownAssetId,
    ]).expect(200);

    expect(Object.keys(res.body)).toEqual([assetOneId]);
  });

  it('returns an empty map when none of the requested assets have readings', async () => {
    const res = await getLatestBatch([assetThreeId]).expect(200);

    expect(res.body).toEqual({});
  });

  it('returns 400 when more than 50 asset IDs are requested', async () => {
    const tooMany = Array.from(
      { length: 51 },
      (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    );

    await getLatestBatch(tooMany).expect(400);
  });

  it('accepts exactly 50 asset IDs', async () => {
    const fifty = Array.from(
      { length: 50 },
      (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    );

    await getLatestBatch(fifty).expect(200);
  });

  it('returns 400 when an ID in the list is not a valid UUID', async () => {
    await getLatestBatch([assetOneId, 'not-a-uuid']).expect(400);
  });

  it('returns 400 when assetIds is missing', async () => {
    await request(app.getHttpServer())
      .get('/telemetry/latest')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(400);
  });

  it('returns 401 without a bearer token', async () => {
    await request(app.getHttpServer())
      .get('/telemetry/latest')
      .query({ assetIds: assetOneId })
      .expect(401);
  });
});
