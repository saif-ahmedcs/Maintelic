import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { AppModule } from './../src/app.module';
import { RoleName } from './../src/users/entities/role.entity';
import { registerAndLogin } from './utils/register-and-login';

describe('Work Orders — filter by maintenancePlanId (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let adminToken: string;
  let assetId: string;
  let planId: string;
  let otherPlanId: string;

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
        emailPrefix: 'wo-plan-filter-admin',
      })
    ).accessToken;

    const tag = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

    const plantId = (
      await request(app.getHttpServer())
        .post('/plants')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ name: `WO-plan-filter Plant ${tag}` })
        .expect(201)
    ).body.id;

    const locationId = (
      await request(app.getHttpServer())
        .post('/locations')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ plantId, name: `WO-plan-filter Location ${tag}` })
        .expect(201)
    ).body.id;

    const assetTypeId = (
      await request(app.getHttpServer())
        .post('/asset-types')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ name: `WO-plan-filter Pump ${tag}` })
        .expect(201)
    ).body.id;

    assetId = (
      await request(app.getHttpServer())
        .post('/assets')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ assetTypeId, locationId, tag: `WO-plan-filter-${tag}` })
        .expect(201)
    ).body.id;

    planId = (
      await request(app.getHttpServer())
        .post('/maintenance-plans')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ assetId, name: `Plan A ${tag}`, intervalDays: 30 })
        .expect(201)
    ).body.id;

    otherPlanId = (
      await request(app.getHttpServer())
        .post('/maintenance-plans')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ assetId, name: `Plan B ${tag}`, intervalDays: 30 })
        .expect(201)
    ).body.id;
  });

  afterAll(async () => {
    await app.close();
  });

  it('returns only work orders raised from the given plan, and rejects a malformed id with 400', async () => {
    const planWorkOrder = (
      await request(app.getHttpServer())
        .post('/work-orders')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          assetId,
          maintenancePlanId: planId,
          description: 'Planned lubrication from Plan A',
        })
        .expect(201)
    ).body;
    expect(planWorkOrder.source).toBe('PLANNED');
    expect(planWorkOrder.maintenancePlanId).toBe(planId);

    const otherPlanWorkOrder = (
      await request(app.getHttpServer())
        .post('/work-orders')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          assetId,
          maintenancePlanId: otherPlanId,
          description: 'Planned lubrication from Plan B',
        })
        .expect(201)
    ).body;

    const manualWorkOrder = (
      await request(app.getHttpServer())
        .post('/work-orders')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          assetId,
          description: 'Ad-hoc manual work order, no plan',
        })
        .expect(201)
    ).body;

    const res = await request(app.getHttpServer())
      .get('/work-orders')
      .query({ maintenancePlanId: planId, limit: 100 })
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    const ids = res.body.data.map((wo: { id: string }) => wo.id);
    expect(ids).toContain(planWorkOrder.id);
    expect(ids).not.toContain(otherPlanWorkOrder.id);
    expect(ids).not.toContain(manualWorkOrder.id);
    for (const wo of res.body.data) {
      expect(wo.maintenancePlanId).toBe(planId);
    }

    await request(app.getHttpServer())
      .get('/work-orders')
      .query({ maintenancePlanId: 'not-a-uuid' })
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(400);
  });

  it('returns an empty page for a plan with no work orders yet', async () => {
    const emptyPlanId = (
      await request(app.getHttpServer())
        .post('/maintenance-plans')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          assetId,
          name: `Plan with no history ${Date.now()}`,
          intervalDays: 30,
        })
        .expect(201)
    ).body.id;

    const res = await request(app.getHttpServer())
      .get('/work-orders')
      .query({ maintenancePlanId: emptyPlanId })
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    expect(res.body.data).toEqual([]);
    expect(res.body.meta.total).toBe(0);
  });
});
