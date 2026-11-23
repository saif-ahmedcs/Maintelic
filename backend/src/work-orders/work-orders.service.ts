import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { Asset, AssetStatus } from '../assets/entities/asset.entity';
import { AuditService } from '../audit/audit.service';
import { RequestUser } from '../auth/interfaces/request-user.interface';
import { daysFromNow } from '../common/utils/date.util';
import { paginate, PaginatedResult } from '../common/pagination/paginate';
import { InventoryService } from '../inventory/inventory.service';
import { AssetHistoryService } from '../asset-history/asset-history.service';
import { MaintenancePlan } from '../maintenance-plans/entities/maintenance-plan.entity';
import { NotificationType } from '../notifications/entities/notification.entity';
import { NotificationsService } from '../notifications/notifications.service';
import { RoleName } from '../users/entities/role.entity';
import { User } from '../users/entities/user.entity';
import { hasWorkOrderAssigneeRole } from '../users/work-order-eligibility';
import { AssignWorkOrderDto } from './dto/assign-work-order.dto';
import { BlockWorkOrderDto } from './dto/block-work-order.dto';
import { CompleteWorkOrderDto } from './dto/complete-work-order.dto';
import { CreateWorkOrderDto } from './dto/create-work-order.dto';
import { WorkOrderQueryDto } from './dto/work-order-query.dto';
import { WorkOrderPart } from './entities/work-order-part.entity';
import {
  WorkOrder,
  WorkOrderPriority,
  WorkOrderSource,
  WorkOrderStatus,
} from './entities/work-order.entity';
import { assertValidWorkOrderTransition } from './work-order-lifecycle';

const ASSIGNABLE_STATUSES: WorkOrderStatus[] = [
  WorkOrderStatus.OPEN,
  WorkOrderStatus.ASSIGNED,
];

const PRIVILEGED_ASSIGNABLE_STATUSES: WorkOrderStatus[] = [
  ...ASSIGNABLE_STATUSES,
  WorkOrderStatus.IN_PROGRESS,
  WorkOrderStatus.BLOCKED,
];

const SORTABLE_FIELDS = [
  'workOrder.openedAt',
  'workOrder.status',
  'workOrder.priority',
];

@Injectable()
export class WorkOrdersService {
  constructor(
    @InjectRepository(WorkOrder)
    private readonly workOrderRepo: Repository<WorkOrder>,
    private readonly dataSource: DataSource,
    private readonly auditService: AuditService,
    private readonly inventoryService: InventoryService,
    private readonly assetHistoryService: AssetHistoryService,
    private readonly notificationsService: NotificationsService,
  ) {}

  private isPrivileged(actor: RequestUser): boolean {
    return (
      actor.roles.includes(RoleName.ADMIN) ||
      actor.roles.includes(RoleName.SUPERVISOR)
    );
  }

  private async lockWorkOrder(
    manager: EntityManager,
    id: string,
  ): Promise<WorkOrder> {
    const workOrder = await manager
      .createQueryBuilder(WorkOrder, 'workOrder')
      .setLock('pessimistic_write')
      .where('workOrder.id = :id', { id })
      .getOne();

    if (!workOrder) {
      throw new NotFoundException(`Work order ${id} not found`);
    }
    return workOrder;
  }

  private async lockAsset(
    manager: EntityManager,
    assetId: string,
  ): Promise<Asset> {
    const asset = await manager
      .createQueryBuilder(Asset, 'asset')
      .setLock('pessimistic_write')
      .where('asset.id = :id', { id: assetId })
      .getOne();

    if (!asset) {
      throw new NotFoundException(`Asset ${assetId} not found`);
    }
    return asset;
  }

  private async reconcileCriticalAssetNotification(
    manager: EntityManager,
    asset: Asset,
  ): Promise<void> {
    if (asset.status === AssetStatus.CRITICAL) {
      return;
    }
    await this.notificationsService.resolveActive(
      manager,
      NotificationType.CRITICAL_ASSET,
      'Asset',
      asset.id,
    );
  }

