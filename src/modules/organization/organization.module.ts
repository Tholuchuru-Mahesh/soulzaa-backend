import { Global, Module } from '@nestjs/common';
import { PrismaModule } from 'src/infra/prisma/prisma.module';
import { CountryService } from './services/country.service';
import { OrganizationHierarchyService } from './services/organization-hierarchy.service';
import { RegionService } from './services/region.service';
import { StateService } from './services/state.service';

@Global()
@Module({
  imports: [PrismaModule],
  providers: [CountryService, StateService, RegionService, OrganizationHierarchyService],
  exports: [CountryService, StateService, RegionService, OrganizationHierarchyService],
})
export class OrganizationModule {}
