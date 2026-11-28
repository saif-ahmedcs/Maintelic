import type { ConfigService } from '@nestjs/config';

export const BCRYPT_SALT_ROUNDS = 10;

const DEFAULT_REFRESH_EXPIRES_IN_DAYS = 7;

export function refreshTokenLifetimeMs(config: ConfigService): number {
  const days =
    config.get<number>('JWT_REFRESH_EXPIRES_IN_DAYS') ??
    DEFAULT_REFRESH_EXPIRES_IN_DAYS;
  return days * 24 * 60 * 60 * 1000;
}