  async findAll(query: WorkOrderQueryDto): Promise<PaginatedResult<WorkOrder>> {
    const qb = this.workOrderRepo.createQueryBuilder('workOrder');
    if (query.assetId) {
      qb.andWhere('workOrder.assetId = :assetId', { assetId: query.assetId });
    }
    if (query.status) {
      qb.andWhere('workOrder.status = :status', { status: query.status });
    }
    if (query.source) {
      qb.andWhere('workOrder.source = :source', { source: query.source });
    }
    if (query.maintenancePlanId) {
      qb.andWhere('workOrder.maintenancePlanId = :maintenancePlanId', {
        maintenancePlanId: query.maintenancePlanId,
      });
    }
    return paginate(qb, query, {
      defaultSortBy: 'workOrder.openedAt',
      allowedSortFields: SORTABLE_FIELDS,
    });
  }

  async findOne(id: string): Promise<WorkOrder> {
    const workOrder = await this.workOrderRepo.findOne({
      where: { id },
      relations: { workOrderParts: true },
    });
    if (!workOrder) {
      throw new NotFoundException(`Work order ${id} not found`);
    }
    return workOrder;
  }

  async create(
    dto: CreateWorkOrderDto,
    actor: RequestUser,
  ): Promise<WorkOrder> {
    return this.dataSource.transaction(async (manager) => {
      // Locked so a concurrent decommission cannot land between this check
      // and the insert.
      const asset = await this.lockAsset(manager, dto.assetId);
      if (asset.status === AssetStatus.DECOMMISSIONED) {
        throw new ConflictException(
          `Asset ${dto.assetId} is decommissioned; work orders cannot be created for it`,
        );
      }

      let source = WorkOrderSource.MANUAL;
      let maintenancePlanId: string | null = null;

      if (dto.maintenancePlanId) {
        const plan = await manager.findOneBy(MaintenancePlan, {
          id: dto.maintenancePlanId,
        });
        if (!plan) {
          throw new NotFoundException(
            `Maintenance plan ${dto.maintenancePlanId} not found`,
          );
        }
        if (plan.assetId !== dto.assetId) {
          throw new ConflictException(
            `Maintenance plan ${plan.id} belongs to a different asset than ${dto.assetId}`,
          );
        }
        source = WorkOrderSource.PLANNED;
        maintenancePlanId = plan.id;
      }

      const workOrder = manager.create(WorkOrder, {
        assetId: dto.assetId,
        maintenancePlanId,
        status: WorkOrderStatus.OPEN,
        source,
        priority: dto.priority ?? WorkOrderPriority.MEDIUM,
        description: dto.description,
      });
      const saved = await manager.save(workOrder);

      await this.auditService.record(manager, {
        actorUserId: actor.id,
        entityType: 'WorkOrder',
        entityId: saved.id,
        action: 'CREATE',
        before: null,
        after: {
          assetId: saved.assetId,
          maintenancePlanId: saved.maintenancePlanId,
          status: saved.status,
          source: saved.source,
          priority: saved.priority,
        },
        source: 'manual',
      });

      return saved;
    });
  }

