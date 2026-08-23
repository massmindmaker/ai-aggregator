/**
 * Upstream adapter interface (abstract). Plan 05 implements concrete
 * adapters (OpenRouter, Yandex, Fal, Together, etc.).
 *
 * `egressProxyUrl` (all request types) carries the RAW
 * model_upstreams.egress_proxy column value for the selected routing row.
 * Adapters must pass it straight into fetchUpstream() — resolution against
 * env/direct happens there, never in the adapter (T2 native egress).
 */
export type ChatRequest = {
  modelId: string;
  messages: Array<{ role: string; content: unknown }>;
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
  byokKey?: string | undefined;
  egressProxyUrl?: string | undefined;
};

export type ChatUsage = {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cached_input_tokens?: number;
};

export type ChatResponse = {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: { role: 'assistant'; content: string };
    finish_reason: 'stop' | 'length' | 'content_filter';
  }>;
  usage: ChatUsage;
};

export type EmbeddingsRequest = {
  modelId: string;
  input: string | string[];
  byokKey?: string | undefined;
  egressProxyUrl?: string | undefined;
};

export type EmbeddingsResponse = {
  object: 'list';
  data: Array<{ object: 'embedding'; embedding: number[]; index: number }>;
  model: string;
  usage: { prompt_tokens: number; total_tokens: number };
};

/** Media generation contracts (image/video/audio). */
export type ImageRequest = {
  modelId: string;
  prompt: string;
  n?: number;
  size?: string;
  negative_prompt?: string;
  reference_image_url?: string;
  byokKey?: string | undefined;
  egressProxyUrl?: string | undefined;
};

export type VideoRequest = {
  modelId: string;
  prompt: string;
  duration_s?: number;
  aspect_ratio?: string;
  image_url?: string;
  byokKey?: string | undefined;
  egressProxyUrl?: string | undefined;
};

export type AudioSpeechRequest = {
  modelId: string;
  input: string;
  voice?: string;
  format?: string;
  byokKey?: string | undefined;
  egressProxyUrl?: string | undefined;
};

export type AudioTranscriptionRequest = {
  modelId: string;
  audio_url?: string;
  audio_b64?: string;
  language?: string;
  byokKey?: string | undefined;
  egressProxyUrl?: string | undefined;
};

export type MediaJob = {
  status: 'queued' | 'processing' | 'completed' | 'failed';
  job_id: string;
  poll_url?: string;
  output?: unknown;
  error?: string;
};

export interface UpstreamAdapter {
  chat(req: ChatRequest): Promise<ChatResponse>;
  chatStream?(req: ChatRequest): AsyncIterable<unknown>;
  embeddings?(req: EmbeddingsRequest): Promise<EmbeddingsResponse>;
  imageGeneration?(req: ImageRequest): Promise<MediaJob>;
  videoGeneration?(req: VideoRequest): Promise<MediaJob>;
  audioSpeech?(req: AudioSpeechRequest): Promise<MediaJob>;
  audioTranscription?(req: AudioTranscriptionRequest): Promise<MediaJob>;
  pollJob?(
    jobId: string,
    family: 'image' | 'video' | 'suno',
    opts?: { egressProxyUrl?: string | undefined }
  ): Promise<MediaJob>;
}
