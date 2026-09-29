import { describe,expect,it } from 'vitest';
import { getAllModels,getModelBySlug } from '@/lib/marketplace/catalog';
import { getAllScenarios } from '@/lib/marketplace/scenarios';

describe('sold v1 marketplace scope',()=>{
 it('does not expose speech-to-text models or transcription tags',()=>{
  const models=getAllModels();
  expect(models.length).toBeGreaterThan(0);
  // Only transcription is withdrawn from sale (migration 0093_depublish_stt_v1).
  // Image/video/TTS remain sold — durable async media was accepted for them.
  expect(models.some(m=>m.type==='speech-to-text')).toBe(false);
  expect(models.some(m=>m.tags.some(t=>['stt','transcription'].includes(t.toLowerCase())))).toBe(false);
  expect(getModelBySlug('whisper-large-v3')).toBeUndefined();
  expect(getModelBySlug('openai/whisper-large-v3')).toBeUndefined();
 });
 it('does not advertise an STT scenario in sold v1',()=>{
 // 'stt' is intentionally absent from ScenarioModality: STT is backlog-only in sold v1
 // (migration 0093_depublish_stt_v1). Guard against any future STT modality creeping back.
 const forbiddenModalities: readonly string[]=['stt','transcription','speech-to-text','audio'];
 expect(getAllScenarios().some(s=>forbiddenModalities.includes(s.modality))).toBe(false);
 expect(getAllScenarios().some(s=>/whisper/i.test(s.recommendedModelSlug))).toBe(false);
 expect(getAllScenarios().some(s=>s.tags.some(t=>/whisper|stt|transcription/i.test(t)))).toBe(false);
 });
});
