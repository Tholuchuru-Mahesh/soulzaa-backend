import { LoginTelemetryService } from './login-telemetry.service';

/**
 * Spec §2: track browser, OS, device and country on every login.
 *
 * The governing rule for all of it: telemetry is observational. A malformed
 * user-agent, an unroutable IP or an unconfigured geo source must degrade to
 * null — never throw, because that would turn a cosmetic gap into a failed
 * login for a real operator.
 */
describe('LoginTelemetryService.describe', () => {
  const geo = { countryFor: jest.fn().mockResolvedValue('IN') } as any;
  let service: LoginTelemetryService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new LoginTelemetryService(geo);
  });

  const CHROME_MAC =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
  const SAFARI_IPHONE =
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Mobile/15E148 Safari/604.1';

  it('parses browser and OS from a desktop user-agent', async () => {
    const out = await service.describe({ ip: '1.2.3.4', userAgent: CHROME_MAC });
    expect(out.browser).toBe('Chrome');
    expect(out.os).toBe('macOS');
  });

  it('classifies a desktop user-agent as desktop', async () => {
    const out = await service.describe({ ip: '1.2.3.4', userAgent: CHROME_MAC });
    expect(out.deviceType).toBe('desktop');
  });

  it('classifies a phone user-agent as mobile', async () => {
    const out = await service.describe({ ip: '1.2.3.4', userAgent: SAFARI_IPHONE });
    expect(out.deviceType).toBe('mobile');
    expect(out.os).toBe('iOS');
  });

  it('resolves country from the ip', async () => {
    const out = await service.describe({ ip: '1.2.3.4', userAgent: CHROME_MAC });
    expect(geo.countryFor).toHaveBeenCalledWith('1.2.3.4');
    expect(out.country).toBe('IN');
  });

  it('degrades to nulls when the user-agent is absent', async () => {
    const out = await service.describe({ ip: '1.2.3.4', userAgent: undefined });
    expect(out.browser).toBeNull();
    expect(out.os).toBeNull();
    expect(out.deviceType).toBeNull();
  });

  it('degrades to null country when no ip is available', async () => {
    const out = await service.describe({ ip: undefined, userAgent: CHROME_MAC });
    expect(out.country).toBeNull();
    expect(geo.countryFor).not.toHaveBeenCalled();
  });

  it('never throws on a malformed user-agent', async () => {
    await expect(service.describe({ ip: 'not-an-ip', userAgent: '!!!' })).resolves.toBeDefined();
  });

  it('survives a geo lookup that throws — a login must not fail over telemetry', async () => {
    geo.countryFor.mockRejectedValue(new Error('geo provider down'));
    const out = await service.describe({ ip: '1.2.3.4', userAgent: CHROME_MAC });
    expect(out.country).toBeNull();
    expect(out.browser).toBe('Chrome');
  });
});
