export const VIDEO_PROCESSING_QUEUE = 'video-processing';
export const PROCESS_VIDEO_JOB = 'process-video';

export interface ProcessVideoJobData {
  videoId: string;
}

/** 100MB parts → 10GB = 100 parts (S3 allows up to 10,000 parts of 5MB–5GB). */
export const UPLOAD_PART_SIZE_BYTES = 100 * 1024 * 1024;

/** S3 protocol limit for multipart uploads. */
export const MAX_UPLOAD_PARTS = 10000;

/** 10GB — phase requirement ceiling. */
export const MAX_VIDEO_SIZE_BYTES = 10 * 1024 * 1024 * 1024;

export const PROCESS_VIDEO_JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 5000 },
  removeOnComplete: true,
} as const;

export const VIDEO_TITLE_MAX_LENGTH = 100;
