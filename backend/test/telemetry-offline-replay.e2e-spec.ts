import { INestApplication, ValidationPipe } from '@nestjs/common';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import { Test } from '@nestjs/testing';
import mqtt, { MqttClient } from 'mqtt';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { AppModule } from './../src/app.module';
import {
  buildBackendMqttOptions,
  buildMqttUrl,
  MQTT_BACKEND_USERNAME,
} from './../src/common/mqtt/mqtt-connection-options';
import { RoleName } from './../src/users/entities/role.entity';
import { connectAsSimulator } from './utils/mqtt';
import { poll } from './utils/poll';
import { registerAndLogin } from './utils/register-and-login';

describe('Telemetry published while the backend is down (BJM-3, e2e)', () => {
  const clientId = `maintelic-backend-e2e-replay-${randomUUID()}`;
  let simulator: MqttClient;
  let app: INestApplication<App> | undefined;

  const bootBackend = async (): Promise<INestApplication<App>> => {
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    const instance =
      moduleFixture.createNestApplication<INestApplication<App>>();
    instance.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    instance.connectMicroservice<MicroserviceOptions>({
      transport: Transport.MQTT,
      options: buildBackendMqttOptions({
        host: process.env.MQTT_HOST as string,
        port: process.env.MQTT_PORT as string,
        password: process.env.MQTT_BACKEND_PASSWORD as string,
        clientId,
      }),
    });
    await instance.init();
    await instance.startAllMicroservices();
    await new Promise((resolve) => setTimeout(resolve, 300));
    return instance;
  };

  beforeAll(async () => {
    simulator = await connectAsSimulator();
  });

  afterAll(async () => {
    await simulator?.endAsync(true);
    await app?.close();
    const cleaner = mqtt.connect(
      buildMqttUrl(
        process.env.MQTT_HOST as string,
        process.env.MQTT_PORT as string,
      ),
      {
        clientId,
        clean: true,
        username: MQTT_BACKEND_USERNAME,
        password: process.env.MQTT_BACKEND_PASSWORD,
        reconnectPeriod: 0,
      },
    );
    await new Promise<void>((resolve, reject) => {
      cleaner.once('connect', () => resolve());
      cleaner.once('error', reject);
    });
    await cleaner.endAsync();
  });

  it('stores every reading published during the outage, including ones older than the old 5-minute window, and ends with the newest as latest', async () => {
    // --- first run: create the asset the readings belong to ---
    app = await bootBackend();
    const firstDataSource = app.get(DataSource);
    const adminToken = (
      await registerAndLogin(app, firstDataSource, {
        role: RoleName.ADMIN,
        emailPrefix: 'telemetry-replay-e2e-admin',
      })
    ).accessToken;
    const tag = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const auth = { Authorization: `Bearer ${adminToken}` };

    const plantId = (
      await request(app.getHttpServer())
        .post('/plants')
        .set(auth)
        .send({ name: `Replay-e2e Plant ${tag}` })
        .expect(201)
    ).body.id;
    const locationId = (
      await request(app.getHttpServer())
        .post('/locations')
        .set(auth)
        .send({ plantId, name: `Replay-e2e Location ${tag}` })
        .expect(201)
    ).body.id;
    const assetTypeId = (
      await request(app.getHttpServer())
        .post('/asset-types')
        .set(auth)
        .send({ name: `Replay-e2e Sensor ${tag}` })
        .expect(201)
    ).body.id;
    const assetId = (
      await request(app.getHttpServer())
        .post('/assets')
        .set(auth)
        .send({ assetTypeId, locationId, tag: `PUMP-${tag}` })
        .expect(201)
    ).body.id;

    // --- the backend goes down (deploy / crash) ---
    await app.close();
    app = undefined;

    // --- the simulator keeps publishing meanwhile ---
    const minutesAgo = [20, 15, 10, 5, 1];
    const topic = `factory/${plantId}/asset/${assetId}/telemetry`;
    await Promise.all(
      minutesAgo.map(
        (minutes, i) =>
          new Promise<void>((resolve, reject) => {
            simulator.publish(
              topic,
              JSON.stringify({
                assetId,
                temperature: 60 + i,
                vibration: 2.1,
                pressure: 5.9,
                recordedAt: new Date(
                  Date.now() - minutes * 60 * 1000,
                ).toISOString(),
              }),
              { qos: 1 },
              (err) => (err ? reject(err) : resolve()),
            );
          }),
      ),
    );

    // --- the backend comes back ---
    app = await bootBackend();
    const dataSource = app.get(DataSource);

    const rows = await poll(
      async () => {
        const found: Array<{ temperature: string }> = await dataSource.query(
          `SELECT temperature FROM telemetry_readings WHERE asset_id = $1 ORDER BY recorded_at ASC`,
          [assetId],
        );
        return found.length >= minutesAgo.length ? found : null;
      },
      { timeoutMs: 15000 },
    );
    expect(rows.map((r) => Number(r.temperature))).toEqual([
      60, 61, 62, 63, 64,
    ]);

    // Handled concurrently and in no guaranteed order, yet the newest
    // reading is what the API reports as latest.
    const latest = await poll(async () => {
      const res = await request(app!.getHttpServer())
        .get(`/assets/${assetId}/telemetry/latest`)
        .set(auth);
      return res.status === 200 && res.body.temperature === 64
        ? res.body
        : null;
    });
    expect(latest.temperature).toBe(64);
  }, 60000);
});
