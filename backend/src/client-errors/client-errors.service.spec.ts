import { Logger } from '@nestjs/common';
import { RoleName } from '../users/entities/role.entity';
import { RequestUser } from '../auth/interfaces/request-user.interface';
import { ClientErrorsService } from './client-errors.service';
import { CreateClientErrorDto } from './dto/create-client-error.dto';

describe('ClientErrorsService', () => {
  let service: ClientErrorsService;
  let warnSpy: jest.SpyInstance;

  const reporter: RequestUser = {
    id: 'user-1',
    email: 'reporter@example.com',
    roles: [RoleName.TECHNICIAN],
  };

  const report: CreateClientErrorDto = {
    message: 'TypeError: Cannot read properties of undefined',
    stack: 'TypeError: ...\n  at Component (App.tsx:42:7)',
    route: '/app/assets/123',
    requestId: 'c6e167e5-1234-4a5a-9a5a-000000000000',
    appVersion: '1.4.2',
  };

  beforeEach(() => {
    warnSpy = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    service = new ClientErrorsService();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('writes exactly one structured warn log line with every field plus the reporting user', () => {
    service.record(report, reporter);

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const [line] = warnSpy.mock.calls[0];
    expect(line).toEqual(expect.stringContaining('Client error reported'));

    const payload = JSON.parse(line.slice(line.indexOf('{')));
    expect(payload).toEqual({
      userId: reporter.id,
      message: report.message,
      stack: report.stack,
      route: report.route,
      requestId: report.requestId,
      appVersion: report.appVersion,
    });
  });

  it('logs undefined for the optional fields when the client omitted them, rather than throwing', () => {
    const { stack, requestId, ...withoutOptionalFields } = report;
    void stack;
    void requestId;

    expect(() =>
      service.record(withoutOptionalFields, reporter),
    ).not.toThrow();

    const [line] = warnSpy.mock.calls[0];
    const payload = JSON.parse(line.slice(line.indexOf('{')));
    expect(payload.stack).toBeUndefined();
    expect(payload.requestId).toBeUndefined();
  });
});
