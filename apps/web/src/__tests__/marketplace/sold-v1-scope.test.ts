import { describe,expect,it } from 'vitest';
import { getAllModels,getModelBySlug } from '@/lib/marketplace/catalog';
import { getAllScenarios } from '@/lib/marketplace/scenarios';

describe('sold v1 marketplace scope',()=>{
 it('does not expose speech-to-text models or transcription tags',()=>{
  const models=getAllModels();
  expect(models.length).toBeGreaterThan(0);
  expect(models.some(m=>['speech-to-text','image','video','audio'].includes(m.type))).toBe(false);
  expect(models.some(m=>m.tags.some(t=>['stt','transcription'].includes(t.toLowerCase())))).toBe(false);
  expect(getModelBySlug('whisper-large-v3')).toBeUndefined();
  expect(getModelBySlug('openai/whisper-large-v3')).toBeUndefined();
 });
 it('does not advertise an STT scenario in sold v1',()=>{
  expect(getAllScenarios().some(s=>s.modality==='stt'||/whisper/i.test(s.recommendedModelSlug))).toBe(false);
 });
});
