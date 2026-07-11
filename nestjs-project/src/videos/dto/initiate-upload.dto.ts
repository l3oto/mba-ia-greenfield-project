import { ApiProperty } from '@nestjs/swagger';
import {
  IsInt,
  IsNotEmpty,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { MAX_VIDEO_SIZE_BYTES } from '../videos.constants';

export class InitiateUploadDto {
  @ApiProperty({ example: 'ferias-na-praia.mp4', maxLength: 255 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  filename: string;

  @ApiProperty({ example: 'video/mp4', description: 'Must be a video/* type' })
  @IsString()
  @Matches(/^video\//, { message: 'mime_type must be a video/* media type' })
  mime_type: string;

  @ApiProperty({
    example: 1073741824,
    minimum: 1,
    maximum: MAX_VIDEO_SIZE_BYTES,
    description: 'Declared file size in bytes (up to 10GB)',
  })
  @IsInt()
  @Min(1)
  @Max(MAX_VIDEO_SIZE_BYTES)
  size_bytes: number;
}
