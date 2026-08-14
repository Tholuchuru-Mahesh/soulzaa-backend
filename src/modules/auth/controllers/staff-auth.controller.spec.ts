jest.mock('../services/firebase.service', () => ({
  FirebaseService: jest.fn().mockImplementation(() => ({})),
}));

import { Test, TestingModule } from '@nestjs/testing';
import { StaffAuthController } from './staff-auth.controller';
import { AuthService } from '../services/auth.service';

describe('StaffAuthController', () => {
  let controller: StaffAuthController;
  let authService: jest.Mocked<AuthService>;

  beforeEach(async () => {
    authService = {
      staffLogin: jest.fn().mockResolvedValue({
        accessToken: 'mock-access-token',
        refreshToken: 'mock-refresh-token',
        user: { id: 'staff-1', email: 'admin@soulzaa.com' },
      }),
    } as unknown as jest.Mocked<AuthService>;

    const module: TestingModule = await Test.createTestingModule({
      controllers: [StaffAuthController],
      providers: [{ provide: AuthService, useValue: authService }],
    }).compile();

    controller = module.get<StaffAuthController>(StaffAuthController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  it('should process staff login request and delegate to AuthService', async () => {
    const result = await controller.login(
      {
        email: 'admin@soulzaa.com',
        password: 'Password123!',
        totpCode: '123456',
        deviceIdentifier: 'dev-1',
      },
      { ip: '127.0.0.1', userAgent: 'test-agent', timestamp: new Date().toISOString() },
    );

    expect(authService.staffLogin).toHaveBeenCalledWith(
      {
        email: 'admin@soulzaa.com',
        password: 'Password123!',
        totpCode: '123456',
        deviceIdentifier: 'dev-1',
      },
      { ip: '127.0.0.1', userAgent: 'test-agent' },
    );
    expect(result).toHaveProperty('accessToken');
  });
});
