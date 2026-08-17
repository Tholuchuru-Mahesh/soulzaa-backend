import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaModule } from 'src/infra/prisma/prisma.module';
import { AuthorizationModule } from 'src/modules/authorization/authorization.module';
import { RoleRequestController } from './controllers/role-request.controller';
import { DOCUMENT_VERIFIER } from './interfaces/document-verifier.interface';
import { KYC_PROVIDER } from './interfaces/kyc-provider.interface';
import { CompositeDocumentVerifier } from './services/composite-document-verifier.service';
import { IntegrityDocumentVerifier } from './services/integrity-document-verifier.service';
import { createKycProvider } from './services/kyc-providers';
import { RoleRequestDocumentService } from './services/role-request-document.service';
import { RoleRequestRoutingService } from './services/role-request-routing.service';
import { RoleRequestService } from './services/role-request.service';

/**
 * Role approval chains — OFFICIAL → MANAGER → ADMIN, routed entirely on the
 * normalised Country → State → Region hierarchy.
 *
 * `DOCUMENT_VERIFIER` is the composite: local integrity checks always, plus a
 * KYC provider when `KYC_PROVIDER` names one. With no provider configured the
 * composite is exactly the integrity checker — which can prove a file is a
 * readable, unique JPEG/PNG/PDF, but cannot tell an Aadhaar card from any other
 * photograph. Only the provider closes that gap.
 */
@Module({
  imports: [PrismaModule, AuthorizationModule],
  controllers: [RoleRequestController],
  providers: [
    RoleRequestService,
    RoleRequestRoutingService,
    RoleRequestDocumentService,
    IntegrityDocumentVerifier,
    { provide: KYC_PROVIDER, useFactory: createKycProvider, inject: [ConfigService] },
    { provide: DOCUMENT_VERIFIER, useClass: CompositeDocumentVerifier },
  ],
  exports: [RoleRequestService, RoleRequestRoutingService, RoleRequestDocumentService],
})
export class RoleRequestsModule {}
