import { Global, Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { JwtStrategy } from './jwt.strategy';
import { PasswordService } from './password.service';
import { RefreshTokenStrategy } from './refresh.strategy';
import { TokenService } from './token.service';

/**
 * Cross-cutting auth plumbing: JWT signing/verifying, the access + refresh
 * passport strategies, and password hashing. Global so guards resolve the
 * strategies anywhere. Login/register/refresh endpoints belong to the auth
 * *domain* module, which will consume TokenService/PasswordService.
 */
@Global()
@Module({
  imports: [PassportModule.register({ defaultStrategy: 'jwt' }), JwtModule.register({})],
  providers: [JwtStrategy, RefreshTokenStrategy, TokenService, PasswordService],
  exports: [TokenService, PasswordService, JwtModule, PassportModule],
})
export class AuthInfraModule {}
