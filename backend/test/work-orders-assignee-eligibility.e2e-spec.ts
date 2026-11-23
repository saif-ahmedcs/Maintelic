import { INestApplication, ValidationPipe } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { AppModule } from './../src/app.module';
import { RoleName } from './../src/users/entities/role.entity';
import { User } from './../src/users/entities/user.entity';
import { seedUser } from './utils/register-and-login';

interface TestUser {
  id: string;
  email: string;
  token: string;
}

describe('Work order assignee eligibility (BL-04, e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let admin: TestUser;
  let supervisor: TestUser;
  let assetId: string;

  const http = () => request(app.getHttpServer());
  const auth = (user: TestUser) => ({ Authorization: `Bearer ${user.token}` });

  async function makeUser(prefix: string, role?: RoleName): Promise<TestUser> {
    const email = `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;
    const user = await seedUser(dataSource, { email, role });
    const token = app
      .get(JwtService, { strict: false })
      .sign(
        { sub: user.id, email, roles: role ? [role] : [] },
        { expiresIn: '15m' },
      );
    return { id: user.id, email, token };
  }

  async function createWorkOrder(): Promise<string> {
    const res = await http()
      .post('/work-orders')
      .set(auth(supervisor))
      .send({
        assetId,
        description: 'BL-04 e2e work order',
        priority: 'CRITICAL',
      })
      .expect(201);
    return res.body.id;
  }

  const getWorkOrder = async (id: string) =>
    (await http().get(`/work-orders/${id}`).set(auth(admin)).expect(200)).body;

  const assign = (woId: string, actor: TestUser, assignedToUserId?: string) =>
    http()
      .patch(`/work-orders/${woId}/assign`)
      .set(auth(actor))
      .send(assignedToUserId ? { assignedToUserId } : {});

  const deactivate = (userId: string) =>
    http()
      .patch(`/users/${userId}`)
      .set(auth(admin))
      .send({ active: false })
      .expect(200);

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

    admin = await makeUser('bl04-admin', RoleName.ADMIN);
    supervisor = await makeUser('bl04-super', RoleName.SUPERVISOR);

    const tag = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const plantId = (
      await http()
        .post('/plants')
        .set(auth(admin))
        .send({ name: `BL04 Plant ${tag}` })
        .expect(201)
    ).body.id;
    const locationId = (
      await http()
        .post('/locations')
        .set(auth(admin))
        .send({ plantId, name: `BL04 Location ${tag}` })
        .expect(201)
    ).body.id;
    const assetTypeId = (
      await http()
        .post('/asset-types')
        .set(auth(admin))
        .send({ name: `BL04 Pump ${tag}` })
        .expect(201)
    ).body.id;
    assetId = (
      await http()
        .post('/assets')
        .set(auth(admin))
        .send({ assetTypeId, locationId, tag: `BL04-${tag}` })
        .expect(201)
    ).body.id;
  });

  afterAll(async () => {
    await app.close();
  });

  describe('assign validates the target user (scenario A)', () => {
    it('rejects a nonexistent user with 404, not a database FK error', async () => {
      const woId = await createWorkOrder();

      const res = await assign(
        woId,
        supervisor,
        '00000000-0000-4000-8000-000000000000',
      ).expect(404);

      expect(res.body.message).toMatch(/not found/i);
      expect((await getWorkOrder(woId)).status).toBe('OPEN');
    });

    it('rejects a deactivated technician with 409 and leaves the work order OPEN', async () => {
      const woId = await createWorkOrder();
      const tech = await makeUser('bl04-tech', RoleName.TECHNICIAN);
      await deactivate(tech.id);

      const res = await assign(woId, supervisor, tech.id).expect(409);

      expect(res.body.message).toMatch(/deactivated/i);
      const wo = await getWorkOrder(woId);
      expect(wo.status).toBe('OPEN');
      expect(wo.assignedToUserId).toBeNull();
    });

    it('rejects a VIEWER with 409 and leaves the work order OPEN', async () => {
      const woId = await createWorkOrder();
      const viewer = await makeUser('bl04-viewer');

      await assign(woId, supervisor, viewer.id).expect(409);

      const wo = await getWorkOrder(woId);
      expect(wo.status).toBe('OPEN');
      expect(wo.assignedToUserId).toBeNull();
    });

    it('still lets a VIEWER-only caller be refused at the role guard', async () => {
      const woId = await createWorkOrder();
      const viewer = await makeUser('bl04-viewer-self');

      await assign(woId, viewer).expect(403);
    });

    it.each([[RoleName.TECHNICIAN], [RoleName.SUPERVISOR], [RoleName.ADMIN]])(
      'accepts an active %s',
      async (role) => {
        const woId = await createWorkOrder();
        const target = await makeUser(`bl04-ok-${role.toLowerCase()}`, role);

        const res = await assign(woId, supervisor, target.id).expect(200);

        expect(res.body).toMatchObject({
          status: 'ASSIGNED',
          assignedToUserId: target.id,
        });
      },
    );
  });

  describe('deactivating an assignee releases their work orders', () => {
    it('returns an ASSIGNED work order to OPEN, unassigned, with an audit entry', async () => {
      const tech = await makeUser('bl04-rel-assigned', RoleName.TECHNICIAN);
      const woId = await createWorkOrder();
      await assign(woId, supervisor, tech.id).expect(200);

      await deactivate(tech.id);

      const wo = await getWorkOrder(woId);
      expect(wo.status).toBe('OPEN');
      expect(wo.assignedToUserId).toBeNull();

      const audit = await http()
        .get('/audit')
        .query({ entityType: 'WorkOrder', entityId: woId, action: 'UNASSIGN' })
        .set(auth(admin))
        .expect(200);
      expect(audit.body.data).toHaveLength(1);
      expect(audit.body.data[0]).toMatchObject({
        actorUserId: admin.id,
        source: 'user-deactivation',
        before: { status: 'ASSIGNED', assignedToUserId: tech.id },
        after: { status: 'OPEN', assignedToUserId: null },
      });
    });

    it('can then be assigned to someone else', async () => {
      const tech = await makeUser('bl04-rel-a', RoleName.TECHNICIAN);
      const other = await makeUser('bl04-rel-b', RoleName.TECHNICIAN);
      const woId = await createWorkOrder();
      await assign(woId, supervisor, tech.id).expect(200);
      await deactivate(tech.id);

      const res = await assign(woId, supervisor, other.id).expect(200);

      expect(res.body).toMatchObject({
        status: 'ASSIGNED',
        assignedToUserId: other.id,
      });
    });

    it('unassigns IN_PROGRESS work (scenario B), keeps its status and lets a supervisor reassign it', async () => {
      const tech = await makeUser('bl04-prog', RoleName.TECHNICIAN);
      const other = await makeUser('bl04-prog-other', RoleName.TECHNICIAN);
      const woId = await createWorkOrder();
      await assign(woId, tech, tech.id).expect(200);
      await http()
        .patch(`/work-orders/${woId}/start`)
        .set(auth(tech))
        .expect(200);

      await deactivate(tech.id);

      const orphaned = await getWorkOrder(woId);
      expect(orphaned.status).toBe('IN_PROGRESS');
      expect(orphaned.assignedToUserId).toBeNull();

      await assign(woId, other).expect(409);
      const res = await assign(woId, supervisor, other.id).expect(200);
      expect(res.body).toMatchObject({
        status: 'IN_PROGRESS',
        assignedToUserId: other.id,
      });

      await http()
        .patch(`/work-orders/${woId}/complete`)
        .set(auth(other))
        .send({})
        .expect(200);
      expect((await getWorkOrder(woId)).status).toBe('COMPLETED');
    });

    it('unassigns BLOCKED work, keeps its status and block reason, and allows reassignment', async () => {
      const tech = await makeUser('bl04-blk', RoleName.TECHNICIAN);
      const other = await makeUser('bl04-blk-other', RoleName.TECHNICIAN);
      const woId = await createWorkOrder();
      await assign(woId, tech, tech.id).expect(200);
      await http()
        .patch(`/work-orders/${woId}/start`)
        .set(auth(tech))
        .expect(200);
      await http()
        .patch(`/work-orders/${woId}/block`)
        .set(auth(tech))
        .send({ reason: 'Waiting on a bearing' })
        .expect(200);

      await deactivate(tech.id);

      const orphaned = await getWorkOrder(woId);
      expect(orphaned).toMatchObject({
        status: 'BLOCKED',
        assignedToUserId: null,
        blockReason: 'Waiting on a bearing',
      });

      const res = await assign(woId, admin, other.id).expect(200);
      expect(res.body).toMatchObject({
        status: 'BLOCKED',
        assignedToUserId: other.id,
      });
    });

    it('leaves COMPLETED work orders attributed to the deactivated user', async () => {
      const tech = await makeUser('bl04-done', RoleName.TECHNICIAN);
      const woId = await createWorkOrder();
      await assign(woId, tech, tech.id).expect(200);
      await http()
        .patch(`/work-orders/${woId}/start`)
        .set(auth(tech))
        .expect(200);
      await http()
        .patch(`/work-orders/${woId}/complete`)
        .set(auth(tech))
        .send({})
        .expect(200);

      await deactivate(tech.id);

      expect(await getWorkOrder(woId)).toMatchObject({
        status: 'COMPLETED',
        assignedToUserId: tech.id,
      });
    });

    it("does not touch another user's work orders", async () => {
      const tech = await makeUser('bl04-iso-a', RoleName.TECHNICIAN);
      const other = await makeUser('bl04-iso-b', RoleName.TECHNICIAN);
      const woId = await createWorkOrder();
      await assign(woId, supervisor, other.id).expect(200);

      await deactivate(tech.id);

      expect(await getWorkOrder(woId)).toMatchObject({
        status: 'ASSIGNED',
        assignedToUserId: other.id,
      });
    });
  });

  describe('losing every eligible role releases work orders', () => {
    it('releases the work when the new role set is VIEWER only', async () => {
      const tech = await makeUser('bl04-demote', RoleName.TECHNICIAN);
      const woId = await createWorkOrder();
      await assign(woId, supervisor, tech.id).expect(200);

      await http()
        .put(`/users/${tech.id}/roles`)
        .set(auth(admin))
        .send({ roles: [RoleName.VIEWER] })
        .expect(200);

      expect(await getWorkOrder(woId)).toMatchObject({
        status: 'OPEN',
        assignedToUserId: null,
      });
      // ...and the demoted user is no longer assignable.
      await assign(woId, supervisor, tech.id).expect(409);
    });

    it('keeps the work when an eligible role remains', async () => {
      const tech = await makeUser('bl04-keep', RoleName.TECHNICIAN);
      const woId = await createWorkOrder();
      await assign(woId, supervisor, tech.id).expect(200);

      await http()
        .put(`/users/${tech.id}/roles`)
        .set(auth(admin))
        .send({ roles: [RoleName.TECHNICIAN, RoleName.VIEWER] })
        .expect(200);

      expect(await getWorkOrder(woId)).toMatchObject({
        status: 'ASSIGNED',
        assignedToUserId: tech.id,
      });
    });
  });

  describe('assign vs. deactivation race', () => {
    it('never leaves a live work order assigned to a deactivated user', async () => {
      for (let i = 0; i < 5; i++) {
        const tech = await makeUser(`bl04-race-${i}`, RoleName.TECHNICIAN);
        const woId = await createWorkOrder();

        const [assignRes, deactivateRes] = await Promise.all([
          assign(woId, supervisor, tech.id),
          http()
            .patch(`/users/${tech.id}`)
            .set(auth(admin))
            .send({ active: false }),
        ]);

        expect(deactivateRes.status).toBe(200);
        expect([200, 409]).toContain(assignRes.status);

        const wo = await getWorkOrder(woId);
        expect(wo.assignedToUserId).toBeNull();
        expect(wo.status).toBe('OPEN');
        const user = await dataSource
          .getRepository(User)
          .findOneByOrFail({ id: tech.id });
        expect(user.isActive).toBe(false);
      }
    });
  });
});
