import { NotFoundException } from '@nestjs/common';
import { RequestUser } from '../auth/interfaces/request-user.interface';
import { RoleName } from '../users/entities/role.entity';
import { MaintenancePlan } from './entities/maintenance-plan.entity';
import { MaintenancePlansService } from './maintenance-plans.service';

describe('MaintenancePlansService notification reconciliation', () => {
  let service: MaintenancePlansService;
  let manager: { findOne: jest.Mock; save: jest.Mock; remove: jest.Mock };
  let auditService: { record: jest.Mock };
  let notificationsService: { resolveActive: jest.Mock };
  let plan: MaintenancePlan;

  const actor: RequestUser = {
    id: 'user-1',
    email: 'admin@example.com',
    roles: [RoleName.ADMIN],
  };
  const DAY = 24 * 60 * 60 * 1000;

  beforeEach(() => {
    plan = {
      id: 'plan-1',
      assetId: 'asset-1',
      name: 'Lubrication',
      intervalDays: 30,
      active: true,
      nextDueAt: new Date(Date.now() - DAY), // overdue
    } as MaintenancePlan;
    manager = {
      findOne: jest.fn(async () => plan),
      save: jest.fn(async (entity) => entity),
      remove: jest.fn(async (entity) => entity),
    };
    auditService = { record: jest.fn(async () => ({})) };
    notificationsService = { resolveActive: jest.fn(async () => 1) };
    service = new MaintenancePlansService(
      {} as any,
      {} as any,
      { transaction: jest.fn((cb) => cb(manager)) } as any,
      auditService as any,
      notificationsService as any,
    );
  });

  const expectResolved = () =>
    expect(notificationsService.resolveActive).toHaveBeenCalledWith(
      manager,
      'OVERDUE_MAINTENANCE',
      'MaintenancePlan',
      'plan-1',
    );

  it('resolves OVERDUE_MAINTENANCE when the plan is deactivated', async () => {
    await service.update('plan-1', { active: false } as any, actor);

    expectResolved();
  });

  it('resolves OVERDUE_MAINTENANCE when the next due date is moved into the future', async () => {
    await service.update(
      'plan-1',
      { nextDueAt: new Date(Date.now() + 5 * DAY).toISOString() } as any,
      actor,
    );

    expectResolved();
  });

  it('keeps the notification while the plan is still active and overdue', async () => {
    await service.update('plan-1', { active: true } as any, actor);

    expect(notificationsService.resolveActive).not.toHaveBeenCalled();
  });

  it('does not reconcile for updates that touch neither activity nor due date', async () => {
    await service.update('plan-1', { name: 'Renamed' } as any, actor);

    expect(notificationsService.resolveActive).not.toHaveBeenCalled();
  });

  it('resolves OVERDUE_MAINTENANCE when the plan is deleted, for that plan only', async () => {
    await service.remove('plan-1', actor);

    expectResolved();
    expect(notificationsService.resolveActive).toHaveBeenCalledTimes(1);
  });

  it('locks the plan row so it serializes with the scheduler', async () => {
    await service.update('plan-1', { active: false } as any, actor);

    expect(manager.findOne).toHaveBeenCalledWith(
      MaintenancePlan,
      expect.objectContaining({ lock: { mode: 'pessimistic_write' } }),
    );
  });

  it('does nothing for a missing plan', async () => {
    manager.findOne.mockResolvedValue(null);

    await expect(service.remove('nope', actor)).rejects.toThrow(
      NotFoundException,
    );
    expect(notificationsService.resolveActive).not.toHaveBeenCalled();
  });

  it('propagates a reconciliation failure so the transaction aborts', async () => {
    notificationsService.resolveActive.mockRejectedValue(new Error('db down'));

    await expect(service.remove('plan-1', actor)).rejects.toThrow('db down');
    expect(auditService.record).not.toHaveBeenCalled();
  });
});
