import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, In, Repository } from 'typeorm';
import { AssetType } from '../asset-types/entities/asset-type.entity';
import { AuditService } from '../audit/audit.service';
import { AssetHistoryService } from '../asset-history/asset-history.service';
import { NotificationType } from '../notifications/entities/notification.entity';
import { NotificationsService } from '../notifications/notifications.service';
import { RequestUser } from '../auth/interfaces/request-user.interface';
import { paginate, PaginatedResult } from '../common/pagination/paginate';
import { Location } from '../locations/entities/location.entity';
import { MaintenancePlansService } from '../maintenance-plans/maintenance-plans.service';
import {
  WorkOrder,
  WorkOrderStatus,
} from '../work-orders/entities/work-order.entity';
import { ACTIVE_WORK_ORDER_STATUSES } from '../work-orders/work-order-lifecycle';
import { AssetQueryDto } from './dto/asset-query.dto';
import { CreateAssetDto } from './dto/create-asset.dto';
import { UpdateAssetDto } from './dto/update-asset.dto';
import { UpdateAssetStatusDto } from './dto/update-asset-status.dto';
import { Asset, AssetStatus } from './entities/asset.entity';

const SORTABLE_FIELDS = ['asset.tag', 'asset.status', 'asset.criticality'];
const DECOMMISSION_SOURCE = 'asset-decommission';

@Injectable()
export class AssetsService {
  constructor(
    @InjectRepository(Asset)
    private readonly assetRepo: Repository<Asset>,
    private readonly dataSource: DataSource,
    private readonly auditService: AuditService,
    private readonly assetHistoryService: AssetHistoryService,
    private readonly notificationsService: NotificationsService,
    private readonly maintenancePlansService: MaintenancePlansService,
  ) {}

  async findAll(query: AssetQueryDto): Promise<PaginatedResult<Asset>> {
    const qb = this.assetRepo.createQueryBuilder('asset');
    if (query.status) {
      qb.andWhere('asset.status = :status', { status: query.status });
    }
    if (query.search) {
      qb.andWhere('asset.tag ILIKE :search', { search: `%${query.search}%` });
    }
    if (query.locationId) {
      qb.andWhere('asset.locationId = :locationId', {
        locationId: query.locationId,
      });
    }
    if (query.assetTypeId) {
      qb.andWhere('asset.assetTypeId = :assetTypeId', {
        assetTypeId: query.assetTypeId,
      });
    }
    return paginate(qb, query, {
      defaultSortBy: 'asset.tag',
      allowedSortFields: SORTABLE_FIELDS,
    });
  }

  async findOne(id: string): Promise<Asset> {
    const asset = await this.assetRepo.findOneBy({ id });
    if (!asset) {
      throw new NotFoundException(`Asset ${id} not found`);
    }
    return asset;
  }

  async create(dto: CreateAssetDto, actor: RequestUser): Promise<Asset> {
    return this.dataSource.transaction(async (manager) => {
      const assetType = await manager.findOneBy(AssetType, {
        id: dto.assetTypeId,
      });
      if (!assetType) {
        throw new NotFoundException(`Asset type ${dto.assetTypeId} not found`);
      }

      const location = await manager.findOneBy(Location, {
        id: dto.locationId,
      });
      if (!location) {
        throw new NotFoundException(`Location ${dto.locationId} not found`);
      }

      const asset = manager.create(Asset, {
        assetTypeId: dto.assetTypeId,
        locationId: dto.locationId,
        tag: dto.tag,
        manufacturer: dto.manufacturer ?? null,
        model: dto.model ?? null,
        criticality: dto.criticality,
        installedAt: dto.installedAt ? new Date(dto.installedAt) : null,
      });
      const saved = await manager.save(asset);

      await this.auditService.record(manager, {
        actorUserId: actor.id,
        entityType: 'Asset',
        entityId: saved.id,
        action: 'CREATE',
        before: null,
        after: {
          assetTypeId: saved.assetTypeId,
          locationId: saved.locationId,
          tag: saved.tag,
          criticality: saved.criticality,
          status: saved.status,
        },
        source: 'manual',
      });

      return saved;
    });
  }

