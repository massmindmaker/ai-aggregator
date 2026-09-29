/** Process-owned STT capability/pricing evidence. Database routing alone is never authority. */
export type ReviewedTranscriptionIdentity = Readonly<{
  modelSlug: string;
  modelType: string;
  upstreamId: string;
  upstreamModelId: string;
  adapterKey: string;
}>;
export type ReviewedTranscriptionProfile = ReviewedTranscriptionIdentity & Readonly<{
  version: 1;
  profileId: string;
  revision: number;
  adapterContract: 'groq-pcm-wav-transcription-v1';
  supplierRateUsdMicroPerHour: 111000;
  pricePerAudioSecondCents: '0.0030833333';
  minimumBillableMs: 10000;
  maxFileBytes: 25000000;
  mediaContract: 'pcm-wav-v1';
  evidence: readonly Readonly<{ url: string; checkedAt: string }>[];
}>;

const entries: ReviewedTranscriptionProfile[] = [
  {
    version: 1,
    profileId: 'groq-whisper-large-v3-stt-v1',
    revision: 1,
    modelSlug: 'whisper-large-v3',
    modelType: 'audio',
    upstreamId: 'groq',
    upstreamModelId: 'whisper-large-v3',
    adapterKey: 'groq',
    adapterContract: 'groq-pcm-wav-transcription-v1',
    supplierRateUsdMicroPerHour: 111000,
    pricePerAudioSecondCents: '0.0030833333',
    minimumBillableMs: 10000,
    maxFileBytes: 25000000,
    mediaContract: 'pcm-wav-v1',
    evidence: [
      { url: 'https://console.groq.com/docs/speech-to-text', checkedAt: '2026-09-29' },
      { url: 'https://console.groq.com/docs/model/whisper-large-v3', checkedAt: '2026-09-29' },
    ],
  },

];

const keys = ['modelSlug', 'modelType', 'upstreamId', 'upstreamModelId', 'adapterKey'] as const;
const ids = new Set<string>();
const tuples = new Set<string>();
for (const profile of entries) {
  const tuple = JSON.stringify(keys.map((key) => profile[key]));
  if (
    !profile.profileId ||
    ids.has(profile.profileId) ||
    tuples.has(tuple) ||
    profile.version !== 1 ||
    !Number.isSafeInteger(profile.revision) ||
    profile.revision < 1 ||
    profile.modelType !== 'audio' ||
    profile.upstreamId !== 'groq' ||
    profile.adapterKey !== 'groq' ||
    profile.adapterContract !== 'groq-pcm-wav-transcription-v1' ||
    profile.supplierRateUsdMicroPerHour !== 111000 ||
    profile.pricePerAudioSecondCents !== '0.0030833333' ||
    profile.minimumBillableMs !== 10000 ||
    profile.maxFileBytes !== 25000000 ||
    profile.mediaContract !== 'pcm-wav-v1' ||
    profile.evidence.length === 0 ||
    profile.evidence.some((item) => new URL(item.url).protocol !== 'https:' || !/^\d{4}-\d{2}-\d{2}$/.test(item.checkedAt))
  ) {
    throw new Error('Invalid reviewed transcription manifest');
  }
  ids.add(profile.profileId);
  tuples.add(tuple);
  profile.evidence.forEach(Object.freeze);
  Object.freeze(profile.evidence);
  Object.freeze(profile);
}
export const reviewedTranscriptionProfiles: readonly ReviewedTranscriptionProfile[] = Object.freeze(entries);

export function findReviewedTranscriptionProfile(identity: ReviewedTranscriptionIdentity): ReviewedTranscriptionProfile | null {
  return reviewedTranscriptionProfiles.find((profile) => keys.every((key) => profile[key] === identity[key])) ?? null;
}
