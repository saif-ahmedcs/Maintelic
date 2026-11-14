import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { AppModule } from './../src/app.module';
import { CLIENT_ERROR_FIELD_LIMITS } from './../src/client-errors/dto/create-client-error.dto';
import { registerAndLogin } from './utils/register-and-login';

describe('Client errors (e2e)', () => {
  let app: INestApplication<App>;

  const validReport = {
    message: 'TypeError: Cannot read properties of undefined',
    stack: 'TypeError: ...\n  at Component (App.tsx:42:7)',
    route: '/app/assets/123',
    requestId: 'c6e167e5-1234-4a5a-9a5a-000000000000',
    appVersion: '1.4.2',
  };

  beforeEach(async () => {
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
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it('rejects an unauthenticated request with 401, same as any other route', async () => {
    await request(app.getHttpServer())
      .post('/client-errors')
      .send(validReport)
      .expect(401);
  });

  it('accepts a fully populated report with 204 and no body', async () => {
    const dataSource = app.get(DataSource);
    const user = await registerAndLogin(app, dataSource, {
      emailPrefix: 'ce-basic',
      mintToken: true,
    });

    const res = await request(app.getHttpServer())
      .post('/client-errors')
      .set('Authorization', `Bearer ${user.accessToken}`)
      .send(validReport)
      .expect(204);

    expect(res.body).toEqual({});
  });

  it('accepts a report with only the required fields — stack and requestId are optional', async () => {
    const dataSource = app.get(DataSource);
    const user = await registerAndLogin(app, dataSource, {
      emailPrefix: 'ce-minimal',
      mintToken: true,
    });
    const { stack, requestId, ...minimalReport } = validReport;
    void stack;
    void requestId;

    await request(app.getHttpServer())
      .post('/client-errors')
      .set('Authorization', `Bearer ${user.accessToken}`)
      .send(minimalReport)
      .expect(204);
  });

  it.each(
    Object.entries(CLIENT_ERROR_FIELD_LIMITS) as [
      keyof typeof CLIENT_ERROR_FIELD_LIMITS,
      number,
    ][],
  )(
    'rejects %s past its length limit with a 400 naming the field',
    async (field, limit) => {
      const dataSource = app.get(DataSource);
      const user = await registerAndLogin(app, dataSource, {
        emailPrefix: `ce-oversize-${field}`,
        mintToken: true,
      });

      const res = await request(app.getHttpServer())
        .post('/client-errors')
        .set('Authorization', `Bearer ${user.accessToken}`)
        .send({ ...validReport, [field]: 'x'.repeat(limit + 1) })
        .expect(400);

      expect(res.body.statusCode).toBe(400);
      expect(JSON.stringify(res.body.message)).toContain(field);
    },
  );

  it('rejects an unknown extra field with 400', async () => {
    const dataSource = app.get(DataSource);
    const user = await registerAndLogin(app, dataSource, {
      emailPrefix: 'ce-extra-field',
      mintToken: true,
    });

    await request(app.getHttpServer())
      .post('/client-errors')
      .set('Authorization', `Bearer ${user.accessToken}`)
      .send({ ...validReport, userAgent: 'Mozilla/5.0' })
      .expect(400);
  });

  it('throttles one user to 20 reports per minute, independently of other users', async () => {
    const dataSource = app.get(DataSource);
    const throttledUser = await registerAndLogin(app, dataSource, {
      emailPrefix: 'ce-throttle-a',
      mintToken: true,
    });
    const otherUser = await registerAndLogin(app, dataSource, {
      emailPrefix: 'ce-throttle-b',
      mintToken: true,
    });

    const report = (accessToken: string) =>
      request(app.getHttpServer())
        .post('/client-errors')
        .set('Authorization', `Bearer ${accessToken}`)
        .send(validReport);

    for (let i = 0; i < 20; i++) {
      await report(throttledUser.accessToken).expect(204);
    }

    const blocked = await report(throttledUser.accessToken);
    expect(blocked.status).toBe(429);
    expect(blocked.body.statusCode).toBe(429);

    await report(otherUser.accessToken).expect(204);
  });
});
