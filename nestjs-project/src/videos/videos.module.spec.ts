import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { VideosModule } from './videos.module';
import { Video } from './entities/video.entity';

describe('VideosModule', () => {
  it('should compile with TypeOrmModule.forFeature wiring', async () => {
    const module = await Test.createTestingModule({
      imports: [VideosModule],
    })
      .overrideProvider(getRepositoryToken(Video))
      .useValue({})
      .compile();

    expect(module).toBeDefined();
  });
});
