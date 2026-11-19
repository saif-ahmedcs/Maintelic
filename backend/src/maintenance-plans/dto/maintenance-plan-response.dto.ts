import { ApiProperty } from '@nestjs/swagger';
import { MaintenancePlan } from '../entities/maintenance-plan.entity';
import { MaintenanceTask } from '../entities/maintenance-task.entity';

export class MaintenanceTaskResponseDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  description: string;

  @ApiProperty({ description: 'Display order within the plan, ascending' })
  orderIndex: number;

  static fromEntity(task: MaintenanceTask): MaintenanceTaskResponseDto {
    const dto = new MaintenanceTaskResponseDto();
    dto.id = task.id;
    dto.description = task.description;
    dto.orderIndex = task.orderIndex;
    return dto;
  }
}

export class MaintenancePlanResponseDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  assetId: string;

  @ApiProperty()
  name: string;

  @ApiProperty({ description: 'Days between completions' })
  intervalDays: number;

  @ApiProperty({ nullable: true })
  lastCompletedAt: Date | null;

  @ApiProperty({ nullable: true })
  nextDueAt: Date | null;

  @ApiProperty()
  active: boolean;

  @ApiProperty({
    type: () => MaintenanceTaskResponseDto,
    isArray: true,
    required: false,
    description:
      'Ordered tasks for this plan (orderIndex ascending). Only populated ' +
      'on GET /maintenance-plans/:id; omitted from list and /due responses.',
  })
  tasks?: MaintenanceTaskResponseDto[];

  static fromEntity(
    plan: MaintenancePlan,
    tasks?: MaintenanceTask[],
  ): MaintenancePlanResponseDto {
    const dto = new MaintenancePlanResponseDto();
    dto.id = plan.id;
    dto.assetId = plan.assetId;
    dto.name = plan.name;
    dto.intervalDays = plan.intervalDays;
    dto.lastCompletedAt = plan.lastCompletedAt;
    dto.nextDueAt = plan.nextDueAt;
    dto.active = plan.active;
    if (tasks) {
      dto.tasks = tasks.map((task) =>
        MaintenanceTaskResponseDto.fromEntity(task),
      );
    }
    return dto;
  }
}
