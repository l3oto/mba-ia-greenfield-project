import { ApiProperty } from '@nestjs/swagger';
import { Video, VideoStatus } from '../entities/video.entity';

export class VideoResponseDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'dQw4w9WgXcQ' })
  public_id: string;

  @ApiProperty({ example: 'ferias-na-praia' })
  title: string;

  @ApiProperty({ enum: VideoStatus })
  status: VideoStatus;

  @ApiProperty({ example: 'ferias-na-praia.mp4' })
  original_filename: string;

  @ApiProperty({ example: 'video/mp4' })
  mime_type: string;

  @ApiProperty({ example: '1073741824' })
  size_bytes: string;

  @ApiProperty({ nullable: true, example: 128 })
  duration_seconds: number | null;

  @ApiProperty()
  created_at: Date;

  static fromEntity(video: Video): VideoResponseDto {
    const dto = new VideoResponseDto();
    dto.id = video.id;
    dto.public_id = video.public_id;
    dto.title = video.title;
    dto.status = video.status;
    dto.original_filename = video.original_filename;
    dto.mime_type = video.mime_type;
    dto.size_bytes = video.size_bytes;
    dto.duration_seconds = video.duration_seconds;
    dto.created_at = video.created_at;
    return dto;
  }
}