  async update(
    id: string,
    dto: UpdateAssetDto,
    actor: RequestUser,
  ): Promise<Asset> {
    return this.dataSource.transaction(async (manager) => {
      const asset = await manager.findOneBy(Asset, { id });
      if (!asset) {
        throw new NotFoundException(`Asset ${id} not found`);
      }

      if (dto.assetTypeId) {
        const assetType = await manager.findOneBy(AssetType, {
          id: dto.assetTypeId,
        });
        if (!assetType) {
          throw new NotFoundException(
            `Asset type ${dto.assetTypeId} not found`,
          );
        }
      }

      if (dto.locationId) {
        const location = await manager.findOneBy(Location, {
          id: dto.locationId,
        });
        if (!location) {
          throw new NotFoundException(`Location ${dto.locationId} not found`);
        }
      }

      const before = {
        assetTypeId: asset.assetTypeId,
        locationId: asset.locationId,
        tag: asset.tag,
        manufacturer: asset.manufacturer,
        model: asset.model,
        criticality: asset.criticality,
      };

      if (dto.assetTypeId !== undefined) asset.assetTypeId = dto.assetTypeId;
      if (dto.locationId !== undefined) asset.locationId = dto.locationId;
      if (dto.tag !== undefined) asset.tag = dto.tag;
      if (dto.manufacturer !== undefined) {
        asset.manufacturer = dto.manufacturer;
      }
      if (dto.model !== undefined) asset.model = dto.model;
      if (dto.criticality !== undefined) asset.criticality = dto.criticality;
      if (dto.installedAt !== undefined) {
        asset.installedAt = new Date(dto.installedAt);
      }
      const saved = await manager.save(asset);

      await this.auditService.record(manager, {
        actorUserId: actor.id,
        entityType: 'Asset',
        entityId: saved.id,
        action: 'UPDATE',
        before,
        after: {
          assetTypeId: saved.assetTypeId,
          locationId: saved.locationId,
          tag: saved.tag,
          manufacturer: saved.manufacturer,
          model: saved.model,
          criticality: saved.criticality,
        },
        source: 'manual',
      });

      return saved;
    });
  }

  async updateStatus(
    id: string,
    dto: UpdateAssetStatusDto,
    actor: RequestUser,
  ): Promise<Asset> {
    return this.dataSource.transaction(async (manager) => {
      if (dto.status === AssetStatus.DECOMMISSIONED) {
        await this.lockActiveWorkOrders(manager, id);
      }

      const asset = await manager.findOne(Asset, {
        where: { id },
        lock: { mode: 'pessimistic_write' },
      });
      if (!asset) {
        throw new NotFoundException(`Asset ${id} not found`);
      }

      if (asset.status === dto.status) {
        return asset;
      }

      if (asset.status === AssetStatus.DECOMMISSIONED) {
        throw new ConflictException(
          `Asset ${id} is decommissioned and its status cannot be changed`,
        );
      }

      const before = { status: asset.status };
      asset.status = dto.status;
      const saved = await manager.save(asset);

      await this.auditService.record(manager, {
        actorUserId: actor.id,
        entityType: 'Asset',
        entityId: saved.id,
        action: 'STATUS_CHANGE',
        before,
        after: { status: saved.status },
        source: 'manual',
      });

      await this.assetHistoryService.record(manager, {
        assetId: saved.id,
        previousStatus: before.status,
        newStatus: saved.status,
        changedByUserId: actor.id,
        source: 'manual',
      });

      if (
        before.status === AssetStatus.CRITICAL &&
        saved.status !== AssetStatus.CRITICAL
      ) {
        await this.notificationsService.resolveActive(
          manager,
          NotificationType.CRITICAL_ASSET,
          'Asset',
          saved.id,
        );
      }

      if (saved.status === AssetStatus.DECOMMISSIONED) {
        await this.closeOutDecommissionedAsset(manager, saved, actor);
      }

      return saved;
    });
  }

  private lockActiveWorkOrders(
    manager: EntityManager,
    assetId: string,
  ): Promise<WorkOrder[]> {
    return manager.find(WorkOrder, {
      where: { assetId, status: In(ACTIVE_WORK_ORDER_STATUSES) },
      order: { id: 'ASC' },
      lock: { mode: 'pessimistic_write' },
    });
  }

  private async closeOutDecommissionedAsset(
    manager: EntityManager,
    asset: Asset,
    actor: RequestUser,
  ): Promise<void> {
    const openWorkOrders = await this.lockActiveWorkOrders(manager, asset.id);
    const cancelledAt = new Date();
    for (const workOrder of openWorkOrders) {
      const before = { status: workOrder.status };
      workOrder.status = WorkOrderStatus.CANCELLED;
      workOrder.cancelledAt = cancelledAt;
      await manager.save(workOrder);

      await this.auditService.record(manager, {
        actorUserId: actor.id,
        entityType: 'WorkOrder',
        entityId: workOrder.id,
        action: 'CANCEL',
        before,
        after: { status: WorkOrderStatus.CANCELLED },
        source: DECOMMISSION_SOURCE,
      });
    }

    await this.maintenancePlansService.deactivateForAsset(
      manager,
      asset.id,
      actor,
      DECOMMISSION_SOURCE,
    );
  }

  async remove(id: string, actor: RequestUser): Promise<void> {
    return this.dataSource.transaction(async (manager) => {
      const asset = await manager.findOneBy(Asset, { id });
      if (!asset) {
        throw new NotFoundException(`Asset ${id} not found`);
      }

      await manager.remove(asset);

      await this.auditService.record(manager, {
        actorUserId: actor.id,
        entityType: 'Asset',
        entityId: id,
        action: 'DELETE',
        before: {
          assetTypeId: asset.assetTypeId,
          locationId: asset.locationId,
          tag: asset.tag,
        },
        after: null,
        source: 'manual',
      });
    });
  }
}
