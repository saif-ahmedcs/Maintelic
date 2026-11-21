import { UnauthorizedException } from '@nestjs/common';

export class InvalidCurrentPasswordException extends UnauthorizedException {
  constructor() {
    super({
      statusCode: 401,
      error: 'InvalidCurrentPassword',
      message: 'Current password is incorrect',
    });
  }
}
