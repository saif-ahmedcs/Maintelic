import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { Asset, AssetStatus } from '../assets/entities/asset.entity';
import { AuditService } from '../audit/audit.service';
import { NotificationType } from '../notifications/entities/notification.entity';
import { NotificationsService } from '../notifications/notifications.service';
import { RequestUser } from '../auth/interfaces/request-user.interface';
import { paginate, PaginatedResult } from '../common/pagination/paginate';
import { PaginationQueryDto } from '../common/pagination/pagination-query.dto';
import { CreateMaintenancePlanDto } from './dto/create-maintenance-plan.dto';
import { MaintenancePlanQueryDto } from './dto/maintenance-plan-query.dto';
import { UpdateMaintenancePlanDto } from './dto/update-maintenance-plan.dto';
import { MaintenancePlan } from './entities/maintenance-plan.entity';
import { MaintenanceTask } from './entities/maintenance-task.entity';
import { daysFromNow } from '../common/utils/date.util';

const SORTABLE_FIELDS = ['plan.name', 'plan.nextDueAt', 'plan.intervalDays'];

@Injectable()
export class MaintenancePlansService {
  constructor(
    @InjectRepository(MaintenancePlan)
    private readonly planRepo: Repository<MaintenancePlan>,
    @InjectRepository(MaintenanceTask)
    private readonly taskRepo: Repository<MaintenanceTask>,
    private readonly dataSource: DataSource,
    private readonly auditService: AuditService,
    private readonly notificationsService: NotificationsService,
  ) {}

  async findAll(
    query: MaintenancePlanQueryDto,
  ): Promise<PaginatedResult<MaintenancePlan>> {
    const qb = this.planRepo.createQueryBuilder('plan');
    if (query.assetId) {
      qb.andWhere('plan.assetId = :assetId', { assetId: query.assetId });
    }
    return paginate(qb, query, {
      defaultSortBy: 'plan.name',
      allowedSortFields: SORTABLE_FIELDS,
    });
  }

