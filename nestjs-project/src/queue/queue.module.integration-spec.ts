import { Test } from '@nestjs/testing';
import type { TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { BullModule, getQueueToken } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import queueConfig from '../config/queue.config';
import { QueueModule } from './queue.module';
import {
  PROCESS_VIDEO_JOB,
  PROCESS_VIDEO_JOB_OPTIONS,
  VIDEO_PROCESSING_QUEUE,
} from '../videos/videos.constants';

describe('QueueModule (integration)', () => {
  let module: TestingModule;
  let queue: Queue;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [queueConfig] }),
        QueueModule,
        BullModule.registerQueue({ name: VIDEO_PROCESSING_QUEUE }),
      ],
    }).compile();

    queue = module.get(getQueueToken(VIDEO_PROCESSING_QUEUE));
  });

  afterAll(async () => {
    await queue.drain(true);
    await queue.close();
    await module.close();
  });

  beforeEach(async () => {
    await queue.drain(true);
  });

  it('should publish and retrieve a job on the real Redis connection', async () => {
    const jobId = `it-${Date.now()}`;

    await queue.add(
      PROCESS_VIDEO_JOB,
      { videoId: jobId },
      { ...PROCESS_VIDEO_JOB_OPTIONS, jobId },
    );

    const job = await queue.getJob(jobId);
    expect(job).toBeDefined();
    expect(job?.name).toBe(PROCESS_VIDEO_JOB);
    expect(job?.data).toEqual({ videoId: jobId });
    expect(job?.opts.attempts).toBe(3);
    expect(job?.opts.backoff).toEqual({ type: 'exponential', delay: 5000 });
  });

  it('should deduplicate jobs with the same jobId', async () => {
    const jobId = `dedup-${Date.now()}`;

    await queue.add(PROCESS_VIDEO_JOB, { videoId: jobId }, { jobId });
    await queue.add(PROCESS_VIDEO_JOB, { videoId: jobId }, { jobId });

    const counts = await queue.getJobCounts('waiting');
    expect(counts.waiting).toBe(1);
  });
});
