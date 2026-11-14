import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  CLIENT_ERROR_FIELD_LIMITS,
  CreateClientErrorDto,
} from './create-client-error.dto';

const validReport = {
  message: 'TypeError: Cannot read properties of undefined',
  stack: 'TypeError: ...\n  at Component (App.tsx:42:7)',
  route: '/app/assets/123',
  requestId: 'c6e167e5-1234-4a5a-9a5a-000000000000',
  appVersion: '1.4.2',
};

async function invalidFields(
  overrides: Record<string, unknown>,
): Promise<string[]> {
  const dto = plainToInstance(CreateClientErrorDto, {
    ...validReport,
    ...overrides,
  });
  const errors = await validate(dto, {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
  return errors.map((e) => e.property);
}

describe('CreateClientErrorDto', () => {
  it('accepts a fully populated report', async () => {
    expect(await invalidFields({})).toEqual([]);
  });

  it('accepts a report with no stack or requestId — not every client error has either', async () => {
    const { stack, requestId, ...withoutOptionalFields } = validReport;
    void stack;
    void requestId;
    expect(await invalidFields(withoutOptionalFields)).toEqual([]);
  });

  it.each(
    Object.entries(CLIENT_ERROR_FIELD_LIMITS) as [
      keyof typeof CLIENT_ERROR_FIELD_LIMITS,
      number,
    ][],
  )('accepts %s exactly at its %i-character limit', async (field, limit) => {
    expect(
      await invalidFields({ [field]: 'x'.repeat(limit) }),
    ).toEqual([]);
  });

  it.each(
    Object.entries(CLIENT_ERROR_FIELD_LIMITS) as [
      keyof typeof CLIENT_ERROR_FIELD_LIMITS,
      number,
    ][],
  )('rejects %s one character past its limit', async (field, limit) => {
    expect(
      await invalidFields({ [field]: 'x'.repeat(limit + 1) }),
    ).toEqual([field]);
  });

  it.each(['message', 'route', 'appVersion'] as const)(
    'rejects a non-string %s',
    async (field) => {
      expect(await invalidFields({ [field]: 12345 })).toEqual([field]);
    },
  );

  it('rejects unknown extra fields', async () => {
    expect(await invalidFields({ userAgent: 'Mozilla/5.0' })).toEqual([
      'userAgent',
    ]);
  });
});
