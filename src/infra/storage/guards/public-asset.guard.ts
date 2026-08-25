import { ExecutionContext, Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { isPublicAssetKey } from '../storage.constants';

/**
 * Lets catalog assets be fetched without a bearer token, while keeping every
 * other object behind the normal JWT check.
 *
 * The routes this protects are decorated `@Public()` so the global JwtAuthGuard
 * steps aside; this guard then re-imposes authentication for any key outside
 * PUBLIC_ASSET_PREFIXES. Without the split, private namespaces (kyc-documents,
 * broad-ban-evidence, chat-*) would become readable by key alone.
 */
@Injectable()
export class PublicAssetGuard extends AuthGuard('jwt') {
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    if (isPublicAssetKey(extractKey(request))) return true;
    return (await super.canActivate(context)) as boolean;
  }
}

/**
 * The storage key from a wildcard route. Express exposes the `*` segment as
 * params[0]; the URL split is the fallback for routers that do not, and the
 * query string and any percent-encoding are stripped so the prefix compared
 * against the allowlist is the real one.
 */
function extractKey(request: { params?: Record<string, unknown>; url?: string }): string {
  const raw =
    (request.params as Record<string, string> | undefined)?.['0'] ??
    request.url?.split(/\/(?:download|file)\//)[1] ??
    '';
  try {
    return decodeURIComponent(raw.split('?')[0]);
  } catch {
    return raw.split('?')[0];
  }
}
