import { Module } from '@nestjs/common';
import { PrismaModule } from 'src/infra/prisma/prisma.module';
import { RoleRequestController } from './controllers/role-request.controller';
import { DOCUMENT_VERIFIER } from './interfaces/document-verifier.interface';
import { IntegrityDocumentVerifier } from './services/integrity-document-verifier.service';
import { RoleRequestDocumentService } from './services/role-request-document.service';
import { RoleRequestRoutingService } from './services/role-request-routing.service';
import { RoleRequestService } from './services/role-request.service';

/**
 * Role approval chains — OFFICIAL → MANAGER → ADMIN, routed entirely on the
 * normalised Country → State → Region hierarchy.
 *
 * `DOCUMENT_VERIFIER` is bound to the integrity checker: it proves a KYC upload
 * is the format it claims, is readable, and has not been submitted by someone
 * else. It does not contact an issuing authority, so it cannot attest that a
 * document is genuine — swapping in a provider-backed verifier later means
 * changing only the class bound here.
 */
@Module({
  imports: [PrismaModule],
  controllers: [RoleRequestController],
  providers: [
    RoleRequestService,
    RoleRequestRoutingService,
    RoleRequestDocumentService,
    { provide: DOCUMENT_VERIFIER, useClass: IntegrityDocumentVerifier },
  ],
  exports: [RoleRequestService, RoleRequestRoutingService, RoleRequestDocumentService],
})
export class RoleRequestsModule {}
