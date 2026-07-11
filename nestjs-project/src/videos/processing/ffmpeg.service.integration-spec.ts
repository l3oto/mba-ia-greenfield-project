import { execFile } from 'child_process';
import { promisify } from 'util';
import { mkdtemp, rm, stat, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { FfmpegService } from './ffmpeg.service';

const execFileAsync = promisify(execFile);

describe('FfmpegService (integration)', () => {
  let service: FfmpegService;
  let tempDir: string;
  let clipPath: string;

  beforeAll(async () => {
    service = new FfmpegService();
    tempDir = await mkdtemp(join(tmpdir(), 'ffmpeg-spec-'));
    clipPath = join(tempDir, 'clip.mp4');

    // Generate a 2s synthetic test clip with the real ffmpeg binary.
    await execFileAsync('ffmpeg', [
      '-y',
      '-f',
      'lavfi',
      '-i',
      'testsrc=duration=2:size=320x240:rate=10',
      clipPath,
    ]);
  }, 30000);

  afterAll(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('should probe duration, dimensions, codec, and format', async () => {
    const probe = await service.probe(clipPath);

    expect(probe.durationSeconds).toBe(2);
    expect(probe.width).toBe(320);
    expect(probe.height).toBe(240);
    expect(probe.codec).toBeTruthy();
    expect(probe.format).toContain('mp4');
  });

  it('should capture a non-empty jpeg frame', async () => {
    const framePath = join(tempDir, 'frame.jpg');

    await service.captureFrame(clipPath, 1, framePath);

    const info = await stat(framePath);
    expect(info.size).toBeGreaterThan(0);
  });

  it('should reject when the input is not a video', async () => {
    const bogusPath = join(tempDir, 'bogus.mp4');
    await writeFile(bogusPath, 'not a video at all');

    await expect(service.probe(bogusPath)).rejects.toThrow();
  });
});
