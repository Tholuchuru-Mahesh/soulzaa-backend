import { SetMetadata } from '@nestjs/common';
import { RAW_RESPONSE_KEY } from '../interceptors/response.interceptor';

/** Opt a route out of the success-envelope wrapping. */
export const RawResponse = () => SetMetadata(RAW_RESPONSE_KEY, true);
