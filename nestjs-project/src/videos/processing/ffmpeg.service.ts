import { spawn } from 'child_process';
import { Injectable } from '@nestjs/common';

export interface VideoProbeResult {
  durationSeconds: number;
  width: number;
  height: number;
  codec: string;
  format: string;
}

interface FfprobeOutput {
  format?: { duration?: string; format_name?: string };
  streams?: {
    codec_type?: string;
    codec_name?: string;
    width?: number;
    height?: number;
  }[];
}

@Injectable()
export class FfmpegService {
  async probe(filePath: string): Promise<VideoProbeResult> {
    const stdout = await this.run('ffprobe', [
      '-v',
      'error',
      '-print_format',
      'json',
      '-show_format',
      '-show_streams',
      filePath,
    ]);

    const parsed = JSON.parse(stdout) as FfprobeOutput;
    const videoStream = parsed.streams?.find(
      (stream) => stream.codec_type === 'video',
    );
    if (!videoStream || !parsed.format?.duration) {
      throw new Error(`File has no probeable video stream: ${filePath}`);
    }

    return {
      durationSeconds: Math.round(Number(parsed.format.duration)),
      width: videoStream.width ?? 0,
      height: videoStream.height ?? 0,
      codec: videoStream.codec_name ?? 'unknown',
      format: parsed.format.format_name ?? 'unknown',
    };
  }

  async captureFrame(
    filePath: string,
    atSeconds: number,
    outputPath: string,
  ): Promise<void> {
    await this.run('ffmpeg', [
      '-y',
      '-ss',
      String(atSeconds),
      '-i',
      filePath,
      '-frames:v',
      '1',
      '-vf',
      'scale=320:-1',
      outputPath,
    ]);
  }

  private run(binary: string, args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(binary, args);
      let stdout = '';
      let stderr = '';

      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      child.on('error', reject);
      child.on('close', (code) => {
        if (code === 0) {
          resolve(stdout);
        } else {
          reject(
            new Error(`${binary} exited with code ${code}: ${stderr.trim()}`),
          );
        }
      });
    });
  }
}
