import { PrismaService } from 'src/infra/prisma/prisma.service';
import { TaskQueryService } from './task-query.service';
import { TaskRewardService } from './task-reward.service';

const MODERATOR_ID = 'mod-1';

describe('TaskQueryService.moderatorAssignmentSummary', () => {
  let prisma: { moderator_task_assignments: { count: jest.Mock } };
  let service: TaskQueryService;

  beforeEach(() => {
    prisma = { moderator_task_assignments: { count: jest.fn() } };
    // Unused by this suite (moderatorAssignmentSummary never touches reward
    // dispatch) — only here to satisfy the constructor.
    const rewardService = {} as unknown as TaskRewardService;
    service = new TaskQueryService(prisma as unknown as PrismaService, rewardService);
  });

  it('computes pending as assigned minus completed, and overdue percentage', async () => {
    prisma.moderator_task_assignments.count
      .mockResolvedValueOnce(10) // assigned
      .mockResolvedValueOnce(6) // completed
      .mockResolvedValueOnce(2); // overdue

    const summary = await service.moderatorAssignmentSummary(MODERATOR_ID);

    expect(summary).toEqual({
      assigned: 10,
      completed: 6,
      pending: 4,
      overdue: 2,
      overduePercentage: 20,
    });
  });

  it('scopes every count to the calling moderator', async () => {
    prisma.moderator_task_assignments.count.mockResolvedValue(0);

    await service.moderatorAssignmentSummary(MODERATOR_ID);

    for (const call of prisma.moderator_task_assignments.count.mock.calls) {
      expect(call[0].where.moderatorId).toBe(MODERATOR_ID);
    }
  });

  it('reports 0% overdue when nothing is assigned yet', async () => {
    prisma.moderator_task_assignments.count.mockResolvedValue(0);

    const summary = await service.moderatorAssignmentSummary(MODERATOR_ID);

    expect(summary.overduePercentage).toBe(0);
  });
});
