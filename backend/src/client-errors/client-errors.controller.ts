import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  ApiBearerAuth,
  ApiNoContentResponse,
  ApiOperation,
  ApiTags,
  ApiTooManyRequestsResponse,
} from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { RequestUser } from '../auth/interfaces/request-user.interface';
import { ClientErrorsService } from './client-errors.service';
import { CLIENT_ERROR_THROTTLE } from './client-errors-rate-limit';
import { CreateClientErrorDto } from './dto/create-client-error.dto';

@ApiTags('client-errors')
@Controller('client-errors')
export class ClientErrorsController {
  constructor(private readonly clientErrorsService: ClientErrorsService) {}

  @Post()
  @HttpCode(HttpStatus.NO_CONTENT)
  @Throttle({ default: CLIENT_ERROR_THROTTLE })
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Report a frontend error for observability (Phase 27)',
    description:
      'Writes a single structured log line; nothing is stored in the database. Throttled to 20 requests per minute per user.',
  })
  @ApiNoContentResponse({ description: 'Logged' })
  @ApiTooManyRequestsResponse({ description: 'Throttle limit exceeded' })
  report(
    @Body() dto: CreateClientErrorDto,
    @CurrentUser() reporter: RequestUser,
  ): void {
    this.clientErrorsService.record(dto, reporter);
  }
}
