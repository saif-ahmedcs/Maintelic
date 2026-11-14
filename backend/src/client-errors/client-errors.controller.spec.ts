import { RoleName } from '../users/entities/role.entity';
import { RequestUser } from '../auth/interfaces/request-user.interface';
import { ClientErrorsController } from './client-errors.controller';
import { CreateClientErrorDto } from './dto/create-client-error.dto';

describe('ClientErrorsController', () => {
  let controller: ClientErrorsController;
  let clientErrorsService: { record: jest.Mock };

  const reporter: RequestUser = {
    id: 'user-1',
    email: 'reporter@example.com',
    roles: [RoleName.TECHNICIAN],
  };

  const dto: CreateClientErrorDto = {
    message: 'TypeError: Cannot read properties of undefined',
    stack: 'TypeError: ...\n  at Component (App.tsx:42:7)',
    route: '/app/assets/123',
    requestId: 'c6e167e5-1234-4a5a-9a5a-000000000000',
    appVersion: '1.4.2',
  };

  beforeEach(() => {
    clientErrorsService = { record: jest.fn() };
    controller = new ClientErrorsController(clientErrorsService as any);
  });

  it('delegates the report and the authenticated reporter to the service unchanged', () => {
    const result = controller.report(dto, reporter);

    expect(clientErrorsService.record).toHaveBeenCalledWith(dto, reporter);
    expect(clientErrorsService.record).toHaveBeenCalledTimes(1);
    expect(result).toBeUndefined();
  });

  it('returns nothing to serialize, matching the @HttpCode(204) response', () => {
    const result = controller.report(
      { ...dto, stack: undefined, requestId: undefined },
      reporter,
    );

    expect(result).toBeUndefined();
    expect(clientErrorsService.record).toHaveBeenCalledWith(
      { ...dto, stack: undefined, requestId: undefined },
      reporter,
    );
  });
});
