import { Controller, Get, Query } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiExtraModels,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import { TelemetryReadingResponseDto } from './dto/telemetry-reading-response.dto';
import { TelemetryLatestQueryDto } from './dto/telemetry-latest-query.dto';
import { TelemetryService } from './telemetry.service';

@ApiTags('telemetry')
@ApiBearerAuth('access-token')
@Controller('telemetry')
export class TelemetryLatestController {
  constructor(private readonly telemetryService: TelemetryService) {}

  @Get('latest')
  @ApiOperation({
    summary: 'Get the latest reading for several assets in one request',
    description:
      'Accepts up to 50 comma-separated asset IDs and returns, in a single database query, ' +
      'a map from asset ID to its latest reading. Assets with no readings, and unknown asset ' +
      'IDs, are simply omitted from the response. More than 50 IDs returns 400.',
  })
  @ApiExtraModels(TelemetryReadingResponseDto)
  @ApiOkResponse({
    description:
      'Map from asset ID to its latest telemetry reading. Assets with no matching reading are omitted.',
    schema: {
      type: 'object',
      additionalProperties: { $ref: getSchemaPath(TelemetryReadingResponseDto) },
    },
  })
  getLatestBatch(
    @Query() query: TelemetryLatestQueryDto,
  ): Promise<Record<string, TelemetryReadingResponseDto>> {
    return this.telemetryService.getLatestBatch(query.assetIds);
  }
}
