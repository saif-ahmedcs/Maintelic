import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { ArrayMaxSize, ArrayNotEmpty, IsArray, IsUUID } from 'class-validator';

export const MAX_BATCH_ASSET_IDS = 50;

export class TelemetryLatestQueryDto {
  @ApiProperty({
    description:
      `Comma-separated list of asset IDs (UUID). Maximum ${MAX_BATCH_ASSET_IDS}; ` +
      'exceeding it returns 400. Unknown asset IDs are omitted from the response rather than erroring.',
    example:
      'd57d9ca9-0d4a-4151-ad92-88c8ab13b930,2d1e9b3a-7c3b-4e3a-9e3a-1a2b3c4d5e6f',
  })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string'
      ? value
          .split(',')
          .map((id) => id.trim())
          .filter((id) => id.length > 0)
      : value,
  )
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(MAX_BATCH_ASSET_IDS)
  @IsUUID(undefined, { each: true })
  assetIds: string[];
}
