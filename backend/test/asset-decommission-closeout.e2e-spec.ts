import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { AppModule } from './../src/app.module';
import {
  Notification,
  NotificationStatus,
  NotificationType,
} from './../src/notifications/entities/notification.entity';
import { RoleName } from './../src/users/entities/role.entity';
import { registerAndLogin } from './utils/register-and-login';

describe('Asset decommission close-out (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let adminToken: string;
  let assetTypeId: string;
  let locationId: string;

  const auth = (req: request.Test) =>
    req.set('Authorization', `Bearer ${adminToken}`);

  async function createAsset(label: string): Promise<string> {
    const res = await auth(request(app.getHttpServer()).post('/assets'))
      .send({
        assetTypeId,
        locationId,
        tag: `DC-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
      })
      .expect(201);
    return res.body.id;
  }

  async function createOverduePlan(assetId: string): Promise<string> {
    const res = await auth(
      request(app.getHttpServer()).post('/maintenance-plans'),
    )
      .send({
        assetId,
        name: `Overdue plan ${Date.now()}`,
        intervalDays: 30,
        nextDueAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
      })
      .expect(201);
    return res.body.id;
  }

  function decommission(assetId: string) {
    return auth(
      request(app.getHttpServer()).patch(`/assets/${assetId}/status`),
    ).send({ status: 'DECOMMISSIONED' });
  }

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
        emailPrefix: 'dc-e2e-admin',
      })
    ).accessToken;

    const tag = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const plantId = (
      await auth(request(app.getHttpServer()).post('/plants'))
        .send({ name: `DC-e2e Plant ${tag}` })
        .expect(201)
    ).body.id;
    locationId = (
      await auth(request(app.getHttpServer()).post('/locations'))
        .send({ plantId, name: `DC-e2e Location ${tag}` })
        .expect(201)
    ).body.id;
    assetTypeId = (
      await auth(request(app.getHttpServer()).post('/asset-types'))
        .send({ name: `DC-e2e Pump ${tag}` })
        .expect(201)
    ).body.id;
  });

  afterAll(async () => {
    await app.close();
  });

  it('closes out plans, alerts and open work orders when an asset is decommissioned', async () => {
    const assetId = await createAsset('closeout');
    const planId = await createOverduePlan(assetId);

    const notification = await dataSource.getRepository(Notification).save(
      dataSource.getRepository(Notification).create({
        type: NotificationType.OVERDUE_MAINTENANCE,
        relatedEntityType: 'MaintenancePlan',
        relatedEntityId: planId,
        message: 'overdue',
        status: NotificationStatus.UNREAD,
      }),
    );

    const manualWo = (
      await auth(request(app.getHttpServer()).post('/work-orders'))
        .send({ assetId, description: 'Manual job' })
        .expect(201)
    ).body.id;
    const startedWo = (
      await auth(request(app.getHttpServer()).post('/work-orders'))
        .send({ assetId, description: 'Started job' })
        .expect(201)
    ).body.id;
    await auth(
      request(app.getHttpServer()).patch(`/work-orders/${startedWo}/assign`),
    )
      .send({})
      .expect(200);
    await auth(
      request(app.getHttpServer()).patch(`/work-orders/${startedWo}/start`),
    ).expect(200);

    await decommission(assetId).expect(200);

    // Plan deactivated, no longer due.
    const plan = await auth(
      request(app.getHttpServer()).get(`/maintenance-plans/${planId}`),
    ).expect(200);
    expect(plan.body.active).toBe(false);

    const due = await auth(
      request(app.getHttpServer()).get('/maintenance-plans/due'),
    )
      .query({ limit: 100 })
      .expect(200);
    expect(due.body.data.map((p: { id: string }) => p.id)).not.toContain(
      planId,
    );

    // Alert resolved.
    const reloaded = await dataSource
      .getRepository(Notification)
      .findOneByOrFail({ id: notification.id });
    expect(reloaded.status).toBe(NotificationStatus.RESOLVED);

    // Every open work order cancelled, and no longer startable/completable.
    for (const id of [manualWo, startedWo]) {
      const wo = await auth(
        request(app.getHttpServer()).get(`/work-orders/${id}`),
      ).expect(200);
      expect(wo.body.status).toBe('CANCELLED');
    }
    await auth(
      request(app.getHttpServer()).patch(`/work-orders/${startedWo}/complete`),
    )
      .send({})
      .expect(409);
    await auth(
      request(app.getHttpServer()).patch(`/work-orders/${manualWo}/assign`),
    )
      .send({})
      .expect(409);
  });

  it('rejects creating or reactivating plans for a decommissioned asset', async () => {
    const assetId = await createAsset('noplans');
    const planId = await createOverduePlan(assetId);

    await decommission(assetId).expect(200);

    await auth(request(app.getHttpServer()).post('/maintenance-plans'))
      .send({ assetId, name: 'Too late', intervalDays: 30 })
      .expect(409);

    await auth(
      request(app.getHttpServer()).patch(`/maintenance-plans/${planId}`),
    )
      .send({ active: true })
      .expect(409);

    await auth(request(app.getHttpServer()).post('/work-orders'))
      .send({ assetId, description: 'Nope' })
      .expect(409);
  });

  it('leaves other assets untouched', async () => {
    const retired = await createAsset('retired');
    const running = await createAsset('running');
    await createOverduePlan(retired);
    const runningPlan = await createOverduePlan(running);

    await decommission(retired).expect(200);

    const plan = await auth(
      request(app.getHttpServer()).get(`/maintenance-plans/${runningPlan}`),
    ).expect(200);
    expect(plan.body.active).toBe(true);

    const due = await auth(
      request(app.getHttpServer()).get('/maintenance-plans/due'),
    )
      .query({ limit: 100 })
      .expect(200);
    expect(due.body.data.map((p: { id: string }) => p.id)).toContain(
      runningPlan,
    );
  });
});
