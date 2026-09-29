import { createHash } from 'node:crypto';
import type { ReviewedTranscriptionProfile } from './reviewed-transcription-profiles';

export const REVIEWED_STT_MAX_FILE_BYTES = 25_000_000;
export const REVIEWED_STT_MAX_DURATION_MS = 7_200_000;
const HOUR_MS = 3_600_000n;
const MICRO_USD_PER_MICROCREDIT = 10n;

function fail(): never { throw new TypeError('INVALID_REVIEWED_STT_AUDIO'); }
function text(bytes: Uint8Array, at: number) {
  return String.fromCharCode(...bytes.subarray(at, at + 4));
}
function ceilDiv(a: bigint, b: bigint) { return (a + b - 1n) / b; }

export type ReviewedPcmWav = Readonly<{
  sha256: string;
  byteLength: number;
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  frames: number;
  durationMs: number;
  billableMs: number;
}>;
export function parseReviewedPcmWav(input: Uint8Array): ReviewedPcmWav {
  if (!(input instanceof Uint8Array) || input.byteLength < 44 || input.byteLength > REVIEWED_STT_MAX_FILE_BYTES) fail();
  const bytes = input;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (text(bytes, 0) !== 'RIFF' || text(bytes, 8) !== 'WAVE' || view.getUint32(4, true) + 8 !== bytes.length) fail();

  let at = 12;
  let fmt: Readonly<{ channels: number; sampleRate: number; bits: number; blockAlign: number }> | null = null;
  let dataSize: number | null = null;
  while (at + 8 <= bytes.length) {
    const kind = text(bytes, at);
    const size = view.getUint32(at + 4, true);
    const start = at + 8;
    const end = start + size;
    if (end > bytes.length) fail();
    if (kind === 'fmt ') {
      if (fmt || size < 16 || size > 128) fail();
      const format = view.getUint16(start, true);
      const channels = view.getUint16(start + 2, true);
      const sampleRate = view.getUint32(start + 4, true);
      const byteRate = view.getUint32(start + 8, true);
      const blockAlign = view.getUint16(start + 12, true);
      const bits = view.getUint16(start + 14, true);
      if (format !== 1 || ![1, 2].includes(channels) || sampleRate < 8000 || sampleRate > 192000 || ![8, 16, 24, 32].includes(bits)) fail();
      const expected = channels * (bits / 8);
      if (!Number.isInteger(expected) || blockAlign !== expected || byteRate !== sampleRate * blockAlign) fail();
      fmt = Object.freeze({ channels, sampleRate, bits, blockAlign });
    } else if (kind === 'data') {
      if (dataSize !== null || size === 0) fail();
      dataSize = size;
    }
    at = end + (size & 1);
  }
  if (at !== bytes.length || !fmt || dataSize === null || dataSize % fmt.blockAlign !== 0) fail();
  const frames = dataSize / fmt.blockAlign;
  if (!Number.isSafeInteger(frames) || frames <= 0) fail();
  const durationMs = Number(ceilDiv(BigInt(frames) * 1000n, BigInt(fmt.sampleRate)));
  if (!Number.isSafeInteger(durationMs) || durationMs <= 0 || durationMs > REVIEWED_STT_MAX_DURATION_MS) fail();
  return Object.freeze({
    sha256: createHash('sha256').update(bytes).digest('hex'),
    byteLength: bytes.length,
    sampleRate: fmt.sampleRate,
    channels: fmt.channels,
    bitsPerSample: fmt.bits,
    frames,
    durationMs,
    billableMs: Math.max(10_000, durationMs),
  });
}
function markupRatio(value:string):Readonly<{numerator:bigint;denominator:bigint}>{
 if(typeof value!=='string'||!/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(value))fail();
 const [whole,fraction='']=value.split('.');
 if(fraction.length>18||whole.length+fraction.length>38)fail();
 const numerator=BigInt(whole+fraction),denominator=10n**BigInt(fraction.length);
 if(numerator<=0n)fail();
 return {numerator,denominator};
}
export function quoteReviewedTranscription(args: Readonly<{
  profile: ReviewedTranscriptionProfile;
  billableMs: number;
  markup: string;
}>) {
  const { profile } = args;
  if (
    profile.adapterContract !== 'groq-pcm-wav-transcription-v1' ||
    profile.mediaContract !== 'pcm-wav-v1' ||
    profile.minimumBillableMs !== 10_000 ||
    profile.maxFileBytes !== REVIEWED_STT_MAX_FILE_BYTES ||
    !Number.isSafeInteger(args.billableMs) ||
    args.billableMs < profile.minimumBillableMs ||
    args.billableMs > REVIEWED_STT_MAX_DURATION_MS
  ) fail();
  const supplierMaxUsdMicro=ceilDiv(
    BigInt(profile.supplierRateUsdMicroPerHour)*BigInt(args.billableMs),
    HOUR_MS,
  );
  const supplierMaxMicrocredits=ceilDiv(
    supplierMaxUsdMicro,
    MICRO_USD_PER_MICROCREDIT,
  );
  const markup=markupRatio(args.markup);
  const retailMaxMicrocredits=ceilDiv(
    supplierMaxUsdMicro*markup.numerator,
    MICRO_USD_PER_MICROCREDIT*markup.denominator,
  );
  if(
    supplierMaxUsdMicro<=0n||
    supplierMaxMicrocredits<=0n||
    retailMaxMicrocredits<=0n||
    retailMaxMicrocredits>9_223_372_036_854_775_807n
  )fail();
  return Object.freeze({
    model:profile.modelSlug,
    supplierRateUsdMicroPerHour:profile.supplierRateUsdMicroPerHour,
    billableMs:args.billableMs,
    supplierMaxUsdMicro,
    supplierMaxMicrocredits,
    retailMaxMicrocredits,
    formulaVersion:'groq-whisper-duration-v1' as const,
    supplierFormulaVersion:'groq-whisper-duration-usd-micro-v1' as const,
  });
}
