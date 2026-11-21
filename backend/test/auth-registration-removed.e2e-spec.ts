import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { AppModule } from './../src/app.module';
import { buildSwaggerDocument } from './../src/common/swagger/swagger-document';
import { RoleName } from './../src/users/entities/role.entity';
import { registerAndLogin } from './utils/register-and-login';

describe('Public registration is removed (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;

  const tag = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

  const countUsers = async (email: string): Promise<number> => {
    const rows: { id: string }[] = await dataSource.query(
      `SELECT id FROM users WHERE email = $1`,
      [email],
    );
    return rows.length;
  };

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
  });

  afterAll(async () => {
    await app.close();
  });

  it('does not expose POST /auth/register: an unauthenticated request gets 404 and creates no user', async () => {
    const email = `sec01-anon-${tag}@example.com`;

    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email, password: 'CorrectHorseBattery9!' })
      .expect(404);

    expect(await countUsers(email)).toBe(0);
  });

  it('does not expose POST /auth/register to an authenticated ADMIN either', async () => {
    const admin = await registerAndLogin(app, dataSource, {
      role: RoleName.ADMIN,
      emailPrefix: `sec01-admin-${tag}`,
      mintToken: true,
    });
    const email = `sec01-by-admin-${tag}@example.com`;

    await request(app.getHttpServer())
      .post('/auth/register')
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .send({ email, password: 'CorrectHorseBattery9!' })
      .expect(404);

    expect(await countUsers(email)).toBe(0);
  });

  it('does not list /auth/register in the OpenAPI document', () => {
    const document = buildSwaggerDocument(app);

    expect(Object.keys(document.paths)).not.toContain('/auth/register');
    expect(Object.keys(document.components?.schemas ?? {})).not.toContain(
      'RegisterDto',
    );
  });

  it('rejects an unauthenticated POST /users with 401 and creates no user', async () => {
    const email = `sec01-users-anon-${tag}@example.com`;

    await request(app.getHttpServer())
      .post('/users')
      .send({ email, name: 'Anon', roles: [RoleName.ADMIN] })
      .expect(401);

    expect(await countUsers(email)).toBe(0);
  });

  it('still lets an ADMIN provision a user: temporary password returned once, mustChangePassword set, login works', async () => {
    const admin = await registerAndLogin(app, dataSource, {
      role: RoleName.ADMIN,
      emailPrefix: `sec01-provisioner-${tag}`,
      mintToken: true,
    });
    const email = `sec01-provisioned-${tag}@example.com`;

    const created = await request(app.getHttpServer())
      .post('/users')
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .send({ email, name: 'Provisioned User', roles: [RoleName.VIEWER] })
      .expect(201);

    expect(created.body.email).toBe(email);
    expect(created.body.roles).toEqual([RoleName.VIEWER]);
    const temporaryPassword: string = created.body.temporaryPassword;
    expect(temporaryPassword).toHaveLength(16);

    const [row] = await dataSource.query(
      `SELECT must_change_password FROM users WHERE email = $1`,
      [email],
    );
    expect(row.must_change_password).toBe(true);

    const login = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password: temporaryPassword })
      .expect(200);
    expect(login.body.mustChangePassword).toBe(true);
  });
});
