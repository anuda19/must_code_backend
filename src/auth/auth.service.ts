import {
  ConflictException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';

import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';

import { PrismaService } from '../prisma/prisma.service';
import { UsersService } from '../users/users.service';

@Injectable()
export class AuthService {
  constructor(
    private readonly usersService: UsersService,
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
  ) {}

  async register(
    name: string,
    email: string,
    password: string,
  ) {
    const existingUser =
      await this.usersService.findByEmail(email);

    if (existingUser) {
      throw new ConflictException(
        'Email already registered',
      );
    }

    const passwordHash = await bcrypt.hash(password, 12);

    const user = await this.usersService.create({
      name,
      email,
      passwordHash,
    });

    return this.generateTokens(user.id);
  }

  async login(
    email: string,
    password: string,
  ) {
    const user =
      await this.usersService.findByEmail(email);

    if (!user) {
      throw new UnauthorizedException(
        'Invalid credentials',
      );
    }

    const passwordValid = await bcrypt.compare(
      password,
      user.passwordHash,
    );

    if (!passwordValid) {
      throw new UnauthorizedException(
        'Invalid credentials',
      );
    }

    return this.generateTokens(user.id);
  }

  async generateTokens(userId: string) {
    const payload = {
      sub: userId,
    };

    const accessToken =
      await this.jwtService.signAsync(payload, {
        secret: process.env.JWT_ACCESS_SECRET,
        expiresIn: '15m',
      });

    const refreshToken =
      await this.jwtService.signAsync(payload, {
        secret: process.env.JWT_REFRESH_SECRET,
        expiresIn: '7d',
      });

    const tokenHash = await bcrypt.hash(
      refreshToken,
      12,
    );

    await this.prisma.refreshToken.create({
      data: {
        tokenHash,
        userId,
        expiresAt: new Date(
          Date.now() + 7 * 24 * 60 * 60 * 1000,
        ),
      },
    });

    return {
      accessToken,
      refreshToken,
    };
  }

  async refresh(refreshToken: string) {
    let payload: { sub: string };

    try {
      payload =
        await this.jwtService.verifyAsync(refreshToken, {
          secret: process.env.JWT_REFRESH_SECRET,
        });
    } catch {
      throw new UnauthorizedException(
        'Invalid refresh token',
      );
    }

    const tokens =
      await this.prisma.refreshToken.findMany({
        where: {
          userId: payload.sub,
          revokedAt: null,
        },
      });

    let storedToken:
      | (typeof tokens)[number]
      | undefined;

    for (const token of tokens) {
      const matches = await bcrypt.compare(
        refreshToken,
        token.tokenHash,
      );

      if (matches) {
        storedToken = token;
        break;
      }
    }

    if (!storedToken) {
      throw new UnauthorizedException(
        'Invalid refresh token',
      );
    }

    if (storedToken.expiresAt < new Date()) {
      throw new UnauthorizedException(
        'Refresh token expired',
      );
    }

    await this.prisma.refreshToken.update({
      where: {
        id: storedToken.id,
      },
      data: {
        revokedAt: new Date(),
      },
    });

    return this.generateTokens(payload.sub);
  }

  async logout(refreshToken: string) {
    const tokens =
      await this.prisma.refreshToken.findMany();

    for (const token of tokens) {
      const matches = await bcrypt.compare(
        refreshToken,
        token.tokenHash,
      );

      if (matches) {
        await this.prisma.refreshToken.update({
          where: {
            id: token.id,
          },
          data: {
            revokedAt: new Date(),
          },
        });

        return {
          message: 'Logged out successfully',
        };
      }
    }

    return {
      message: 'Logged out successfully',
    };
  }

  async getMe(userId: string) {
    const user =
      await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        name: true,
        createdAt: true,
        // passwordHash: false (password kabhi return mat karna)
      },
    });

    if (!user) {
      throw new UnauthorizedException();
    }

    return user;
  }
}