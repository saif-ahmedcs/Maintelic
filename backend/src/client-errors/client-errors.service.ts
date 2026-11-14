import { Injectable, Logger } from '@nestjs/common';
import type { RequestUser } from '../auth/interfaces/request-user.interface';
import { CreateClientErrorDto } from './dto/create-client-error.dto';

@Injectable()
export class ClientErrorsService {
  private readonly logger = new Logger(ClientErrorsService.name);

  record(report: CreateClientErrorDto, reporter: RequestUser): void {
    this.logger.warn(
      `Client error reported: ${JSON.stringify({
        userId: reporter.id,
        message: report.message,
        stack: report.stack,
        route: report.route,
        requestId: report.requestId,
        appVersion: report.appVersion,
      })}`,
    );
  }
}
