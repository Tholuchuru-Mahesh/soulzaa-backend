import { Test, TestingModule } from '@nestjs/testing';
import { GamesController } from './games.controller';
import { GamesService } from '../services/games.service';
import type { AuthenticatedUser } from 'src/common/interfaces/authenticated-user';

describe('GamesController', () => {
  let controller: GamesController;
  let service: Record<string, jest.Mock>;

  const mockUser: AuthenticatedUser = {
    id: 'usr-1',
    roles: ['USER'],
  } as AuthenticatedUser;

  beforeEach(async () => {
    service = {
      listCatalog: jest.fn().mockResolvedValue([]),
      history: jest.fn().mockResolvedValue({ items: [], total: 0 }),
      luckyRecords: jest.fn().mockResolvedValue({ items: [], total: 0 }),
      jackpotRecords: jest.fn().mockResolvedValue({ items: [], total: 0 }),
      myTournaments: jest.fn().mockResolvedValue({ items: [], total: 0 }),
      listTournaments: jest.fn().mockResolvedValue({ items: [], total: 0 }),
      leaderboard: jest.fn().mockResolvedValue([]),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [GamesController],
      providers: [
        {
          provide: GamesService,
          useValue: service,
        },
      ],
    }).compile();

    controller = module.get<GamesController>(GamesController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  it('calls history service method', async () => {
    await controller.history(mockUser, { page: 1, limit: 10, skip: 0 });
    expect(service.history).toHaveBeenCalledWith(
      { id: 'usr-1', roles: ['USER'] },
      { page: 1, limit: 10, skip: 0 },
    );
  });

  it('calls luckyRecords service method', async () => {
    await controller.luckyRecords(mockUser, { page: 1, limit: 10, skip: 0 });
    expect(service.luckyRecords).toHaveBeenCalledWith(
      { id: 'usr-1', roles: ['USER'] },
      { page: 1, limit: 10, skip: 0 },
    );
  });

  it('calls jackpotRecords service method', async () => {
    await controller.jackpotRecords(mockUser, { page: 1, limit: 10, skip: 0 });
    expect(service.jackpotRecords).toHaveBeenCalledWith(
      { id: 'usr-1', roles: ['USER'] },
      { page: 1, limit: 10, skip: 0 },
    );
  });

  it('calls myTournaments service method', async () => {
    await controller.myTournaments(mockUser, { page: 1, limit: 10, skip: 0 });
    expect(service.myTournaments).toHaveBeenCalledWith(
      { id: 'usr-1', roles: ['USER'] },
      { page: 1, limit: 10, skip: 0 },
    );
  });

  it('calls listTournaments service method', async () => {
    await controller.tournaments({ page: 1, limit: 10, skip: 0 });
    expect(service.listTournaments).toHaveBeenCalledWith({ page: 1, limit: 10, skip: 0 });
  });
});
