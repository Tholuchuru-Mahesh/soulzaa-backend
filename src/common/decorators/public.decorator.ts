import { SetMetadata } from '@nestjs/common';
import { IS_PUBLIC_KEY } from '../constants';

/** Marks a route as accessible without a valid JWT (bypasses JwtAuthGuard). */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
