import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { createHash } from 'node:crypto';
import { DataSource } from 'typeorm';
import { AppModule } from './../src/app.module';
import { seedUser } from './utils/register-and-login';

describe('Auth (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  const email = `auth-e2e-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;
  const password = 'CorrectHorseBattery9!';

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

  it('walks the full lifecycle: login -> protected route -> refresh -> protected route -> logout -> old refresh token rejected', async () => {
    // Accounts are provisioned by admins; there is no public registration.
    await seedUser(dataSource, { email, password });

    // Login
    const loginRes = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password })
      .expect(200);

    const firstAccessToken = loginRes.body.accessToken;
    const firstRefreshToken = loginRes.body.refreshToken;
    expect(firstAccessToken).toBeDefined();
    expect(firstRefreshToken).toBeDefined();

    // Protected route with the access token
    const meRes = await request(app.getHttpServer())
      .get('/auth/me')
      .set('Authorization', `Bearer ${firstAccessToken}`)
      .expect(200);
    expect(meRes.body.email).toBe(email);

    // No token at all -> 401
    await request(app.getHttpServer()).get('/auth/me').expect(401);

    // Refresh
    const refreshRes = await request(app.getHttpServer())
      .post('/auth/refresh')
      .send({ refreshToken: firstRefreshToken })
      .expect(200);

    const secondAccessToken = refreshRes.body.accessToken;
    const secondRefreshToken = refreshRes.body.refreshToken;
    expect(secondAccessToken).toBeDefined();
    expect(secondRefreshToken).not.toBe(firstRefreshToken);

    // Protected route again with the new access token
    await request(app.getHttpServer())
      .get('/auth/me')
      .set('Authorization', `Bearer ${secondAccessToken}`)
      .expect(200);

    // The old (rotated-out) refresh token must now be rejected
    await request(app.getHttpServer())
      .post('/auth/refresh')
      .send({ refreshToken: firstRefreshToken })
      .expect(401);

    // Logout with the current refresh token
    await request(app.getHttpServer())
      .post('/auth/logout')
      .send({ refreshToken: secondRefreshToken })
      .expect(204);

    // The logged-out refresh token can no longer be used
    await request(app.getHttpServer())
      .post('/auth/refresh')
      .send({ refreshToken: secondRefreshToken })
      .expect(401);
  });

  it('rejects login with the wrong password', async () => {
    await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password: 'wrong-password' })
      .expect(401);
  });

  async function seedAndLogin(prefix: string) {
    const raceEmail = `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;
    await seedUser(dataSource, { email: raceEmail, password });
    const { refreshToken } = (
      await request(app.getHttpServer())
        .post('/auth/login')
        .send({ email: raceEmail, password })
        .expect(200)
    ).body as { refreshToken: string };
    return { refreshToken };
  }

  async function raceTwoRefreshes(refreshToken: string) {
    const tokenHash = createHash('sha256').update(refreshToken).digest('hex');

    const holder = dataSource.createQueryRunner();
    await holder.connect();
    await holder.startTransaction();
    await holder.query(
      `SELECT id FROM refresh_tokens WHERE token_hash = $1 FOR UPDATE`,
      [tokenHash],
    );

    const refresh = () =>
      request(app.getHttpServer())
        .post('/auth/refresh')
        .send({ refreshToken })
        .then((res) => res);

    try {
      const first = refresh();
      const second = refresh();
      await new Promise((resolve) => setTimeout(resolve, 750));
      await holder.rollbackTransaction();
      return await Promise.all([first, second]);
    } finally {
      if (holder.isTransactionActive) await holder.rollbackTransaction();
      await holder.release();
    }
  }

  it('treats two concurrent refreshes of the same token as a benign race: both succeed, only one rotates, and the winner keeps a live session', async () => {
    const { refreshToken } = await seedAndLogin('auth-race');

    const responses = await raceTwoRefreshes(refreshToken);

    expect(responses.map((r) => r.status)).toEqual([200, 200]);

    const withRefreshToken = responses.filter(
      (r) => typeof r.body.refreshToken === 'string',
    );
    const accessOnly = responses.filter(
      (r) => r.body.refreshToken === undefined,
    );
    expect(withRefreshToken).toHaveLength(1);
    expect(accessOnly).toHaveLength(1);
    expect(accessOnly[0].headers['set-cookie']).toBeUndefined();
    expect(typeof accessOnly[0].body.accessToken).toBe('string');

    await request(app.getHttpServer())
      .post('/auth/refresh')
      .send({ refreshToken: withRefreshToken[0].body.refreshToken })
      .expect(200);
  });

  it('still revokes the whole family when a rotated token is replayed after the grace window', async () => {
    const { refreshToken } = await seedAndLogin('auth-replay');

    const rotated = await request(app.getHttpServer())
      .post('/auth/refresh')
      .send({ refreshToken })
      .expect(200);

    const tokenHash = createHash('sha256').update(refreshToken).digest('hex');
    await dataSource.query(
      `UPDATE refresh_tokens SET revoked_at = now() - interval '1 hour' WHERE token_hash = $1`,
      [tokenHash],
    );

    await request(app.getHttpServer())
      .post('/auth/refresh')
      .send({ refreshToken })
      .expect(401);

    await request(app.getHttpServer())
      .post('/auth/refresh')
      .send({ refreshToken: rotated.body.refreshToken })
      .expect(401);
  });
});
