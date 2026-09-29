import { describe,expect,it } from 'vitest';
import { Hono } from 'hono';
import { applyAiagErrorHandler } from '../lib/errors';
import { audio } from '../routes/v1/audio';

describe('v1 transcription scope',()=>{
 it('returns a truthful fixed501 without parsing or provider work',async()=>{
  const app=new Hono();applyAiagErrorHandler(app);app.route('/v1/audio',audio);
  const response=await app.request('/v1/audio/transcriptions',{method:'POST',headers:{'content-type':'multipart/form-data; boundary=x'},body:'garbage'});
  expect(response.status).toBe(501);
  expect(await response.json()).toEqual({error:{code:'UNSUPPORTED_EXECUTION_CONTRACT',message:'Audio transcription is not available in sold v1'}});
 });
});
