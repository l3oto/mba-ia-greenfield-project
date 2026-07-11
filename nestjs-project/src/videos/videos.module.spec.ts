import { Test } from '@nestjs/testing';
import type { TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { getRepositoryToken } from '@nestjs/typeorm';
import { getQueueToken } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { Channel } from '../channels/entities/channel.entity';
import queueConfig from '../config/queue.config';
import storageConfig from '../config/storage.config';
import { VideosModule } from './videos.module';
import { Video } from './entities/video.entity';
import { VideosService } from './videos.service';
import { VIDEO_PROCESSING_QUEUE } from './videos.constants';

describe('VideosModule', () => {
  let module: TestingModule;

  afterAll(async () => {
    const queue = module.get<Queue>(getQueueToken(VIDEO_PROCESSING_QUEUE));
    await queue.close();
    await module.close();
  });

  it('should compile with repository, queue, and storage wiring', async () => {
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [queueConfig, storageConfig],
        }),
        VideosModule,
      ],
    })
      .overrideProvider(getRepositoryToken(Video))
      .useValue({})
      .overrideProvider(getRepositoryToken(Channel))
      .useValue({})
      .compile();

    expect(module).toBeDefined();
    expect(module.get(VideosService)).toBeDefined();
  });
});