  async assign(
    id: string,
    dto: AssignWorkOrderDto,
    actor: RequestUser,
  ): Promise<WorkOrder> {
    return this.dataSource.transaction(async (manager) => {
      const targetUserId = dto.assignedToUserId ?? actor.id;

      const targetUser = await manager.findOne(User, {
        where: { id: targetUserId },
        lock: { mode: 'pessimistic_read', tables: ['users'] },
      });

      const workOrder = await this.lockWorkOrder(manager, id);

      const privileged = this.isPrivileged(actor);
      if (targetUserId !== actor.id && !privileged) {
        throw new ForbiddenException(
          'Only admins or supervisors can assign a work order to someone else',
        );
      }

      const assignableStatuses = privileged
        ? PRIVILEGED_ASSIGNABLE_STATUSES
        : ASSIGNABLE_STATUSES;
      if (!assignableStatuses.includes(workOrder.status)) {
        throw new ConflictException(
          `Cannot assign a work order in status ${workOrder.status}`,
        );
      }

      if (
        workOrder.assignedToUserId &&
        workOrder.assignedToUserId !== actor.id &&
        !privileged
      ) {
        throw new ForbiddenException(
          'Work order is already assigned to another user',
        );
      }

      if (!targetUser) {
        throw new NotFoundException(`User ${targetUserId} not found`);
      }
      if (!targetUser.isActive) {
        throw new ConflictException(
          `User ${targetUserId} is deactivated and cannot be assigned work orders`,
        );
      }
      if (!hasWorkOrderAssigneeRole(targetUser.roles)) {
        throw new ConflictException(
          `User ${targetUserId} has no role that can work on work orders (requires ADMIN, SUPERVISOR or TECHNICIAN)`,
        );
      }

      const before = {
        status: workOrder.status,
        assignedToUserId: workOrder.assignedToUserId,
      };

      if (workOrder.status === WorkOrderStatus.OPEN) {
        assertValidWorkOrderTransition(
          workOrder.status,
          WorkOrderStatus.ASSIGNED,
        );
        workOrder.status = WorkOrderStatus.ASSIGNED;
      }
      if (
        before.status === WorkOrderStatus.OPEN ||
        workOrder.assignedToUserId !== targetUserId
      ) {
        workOrder.assignedAt = new Date();
      }
      workOrder.assignedToUserId = targetUserId;

      const saved = await manager.save(workOrder);

      await this.auditService.record(manager, {
        actorUserId: actor.id,
        entityType: 'WorkOrder',
        entityId: saved.id,
        action: 'ASSIGN',
        before,
        after: {
          status: saved.status,
          assignedToUserId: saved.assignedToUserId,
        },
        source: 'manual',
      });

      return saved;
    });
  }

  async start(id: string, actor: RequestUser): Promise<WorkOrder> {
    return this.dataSource.transaction(async (manager) => {
      const workOrder = await this.lockWorkOrder(manager, id);

      if (
        workOrder.assignedToUserId !== actor.id &&
        !this.isPrivileged(actor)
      ) {
        throw new ForbiddenException(
          'Only the assigned technician, a supervisor, or an admin can start this work order',
        );
      }

      assertValidWorkOrderTransition(
        workOrder.status,
        WorkOrderStatus.IN_PROGRESS,
      );

      const before = { status: workOrder.status };
      workOrder.status = WorkOrderStatus.IN_PROGRESS;
      workOrder.startedAt = new Date();
      workOrder.blockReason = null;
      const saved = await manager.save(workOrder);

      await this.auditService.record(manager, {
        actorUserId: actor.id,
        entityType: 'WorkOrder',
        entityId: saved.id,
        action: 'START',
        before,
        after: { status: saved.status },
        source: 'manual',
      });

      return saved;
    });
  }

  async block(
    id: string,
    dto: BlockWorkOrderDto,
    actor: RequestUser,
  ): Promise<WorkOrder> {
    return this.dataSource.transaction(async (manager) => {
      const workOrder = await this.lockWorkOrder(manager, id);

      if (
        workOrder.assignedToUserId !== actor.id &&
        !this.isPrivileged(actor)
      ) {
        throw new ForbiddenException(
          'Only the assigned technician, a supervisor, or an admin can block this work order',
        );
      }

      assertValidWorkOrderTransition(workOrder.status, WorkOrderStatus.BLOCKED);

      const before = {
        status: workOrder.status,
        blockReason: workOrder.blockReason,
      };
      workOrder.status = WorkOrderStatus.BLOCKED;
      workOrder.blockReason = dto.reason;
      const saved = await manager.save(workOrder);

      await this.auditService.record(manager, {
        actorUserId: actor.id,
        entityType: 'WorkOrder',
        entityId: saved.id,
        action: 'BLOCK',
        before,
        after: { status: saved.status, blockReason: saved.blockReason },
        source: 'manual',
      });

      return saved;
    });
  }

  async cancel(id: string, actor: RequestUser): Promise<WorkOrder> {
    return this.dataSource.transaction(async (manager) => {
      const workOrder = await this.lockWorkOrder(manager, id);

      assertValidWorkOrderTransition(
        workOrder.status,
        WorkOrderStatus.CANCELLED,
      );

      const before = { status: workOrder.status };
      workOrder.status = WorkOrderStatus.CANCELLED;
      workOrder.cancelledAt = new Date();
      const saved = await manager.save(workOrder);

      const asset = await this.lockAsset(manager, saved.assetId);
      await this.reconcileCriticalAssetNotification(manager, asset);

      await this.auditService.record(manager, {
        actorUserId: actor.id,
        entityType: 'WorkOrder',
        entityId: saved.id,
        action: 'CANCEL',
        before,
        after: { status: saved.status },
        source: 'manual',
      });

      return saved;
    });
  }

