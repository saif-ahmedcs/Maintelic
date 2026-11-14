import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';

export const CLIENT_ERROR_FIELD_LIMITS = {
  message: 1000,
  stack: 8000,
  route: 500,
  requestId: 100,
  appVersion: 50,
} as const;

export class CreateClientErrorDto {
  @ApiProperty({
    maxLength: CLIENT_ERROR_FIELD_LIMITS.message,
    description: 'Human-readable error message as the client saw it',
  })
  @IsString()
  @MaxLength(CLIENT_ERROR_FIELD_LIMITS.message)
  message: string;

  @ApiPropertyOptional({
    maxLength: CLIENT_ERROR_FIELD_LIMITS.stack,
    description:
      'Stack trace, when the client has one. Not every client error has a stack trace.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(CLIENT_ERROR_FIELD_LIMITS.stack)
  stack?: string;

  @ApiProperty({
    maxLength: CLIENT_ERROR_FIELD_LIMITS.route,
    description:
      'Client-side route the error occurred on (query string stripped by the client)',
  })
  @IsString()
  @MaxLength(CLIENT_ERROR_FIELD_LIMITS.route)
  route: string;

  @ApiPropertyOptional({
    maxLength: CLIENT_ERROR_FIELD_LIMITS.requestId,
    description:
      'Server-generated ID (x-request-id) of the earlier failed request this error reports on, sent when available',
  })
  @IsOptional()
  @IsString()
  @MaxLength(CLIENT_ERROR_FIELD_LIMITS.requestId)
  requestId?: string;

  @ApiProperty({
    maxLength: CLIENT_ERROR_FIELD_LIMITS.appVersion,
    description: 'Version of the frontend build that reported the error',
  })
  @IsString()
  @MaxLength(CLIENT_ERROR_FIELD_LIMITS.appVersion)
  appVersion: string;
}
