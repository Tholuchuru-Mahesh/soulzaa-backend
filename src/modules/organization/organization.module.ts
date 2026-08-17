import { Global, Module } from '@nestjs/common';
import { PrismaModule } from 'src/infra/prisma/prisma.module';
import { GeocodingModule } from 'src/infra/geocoding/geocoding.module';
import { CountryService } from './services/country.service';
import { LocationDetectionService } from './services/location-detection.service';
import { OrganizationHierarchyService } from './services/organization-hierarchy.service';
import { RegionService } from './services/region.service';
import { StateService } from './services/state.service';
import { UserLocationService } from './services/user-location.service';
import { UserLocationController } from './controllers/user-location.controller';
import { GeographyLookupController } from './controllers/geography-lookup.controller';

@Global()
@Module({
  imports: [PrismaModule, GeocodingModule],
  controllers: [GeographyLookupController, UserLocationController],
  providers: [
    UserLocationService,
    LocationDetectionService,
    CountryService,
    StateService,
    RegionService,
    OrganizationHierarchyService,
  ],
  exports: [
    UserLocationService,
    LocationDetectionService,
    CountryService,
    StateService,
    RegionService,
    OrganizationHierarchyService,
  ],
})
export class OrganizationModule {}
