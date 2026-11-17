import { UnauthorizedException } from '@nestjs/common';
import { RoleName } from '../../users/entities/role.entity';
import { JwtStrategy } from './jwt.strategy';

describe('JwtStrategy', () => {
  let strategy: JwtStrategy;
  let usersService: { findById: jest.Mock };
  let config: { get: jest.Mock };

  beforeEach(() => {
    usersService = { findById: jest.fn() };
    config = {
      get: jest.fn().mockReturnValue('a-test-secret-at-least-32-chars-long'),
    };
    strategy = new JwtStrategy(config as never, usersService as never);
  });

  it('returns id, email, roles, name, and mustChangePassword for an active user (Phase 22)', async () => {
    usersService.findById.mockResolvedValue({
      id: 'user-1',
      email: 'tech@plant.example',
      name: 'Jordan Reyes',
      isActive: true,
      mustChangePassword: true,
      roles: [{ name: RoleName.TECHNICIAN }],
    });

    const result = await strategy.validate({
      sub: 'user-1',
      email: 'tech@plant.example',
      roles: [RoleName.TECHNICIAN],
    });

    expect(result).toEqual({
      id: 'user-1',
      email: 'tech@plant.example',
      roles: [RoleName.TECHNICIAN],
      name: 'Jordan Reyes',
      mustChangePassword: true,
    });
  });

  it('passes through a null name for a user who was never given one', async () => {
    usersService.findById.mockResolvedValue({
      id: 'user-2',
      email: 'admin@plant.example',
      name: null,
      isActive: true,
      mustChangePassword: false,
      roles: [{ name: RoleName.ADMIN }],
    });

    const result = await strategy.validate({
      sub: 'user-2',
      email: 'admin@plant.example',
      roles: [RoleName.ADMIN],
    });

    expect(result.name).toBeNull();
    expect(result.mustChangePassword).toBe(false);
  });

  it('throws UnauthorizedException when the user no longer exists', async () => {
    usersService.findById.mockResolvedValue(null);

    await expect(
      strategy.validate({
        sub: 'gone',
        email: 'gone@plant.example',
        roles: [],
      }),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('throws UnauthorizedException when the user has been deactivated', async () => {
    usersService.findById.mockResolvedValue({
      id: 'user-3',
      email: 'inactive@plant.example',
      name: 'Inactive User',
      isActive: false,
      mustChangePassword: false,
      roles: [],
    });

    await expect(
      strategy.validate({
        sub: 'user-3',
        email: 'inactive@plant.example',
        roles: [],
      }),
    ).rejects.toThrow(UnauthorizedException);
  });
});
