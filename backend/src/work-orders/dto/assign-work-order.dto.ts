import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsUUID } from 'class-validator';

export class AssignWorkOrderDto {
  @ApiPropertyOptional({
    description:
      'Defaults to the caller if omitted. Must be an active user holding ADMIN, SUPERVISOR or TECHNICIAN.',
  })
  @IsOptional()
  @IsUUID()
  assignedToUserId?: string;
}
