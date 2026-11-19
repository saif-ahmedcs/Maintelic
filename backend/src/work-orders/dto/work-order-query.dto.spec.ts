import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { WorkOrderQueryDto } from './work-order-query.dto';

const validAssetId = 'd57d9ca9-0d4a-4151-ad92-88c8ab13b930';
const validPlanId = '11111111-1111-1111-a111-111111111111';

async function invalidFields(
  plain: Record<string, unknown>,
): Promise<string[]> {
  const dto = plainToInstance(WorkOrderQueryDto, plain);
  const errors = await validate(dto, {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
  return errors.map((e) => e.property);
}

describe('WorkOrderQueryDto', () => {
  it('accepts a query with no filters', async () => {
    expect(await invalidFields({})).toEqual([]);
  });

  it('accepts a valid maintenancePlanId', async () => {
    expect(await invalidFields({ maintenancePlanId: validPlanId })).toEqual([]);
  });

  it.each(['not-a-uuid', '123', ''])(
    'rejects the malformed maintenancePlanId %p',
    async (maintenancePlanId) => {
      expect(await invalidFields({ maintenancePlanId })).toEqual([
        'maintenancePlanId',
      ]);
    },
  );

  it('accepts maintenancePlanId alongside the existing assetId, status, and source filters', async () => {
    expect(
      await invalidFields({
        assetId: validAssetId,
        status: 'COMPLETED',
        source: 'PLANNED',
        maintenancePlanId: validPlanId,
      }),
    ).toEqual([]);
  });

  it('still validates the inherited pagination fields alongside maintenancePlanId', async () => {
    expect(
      await invalidFields({ maintenancePlanId: validPlanId, page: 0 }),
    ).toEqual(['page']);
  });

  it('rejects unknown query parameters', async () => {
    expect(await invalidFields({ unknown: 'x' })).toEqual(['unknown']);
  });
});
