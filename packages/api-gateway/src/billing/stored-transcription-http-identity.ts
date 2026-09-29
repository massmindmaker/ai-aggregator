import { createHash } from 'node:crypto';
import { captureDeclaredSessionId } from './admission-internal';
import { parseReviewedPcmWav, REVIEWED_STT_MAX_FILE_BYTES, type ReviewedPcmWav } from './stored-transcription-wav';

export type StoredTranscriptionHttpErrorCode =
  | 'INVALID_STORED_TRANSCRIPTION_HTTP_IDENTITY'
  | 'REQUEST_BODY_TOO_LARGE'
  | 'UNSUPPORTED_CONTENT_TYPE'
  | 'UNSUPPORTED_EXECUTION_CONTRACT';

export class StoredTranscriptionHttpContractError extends Error {
  constructor(readonly code: StoredTranscriptionHttpErrorCode) {
    super(code);
    this.name = 'StoredTranscriptionHttpContractError';
  }
}
export type StoredTranscriptionHttpIdentity = Readonly<{
  contractVersion: 1;
  routeKind: 'audio_transcription';
  billingMode: 'stored';
  parserContract: 'pcm-wav-riff-v1';
  idempotencyKeyDigest: string;
  requestFingerprint: string;
  declaredSessionId: string | null;
  model: 'whisper-large-v3';
  language: string | null;
  audioSha256: string;
  audioBytes: number;
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  frames: number;
  durationMs: number;
  billableMs: number;
}>;
export type CapturedStoredTranscription = Readonly<{
  identity: StoredTranscriptionHttpIdentity;
  audio: ReviewedPcmWav & Readonly<{ bytes: Uint8Array }>;
}>;

const MAX_BODY_BYTES = REVIEWED_STT_MAX_FILE_BYTES + 65_536;
const MODELS = new Set(['whisper-large-v3']);
const BOUNDARY = /^[A-Za-z0-9'()+_,./:=?-]{1,70}$/;
const IDEM = /^[A-Za-z0-9._:-]{1,128}$/;
const NAME = /^[A-Za-z0-9_-]{1,64}$/;
const decoder = new TextDecoder('utf-8', { fatal: true });

function fail(code: StoredTranscriptionHttpErrorCode = 'INVALID_STORED_TRANSCRIPTION_HTTP_IDENTITY'): never {
  throw new StoredTranscriptionHttpContractError(code);
}
function sha(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}
function boundaryFrom(request: Request): string {
  const value = request.headers.get('content-type');
  if (!value) fail('UNSUPPORTED_CONTENT_TYPE');
  const match = /^multipart\/form-data\s*;\s*boundary=(?:"([^"]+)"|([^;\s]+))\s*$/i.exec(value);
  const boundary = match?.[1] ?? match?.[2] ?? '';
  if (!BOUNDARY.test(boundary)) fail('UNSUPPORTED_CONTENT_TYPE');
  return boundary;
}
async function readBounded(request: Request): Promise<Buffer> {
  const declared = request.headers.get('content-length');
  if (declared !== null && (!/^(0|[1-9][0-9]{0,8})$/.test(declared) || Number(declared) > MAX_BODY_BYTES))
    fail('REQUEST_BODY_TOO_LARGE');
  if (!request.body) fail();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      request.signal.throwIfAborted();
      const item = await reader.read();
      if (item.done) break;
      total += item.value.byteLength;
      if (total > MAX_BODY_BYTES) fail('REQUEST_BODY_TOO_LARGE');
      chunks.push(item.value);
    }
  } catch (error) {
    if (error instanceof StoredTranscriptionHttpContractError) throw error;
    fail();
  } finally {
    try { reader.releaseLock(); } catch {}
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)), total);
}
type Part = Readonly<{ name: string; filename: string | null; contentType: string | null; bytes: Buffer }>;

