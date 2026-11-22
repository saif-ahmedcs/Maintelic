import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, Repository } from 'typeorm';
import { SparePart } from '../inventory/entities/spare-part.entity';
import { MaintenancePlan } from '../maintenance-plans/entities/maintenance-plan.entity';
import { InventoryService } from '../inventory/inventory.service';
import { MaintenancePlansService } from '../maintenance-plans/maintenance-plans.service';
import { NotificationType } from '../notifications/entities/notification.entity';
import { NotificationsService } from '../notifications/notifications.service';
import { WorkOrder } from '../work-orders/entities/work-order.entity';
import { ACTIVE_WORK_ORDER_STATUSES } from './condition-monitoring.service';
import { AiInsightsService } from '../ai-insights/ai-insights.service';
import { Asset } from '../assets/entities/asset.entity';

@Injectable()
export class ScheduledChecksService {
  private readonly logger = new Logger(ScheduledChecksService.name);

  constructor(
    private readonly maintenancePlansService: MaintenancePlansService,
    private readonly inventoryService: InventoryService,
    private readonly notificationsService: NotificationsService,
    private readonly dataSource: DataSource,
    @InjectRepository(WorkOrder)
    private readonly workOrderRepo: Repository<WorkOrder>,
    private readonly aiInsightsService: AiInsightsService,
  ) {}

  @Cron(CronExpression.EVERY_HOUR)
  async checkOverdueMaintenance(): Promise<void> {
    const duePlans = await this.maintenancePlansService.findAllDue();

    for (const plan of duePlans) {
      const hasOpenWorkOrder = await this.workOrderRepo.exists({
        where: {
          maintenancePlanId: plan.id,
          status: In(ACTIVE_WORK_ORDER_STATUSES),
        },
      });
      if (hasOpenWorkOrder) {
        continue;
      }

      const alreadyNotified =
        await this.notificationsService.hasActiveNotification(
          NotificationType.OVERDUE_MAINTENANCE,
          'MaintenancePlan',
          plan.id,
        );
      if (alreadyNotified) {
        continue;
      }

      const asset = await this.dataSource.manager.findOne(Asset, {
        where: { id: plan.assetId },
        relations: { assetType: true },
      });

      const aiNote = await this.aiInsightsService.generate({
        kind: 'OVERDUE_MAINTENANCE',
        asset: asset
          ? {
              tag: asset.tag,
              typeName: asset.assetType?.name ?? null,
              criticality: asset.criticality,
            }
          : null,
        planName: plan.name,
        intervalDays: plan.intervalDays,
        dueAt: plan.nextDueAt,
      });

      await this.dataSource.transaction(async (manager) => {
        const current = await manager
          .createQueryBuilder(MaintenancePlan, 'plan')
          .setLock('pessimistic_write')
          .where('plan.id = :id', { id: plan.id })
          .getOne();
        const stillOverdue =
          !!current &&
          current.active &&
          !!current.nextDueAt &&
          current.nextDueAt <= new Date();
        if (!current || !stillOverdue) {
          return;
        }

        const openWorkOrderNow = await manager.exists(WorkOrder, {
          where: {
            maintenancePlanId: plan.id,
            status: In(ACTIVE_WORK_ORDER_STATUSES),
          },
        });
        if (openWorkOrderNow) {
          return;
        }

        const notifiedNow =
          await this.notificationsService.hasActiveNotification(
            NotificationType.OVERDUE_MAINTENANCE,
            'MaintenancePlan',
            plan.id,
            manager,
          );
        if (notifiedNow) {
          return;
        }

        await this.notificationsService.record(manager, {
          type: NotificationType.OVERDUE_MAINTENANCE,
          relatedEntityType: 'MaintenancePlan',
          relatedEntityId: plan.id,
          message: `Maintenance plan "${current.name}" is overdue (was due ${current.nextDueAt?.toISOString()}).`,
          aiNote,
        });
      });
    }

    if (duePlans.length > 0) {
      this.logger.log(
        `Overdue maintenance check: ${duePlans.length} plan(s) due, notifications reconciled.`,
      );
    }
  }

  @Cron(CronExpression.EVERY_HOUR)
  async checkLowStock(): Promise<void> {
    const lowStockParts = await this.inventoryService.findAllLowStock();

    for (const part of lowStockParts) {
      const alreadyNotified =
        await this.notificationsService.hasActiveNotification(
          NotificationType.LOW_STOCK,
          'SparePart',
          part.id,
        );
      if (alreadyNotified) {
        continue;
      }

      const aiNote = await this.aiInsightsService.generate({
        kind: 'LOW_STOCK',
        partName: part.name,
        sku: part.sku,
        quantityOnHand: part.quantityOnHand,
        reorderThreshold: part.reorderThreshold,
      });

      await this.dataSource.transaction(async (manager) => {
        const current = await manager
          .createQueryBuilder(SparePart, 'part')
          .setLock('pessimistic_write')
          .where('part.id = :id', { id: part.id })
          .getOne();
        if (!current || current.quantityOnHand > current.reorderThreshold) {
          return;
        }

        const notifiedNow =
          await this.notificationsService.hasActiveNotification(
            NotificationType.LOW_STOCK,
            'SparePart',
            part.id,
            manager,
          );
        if (notifiedNow) {
          return;
        }

        await this.notificationsService.record(manager, {
          type: NotificationType.LOW_STOCK,
          relatedEntityType: 'SparePart',
          relatedEntityId: part.id,
          message: `Spare part ${current.sku} (${current.name}) is at or below its reorder threshold: ${current.quantityOnHand}/${current.reorderThreshold}.`,
          aiNote,
        });
      });
    }

    if (lowStockParts.length > 0) {
      this.logger.log(
        `Low-stock check: ${lowStockParts.length} part(s) at/below threshold, notifications reconciled.`,
      );
    }
  }
}
