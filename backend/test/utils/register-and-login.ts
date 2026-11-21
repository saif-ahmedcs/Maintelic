import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { Role, RoleName } from './../../src/users/entities/role.entity';
import { User } from './../../src/users/entities/user.entity';

export const PASSWORD = 'CorrectHorseBattery9!';

const BCRYPT_SALT_ROUNDS = 10;

export interface RegisteredUser {
  email: string;
  accessToken: string;
}

export async function seedUser(
  dataSource: DataSource,
  options: { email: string; password?: string; role?: RoleName },
): Promise<User> {
  const roleNames = Array.from(
    new Set([RoleName.VIEWER, ...(options.role ? [options.role] : [])]),
  );
  const roles = await dataSource
    .getRepository(Role)
    .createQueryBuilder('role')
    .where('role.name IN (:...roleNames)', { roleNames })
    .getMany();
  if (roles.length !== roleNames.length) {
    throw new Error('Roles are not seeded. Run migrations first.');
  }

  const userRepo = dataSource.getRepository(User);
  return userRepo.save(
    userRepo.create({
      email: options.email,
      passwordHash: await bcrypt.hash(
        options.password ?? PASSWORD,
        BCRYPT_SALT_ROUNDS,
      ),
      isActive: true,
      roles,
    }),
  );
}

export async function registerAndLogin(
  app: INestApplication<App>,
  dataSource: DataSource,
  options: {
    role?: RoleName;
    emailPrefix?: string;
    mintToken?: boolean;
  } = {},
): Promise<RegisteredUser> {
  const email = `${options.emailPrefix ?? 'e2e'}-${Date.now()}-${Math.floor(
    Math.random() * 1e6,
  )}@example.com`;

  const user = await seedUser(dataSource, { email, role: options.role });

  if (options.mintToken) {
    const jwtService = app.get(JwtService, { strict: false });
    const accessToken = jwtService.sign(
      { sub: user.id, email, roles: options.role ? [options.role] : [] },
      { expiresIn: '15m' },
    );
    return { email, accessToken };
  }

  const loginRes = await request(app.getHttpServer())
    .post('/auth/login')
    .send({ email, password: PASSWORD })
    .expect(200);

  return { email, accessToken: loginRes.body.accessToken };
}