  async complete(
    id: string,
    dto: CompleteWorkOrderDto,
    actor: RequestUser,
  ): Promise<WorkOrder> {
    return this.dataSource.transaction(async (manager) => {
      const workOrder = await this.lockWorkOrder(manager, id);

      if (
        workOrder.assignedToUserId !== actor.id &&
        !this.isPrivileged(actor)
      ) {
        throw new ForbiddenException(
          'Only the assigned technician, a supervisor, or an admin can complete this work order',
        );
      }

      assertValidWorkOrderTransition(
        workOrder.status,
        WorkOrderStatus.COMPLETED,
      );

      const before = { status: workOrder.status };
      const parts = dto.parts ?? [];
      const createdParts: WorkOrderPart[] = [];
      let totalCost = 0;

      for (const part of parts) {
        const { sparePart } = await this.inventoryService.consume(
          manager,
          part.sparePartId,
          part.quantityUsed,
          { workOrderId: workOrder.id, createdByUserId: actor.id },
        );

        const workOrderPart = manager.create(WorkOrderPart, {
          workOrderId: workOrder.id,
          sparePartId: sparePart.id,
          quantityUsed: part.quantityUsed,
          unitCostAtCompletion: sparePart.unitCost,
        });
        createdParts.push(await manager.save(workOrderPart));

        totalCost += sparePart.unitCost * part.quantityUsed;
      }

      workOrder.status = WorkOrderStatus.COMPLETED;
      workOrder.completedAt = new Date();
      workOrder.totalCost = Math.round(totalCost * 100) / 100;
      const savedWorkOrder = await manager.save(workOrder);
      savedWorkOrder.workOrderParts = createdParts;

      const asset = await this.lockAsset(manager, workOrder.assetId);
      const assetStatusBefore = asset.status;
      const assetStatusChanged =
        assetStatusBefore !== AssetStatus.OPERATIONAL &&
        assetStatusBefore !== AssetStatus.DECOMMISSIONED;
      let savedAsset = asset;
      if (assetStatusChanged) {
        asset.status = AssetStatus.OPERATIONAL;
        savedAsset = await manager.save(asset);
      }
      await this.reconcileCriticalAssetNotification(manager, savedAsset);

      if (workOrder.maintenancePlanId) {
        const plan = await manager.findOne(MaintenancePlan, {
          where: { id: workOrder.maintenancePlanId },
          lock: { mode: 'pessimistic_write' },
        });
        if (plan) {
          plan.lastCompletedAt = new Date();
          plan.nextDueAt = daysFromNow(plan.intervalDays);
          await manager.save(plan);

          if (plan.nextDueAt && plan.nextDueAt > new Date()) {
            await this.notificationsService.resolveActive(
              manager,
              NotificationType.OVERDUE_MAINTENANCE,
              'MaintenancePlan',
              plan.id,
            );
          }
        }
      }

      await this.auditService.record(manager, {
        actorUserId: actor.id,
        entityType: 'WorkOrder',
        entityId: savedWorkOrder.id,
        action: 'COMPLETE',
        before,
        after: {
          status: savedWorkOrder.status,
          totalCost: savedWorkOrder.totalCost,
        },
        source: 'manual',
      });

      if (assetStatusChanged) {
        await this.auditService.record(manager, {
          actorUserId: actor.id,
          entityType: 'Asset',
          entityId: savedAsset.id,
          action: 'STATUS_CHANGE',
          before: { status: assetStatusBefore },
          after: { status: savedAsset.status },
          source: 'work-order-completion',
        });

        await this.assetHistoryService.record(manager, {
          assetId: savedAsset.id,
          previousStatus: assetStatusBefore,
          newStatus: savedAsset.status,
          changedByUserId: actor.id,
          source: 'work-order-completion',
        });
      }

      return savedWorkOrder;
    });
  }
}