function parseDisposition(value: string): Readonly<{ name: string; filename: string | null }> {
  const match = /^form-data; name="([A-Za-z0-9_-]{1,64})"(?:; filename="([^"\r\n\0]{0,255})")?$/.exec(value);
  if (!match) fail();
  return { name: match[1]!, filename: match[2] ?? null };
}
function parseParts(body: Buffer, boundary: string): Part[] {
  const open = Buffer.from('--' + boundary + '\r\n');
  const marker = Buffer.from('\r\n--' + boundary);
  if (body.length < open.length + marker.length + 2 || !body.subarray(0, open.length).equals(open)) fail();
  const parts: Part[] = [];
  let pos = open.length;
  const headerSep = Buffer.from('\r\n\r\n');
  while (true) {
    const headerEnd = body.indexOf(headerSep, pos);
    if (headerEnd < 0 || headerEnd - pos > 8192) fail();
    let rawHeaders: string;
    try { rawHeaders = decoder.decode(body.subarray(pos, headerEnd)); } catch { fail(); }
    const headers = new Map<string, string>();
    for (const line of rawHeaders.split('\r\n')) {
      const split = line.indexOf(':');
      if (split <= 0) fail();
      const name = line.slice(0, split).trim().toLowerCase();
      const value = line.slice(split + 1).trim();
      if (headers.has(name) || !['content-disposition', 'content-type'].includes(name)) fail();
      headers.set(name, value);
    }
    const disposition = headers.get('content-disposition');
    if (!disposition) fail();
    const parsed = parseDisposition(disposition);
    const dataStart = headerEnd + 4;
    const next = body.indexOf(marker, dataStart);
    if (next < 0) fail();
    parts.push(Object.freeze({
      name: parsed.name,
      filename: parsed.filename,
      contentType: headers.get('content-type')?.toLowerCase() ?? null,
      bytes: body.subarray(dataStart, next),
    }));
    let cursor = next + marker.length;
    if (body.subarray(cursor, cursor + 2).toString() === '--') {
      cursor += 2;
      if (cursor === body.length) break;
      if (cursor + 2 === body.length && body.subarray(cursor).toString() === '\r\n') break;
      fail();
    }
    if (body.subarray(cursor, cursor + 2).toString() !== '\r\n') fail();
    pos = cursor + 2;
    if (parts.length > 4) fail();
  }
  return parts;
}
function field(part: Part, max: number): string {
  if (part.filename !== null || part.contentType !== null || part.bytes.length < 1 || part.bytes.length > max) fail();
  try { return decoder.decode(part.bytes); } catch { return fail(); }
}
function normalized(parts: Part[]): Readonly<{
  model: 'whisper-large-v3';
  language: string | null;
  bytes: Uint8Array;
}> {
  const byName = new Map<string, Part>();
  for (const part of parts) {
    if (!NAME.test(part.name) || byName.has(part.name) || !['model', 'language', 'response_format', 'file'].includes(part.name)) fail();
    byName.set(part.name, part);
  }
  const modelPart = byName.get('model');
  const file = byName.get('file');
  if (!modelPart || !file) fail();
  const model = field(modelPart, 128);
  if (!MODELS.has(model)) fail();
  let language: string | null = null;
  const languagePart = byName.get('language');
  if (languagePart) {
    language = field(languagePart, 32).toLowerCase();
    if (!/^[a-z]{2}$/.test(language)) fail();
  }
  const response = byName.get('response_format');
  if (response && field(response, 32) !== 'json') fail();
  if (
    file.filename === null ||
    file.bytes.length < 44 ||
    file.bytes.length > REVIEWED_STT_MAX_FILE_BYTES ||
    !['audio/wav', 'audio/x-wav', 'application/octet-stream'].includes(file.contentType ?? '')
  ) fail();
  return {
    model: model as 'whisper-large-v3',
    language,
    bytes: Uint8Array.from(file.bytes),
  };
}
function idempotencyKey(request: Request): string {
  const value = request.headers.get('idempotency-key');
  if (!value || !IDEM.test(value)) fail();
  return value;
}
export async function captureStoredTranscriptionHttpRequest(request: Request): Promise<CapturedStoredTranscription> {
  if (request.headers.has('x-upstream-key')) fail('UNSUPPORTED_EXECUTION_CONTRACT');
  const boundary = boundaryFrom(request);
  const key = idempotencyKey(request);
  const declaredSessionId = captureDeclaredSessionId(request.headers.get('x-aiag-session-id'));
  const body = await readBounded(request);
  const parsed = normalized(parseParts(body, boundary));
  const wav = parseReviewedPcmWav(parsed.bytes);
  // Idempotency intentionally binds the normalized sold-v1 request plus exact decoded WAV bytes (sha256),
  // not transport-only multipart boundary/order/filename differences.
  const canonical = JSON.stringify([
    1, 'audio_transcription', 'stored', 'pcm-wav-riff-v1', parsed.model, parsed.language, declaredSessionId,
    wav.sha256, wav.byteLength, wav.sampleRate, wav.channels, wav.bitsPerSample,
    wav.frames, wav.durationMs, wav.billableMs,
  ]);
  const identity = Object.freeze({
    contractVersion: 1 as const,
    routeKind: 'audio_transcription' as const,
    billingMode: 'stored' as const,
    parserContract: 'pcm-wav-riff-v1' as const,
    idempotencyKeyDigest: sha(key),
    requestFingerprint: sha(canonical),
    declaredSessionId,
    model: parsed.model,
    language: parsed.language,
    audioSha256: wav.sha256,
    audioBytes: wav.byteLength,
    sampleRate: wav.sampleRate,
    channels: wav.channels,
    bitsPerSample: wav.bitsPerSample,
    frames: wav.frames,
    durationMs: wav.durationMs,
    billableMs: wav.billableMs,
  });
  return Object.freeze({
    identity,
    audio: Object.freeze({ ...wav, bytes: parsed.bytes }),
  });
}