  async findDue(
    query: PaginationQueryDto,
  ): Promise<PaginatedResult<MaintenancePlan>> {
    const { page, limit } = query;
    const qb = this.planRepo
      .createQueryBuilder('plan')
      .innerJoin('plan.asset', 'asset')
      .where('plan.active = :active', { active: true })
      .andWhere('asset.status <> :decommissioned', {
        decommissioned: AssetStatus.DECOMMISSIONED,
      })
      .andWhere('plan.nextDueAt <= :now', { now: new Date() })
      .orderBy('plan.nextDueAt', 'ASC')
      .skip((page - 1) * limit)
      .take(limit);

    const [data, total] = await qb.getManyAndCount();
    return {
      data,
      meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }

  async findAllDue(): Promise<MaintenancePlan[]> {
    return this.planRepo
      .createQueryBuilder('plan')
      .innerJoin('plan.asset', 'asset')
      .where('plan.active = :active', { active: true })
      .andWhere('asset.status <> :decommissioned', {
        decommissioned: AssetStatus.DECOMMISSIONED,
      })
      .andWhere('plan.nextDueAt <= :now', { now: new Date() })
      .orderBy('plan.nextDueAt', 'ASC')
      .getMany();
  }

  async findOne(id: string): Promise<MaintenancePlan> {
    const plan = await this.planRepo.findOneBy({ id });
    if (!plan) {
      throw new NotFoundException(`Maintenance plan ${id} not found`);
    }
    return plan;
  }

  async findTasksForPlan(planId: string): Promise<MaintenanceTask[]> {
    return this.taskRepo.find({
      where: { planId },
      order: { orderIndex: 'ASC' },
    });
  }

  async create(
    dto: CreateMaintenancePlanDto,
    actor: RequestUser,
  ): Promise<MaintenancePlan> {
    return this.dataSource.transaction(async (manager) => {
      const asset = await manager.findOne(Asset, {
        where: { id: dto.assetId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!asset) {
        throw new NotFoundException(`Asset ${dto.assetId} not found`);
      }
      if (asset.status === AssetStatus.DECOMMISSIONED) {
        throw new ConflictException(
          `Asset ${dto.assetId} is decommissioned; maintenance plans cannot be created for it`,
        );
      }

      const plan = manager.create(MaintenancePlan, {
        assetId: dto.assetId,
        name: dto.name,
        intervalDays: dto.intervalDays,
        nextDueAt: dto.nextDueAt
          ? new Date(dto.nextDueAt)
          : daysFromNow(dto.intervalDays),
        lastCompletedAt: null,
        active: dto.active ?? true,
      });
      const saved = await manager.save(plan);

      await this.auditService.record(manager, {
        actorUserId: actor.id,
        entityType: 'MaintenancePlan',
        entityId: saved.id,
        action: 'CREATE',
        before: null,
        after: {
          assetId: saved.assetId,
          name: saved.name,
          intervalDays: saved.intervalDays,
          nextDueAt: saved.nextDueAt,
          active: saved.active,
        },
        source: 'manual',
      });

      return saved;
    });
  }

  async update(
    id: string,
    dto: UpdateMaintenancePlanDto,
    actor: RequestUser,
  ): Promise<MaintenancePlan> {
    return this.dataSource.transaction(async (manager) => {
      const plan = await manager.findOne(MaintenancePlan, {
        where: { id },
        lock: { mode: 'pessimistic_write' },
      });
      if (!plan) {
        throw new NotFoundException(`Maintenance plan ${id} not found`);
      }

      if (dto.active === true && !plan.active) {
        const asset = await manager.findOneBy(Asset, { id: plan.assetId });
        if (asset?.status === AssetStatus.DECOMMISSIONED) {
          throw new ConflictException(
            `Asset ${plan.assetId} is decommissioned; its maintenance plans cannot be reactivated`,
          );
        }
      }

      const before = {
        name: plan.name,
        intervalDays: plan.intervalDays,
        nextDueAt: plan.nextDueAt,
        active: plan.active,
      };

      if (dto.name !== undefined) plan.name = dto.name;
      if (dto.intervalDays !== undefined) plan.intervalDays = dto.intervalDays;
      if (dto.nextDueAt !== undefined) plan.nextDueAt = new Date(dto.nextDueAt);
      if (dto.active !== undefined) plan.active = dto.active;

      const saved = await manager.save(plan);

      if (dto.active !== undefined || dto.nextDueAt !== undefined) {
        const stillOverdue =
          saved.active && !!saved.nextDueAt && saved.nextDueAt <= new Date();
        if (!stillOverdue) {
          await this.notificationsService.resolveActive(
            manager,
            NotificationType.OVERDUE_MAINTENANCE,
            'MaintenancePlan',
            saved.id,
          );
        }
      }

      await this.auditService.record(manager, {
        actorUserId: actor.id,
        entityType: 'MaintenancePlan',
        entityId: saved.id,
        action: 'UPDATE',
        before,
        after: {
          name: saved.name,
          intervalDays: saved.intervalDays,
          nextDueAt: saved.nextDueAt,
          active: saved.active,
        },
        source: 'manual',
      });

      return saved;
    });
  }

  async deactivateForAsset(
    manager: EntityManager,
    assetId: string,
    actor: RequestUser | null,
    source: string,
  ): Promise<number> {
    const plans = await manager.find(MaintenancePlan, {
      where: { assetId },
      order: { id: 'ASC' },
      lock: { mode: 'pessimistic_write' },
    });

    let deactivated = 0;
    for (const plan of plans) {
      if (plan.active) {
        plan.active = false;
        await manager.save(plan);
        deactivated += 1;

        await this.auditService.record(manager, {
          actorUserId: actor?.id ?? null,
          entityType: 'MaintenancePlan',
          entityId: plan.id,
          action: 'UPDATE',
          before: { active: true },
          after: { active: false },
          source,
        });
      }

      await this.notificationsService.resolveActive(
        manager,
        NotificationType.OVERDUE_MAINTENANCE,
        'MaintenancePlan',
        plan.id,
      );
    }
    return deactivated;
  }

  async remove(id: string, actor: RequestUser): Promise<void> {
    return this.dataSource.transaction(async (manager) => {
      const plan = await manager.findOne(MaintenancePlan, {
        where: { id },
        lock: { mode: 'pessimistic_write' },
      });
      if (!plan) {
        throw new NotFoundException(`Maintenance plan ${id} not found`);
      }

      await manager.remove(plan);

      await this.notificationsService.resolveActive(
        manager,
        NotificationType.OVERDUE_MAINTENANCE,
        'MaintenancePlan',
        id,
      );

      await this.auditService.record(manager, {
        actorUserId: actor.id,
        entityType: 'MaintenancePlan',
        entityId: id,
        action: 'DELETE',
        before: {
          assetId: plan.assetId,
          name: plan.name,
          intervalDays: plan.intervalDays,
        },
        after: null,
        source: 'manual',
      });
    });
  }
}
