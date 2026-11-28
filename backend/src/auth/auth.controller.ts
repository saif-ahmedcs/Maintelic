import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Patch,
  Post,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ConfigService } from '@nestjs/config';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import {
  ApiBearerAuth,
  ApiBody,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { RefreshDto } from './dto/refresh.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import { Public } from './decorators/public.decorator';
import { CurrentUser } from './decorators/current-user.decorator';
import type { RequestUser } from './interfaces/request-user.interface';
import { User } from '../users/entities/user.entity';
import { AUTH_LOGIN_THROTTLE, AUTH_REFRESH_THROTTLE } from './auth-rate-limit';
import { refreshTokenLifetimeMs } from './auth.constants';

const REFRESH_COOKIE_NAME = 'refresh_token';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly config: ConfigService,
  ) {}

  @Public()
  @Throttle({ default: AUTH_LOGIN_THROTTLE })
  @UseGuards(AuthGuard('local'))
  @HttpCode(HttpStatus.OK)
  @Post('login')
  @ApiOperation({
    summary: 'Exchange email + password for an access/refresh token pair',
  })
  @ApiBody({ type: LoginDto })
  @ApiOkResponse({
    description:
      'Access token, refresh token, and whether this account must change ' +
      'its password before doing anything else (`mustChangePassword`). ' +
      'The refresh token is also set as an httpOnly cookie, scoped to /auth.',
  })
  @ApiUnauthorizedResponse({ description: 'Invalid email or password' })
  async login(
    @Req() req: { user: User },
    @Res({ passthrough: true }) res: Response,
  ) {
    const tokens = await this.authService.login(req.user);
    this.setRefreshCookie(res, tokens.refreshToken);
    return { ...tokens, mustChangePassword: req.user.mustChangePassword };
  }

  @Public()
  @Throttle({ default: AUTH_REFRESH_THROTTLE })
  @HttpCode(HttpStatus.OK)
  @Post('refresh')
  @ApiOperation({
    summary: 'Rotate a refresh token for a new access/refresh pair',
  })
  @ApiBody({
    type: RefreshDto,
    required: false,
    description:
      'Optional when the refresh_token cookie is present; kept as a fallback ' +
      'for clients that cannot use cookies.',
  })
  @ApiOkResponse({
    description:
      'A newly issued access token and refresh token. The rotated refresh ' +
      'token is also set as an httpOnly cookie. If the presented token was ' +
      'rotated by a concurrent request within the last few seconds, only a ' +
      'new access token is returned and the cookie is left unchanged.',
  })
  @ApiUnauthorizedResponse({
    description: 'The refresh token is invalid, expired, or already revoked',
  })
  async refresh(
    @Req() req: Request,
    @Body() dto: RefreshDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const presentedToken = this.resolveRefreshToken(req, dto);
    if (!presentedToken) {
      throw new UnauthorizedException('Refresh token is required');
    }
    const tokens = await this.authService.refresh(presentedToken);
    if (tokens.refreshToken) {
      this.setRefreshCookie(res, tokens.refreshToken);
    }
    return tokens;
  }

  @Public()
  @HttpCode(HttpStatus.NO_CONTENT)
  @Post('logout')
  @ApiOperation({
    summary: 'Revoke exactly the refresh token presented, if it is still live',
  })
  @ApiBody({
    type: RefreshDto,
    required: false,
    description:
      'Optional when the refresh_token cookie is present; kept as a fallback ' +
      'for clients that cannot use cookies.',
  })
  async logout(
    @Req() req: Request,
    @Body() dto: RefreshDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    const presentedToken = this.resolveRefreshToken(req, dto);
    if (presentedToken) {
      await this.authService.logout(presentedToken);
    }
    res.clearCookie(REFRESH_COOKIE_NAME, { path: '/auth' });
  }

  @Patch('password')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Change the current user’s own password',
    description:
      'Verifies currentPassword, requires newPassword to be at least 12 ' +
      'characters, and revokes every other live refresh token for this ' +
      'user — the session that presents a live refresh_token cookie on ' +
      'this request is kept; every other session is signed out.',
  })
  @ApiBody({ type: ChangePasswordDto })
  @ApiUnauthorizedResponse({ description: 'Current password is incorrect' })
  async changePassword(
    @Body() dto: ChangePasswordDto,
    @CurrentUser() actor: RequestUser,
    @Req() req: Request,
  ): Promise<void> {
    const presentedRefreshToken = this.readRefreshCookie(req);
    await this.authService.changePassword(
      actor.id,
      dto.currentPassword,
      dto.newPassword,
      presentedRefreshToken,
    );
  }

  @Get('me')
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Return the currently authenticated user and their roles',
  })
  @ApiOkResponse({
    description:
      'The authenticated user: id, email, name, roles, and whether a ' +
      'password change is required (`mustChangePassword`).',
  })
  me(@CurrentUser() user: RequestUser) {
    return user;
  }

  private resolveRefreshToken(
    req: Request,
    dto: RefreshDto,
  ): string | undefined {
    const cookieToken = this.readRefreshCookie(req);
    return cookieToken ?? dto.refreshToken;
  }

  private readRefreshCookie(req: Request): string | undefined {
    return req.cookies?.[REFRESH_COOKIE_NAME] as string | undefined;
  }

  private setRefreshCookie(res: Response, token: string): void {
    const maxAge = refreshTokenLifetimeMs(this.config);
    res.cookie(REFRESH_COOKIE_NAME, token, {
      httpOnly: true,
      secure: this.config.get<string>('NODE_ENV') === 'production',
      sameSite: 'strict',
      path: '/auth',
      maxAge,
    });
  }
}
