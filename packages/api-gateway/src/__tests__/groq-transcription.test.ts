import { afterEach,beforeEach,describe,expect,it,vi } from 'vitest';
const m=vi.hoisted(()=>({fetch:vi.fn()}));
vi.mock('../upstreams/fetch-upstream',()=>({fetchUpstream:m.fetch}));
import { groqUpstream } from '../upstreams/groq';

const audio=new Uint8Array([82,73,70,70,1,2,3,4]);
beforeEach(()=>{m.fetch.mockReset();process.env.GROQ_API_KEY='test-secret';delete process.env.AIAG_EGRESS_PROXY_URL;});
afterEach(()=>{delete process.env.GROQ_API_KEY;delete process.env.AIAG_EGRESS_PROXY_URL;});

describe('reviewed Groq transcription mechanic',()=>{
 it('posts one bounded multipart request and returns only transcript text',async()=>{
  m.fetch.mockResolvedValue(new Response(JSON.stringify({text:'привет',duration:1.25,x_groq:{id:'provider-id-1'}}),{status:200,headers:{'content-type':'application/json'}}));
  const out=await groqUpstream.admittedTranscription!.execute({modelId:'whisper-large-v3',audioBytes:audio,language:'ru'});
  expect(out).toEqual({text:'привет',providerDurationMs:1250,providerResponseId:'provider-id-1'});
  expect(m.fetch).toHaveBeenCalledTimes(1);
  const [url,init,proxy]=m.fetch.mock.calls[0]!;
  expect(url).toBe('https://api.groq.com/openai/v1/audio/transcriptions');
  expect(proxy).toBeUndefined();
  expect(init).toMatchObject({method:'POST',maxRedirects:0,maxBufferedResponseBytes:1048576});
  expect((init.headers as Record<string,string>).authorization).toBe('Bearer test-secret');
  expect(init.body).toBeInstanceOf(FormData);
  const form=init.body as FormData;
  expect(form.get('model')).toBe('whisper-large-v3');
  expect(form.get('response_format')).toBe('verbose_json');
  expect(form.get('language')).toBe('ru');
  const file=form.get('file');
  expect(file).toBeInstanceOf(File);
  expect((file as File).size).toBe(audio.length);
 });
 it('pins reviewed model and refuses proxy egress before network',async()=>{
  await expect(groqUpstream.admittedTranscription!.execute({modelId:'other',audioBytes:audio})).rejects.toThrow();
  await expect(groqUpstream.admittedTranscription!.execute({modelId:'whisper-large-v3',audioBytes:audio,egressProxyUrl:'http://proxy.invalid'})).rejects.toThrow();
  process.env.AIAG_EGRESS_PROXY_URL='http://127.0.0.1:8080';
  await expect(groqUpstream.admittedTranscription!.execute({modelId:'whisper-large-v3',audioBytes:audio})).rejects.toThrow();
  expect(m.fetch).not.toHaveBeenCalled();
 });
 it('fails closed without provider key',async()=>{
  delete process.env.GROQ_API_KEY;
  await expect(groqUpstream.admittedTranscription!.execute({modelId:'whisper-large-v3',audioBytes:audio})).rejects.toThrow();
  expect(m.fetch).not.toHaveBeenCalled();
 });
 it.each([
   new Response('not-json',{status:200,headers:{'content-type':'text/plain'}}),
   new Response(JSON.stringify({text:7,duration:1}),{status:200,headers:{'content-type':'application/json'}}),
   new Response(JSON.stringify({text:'ok'}),{status:200,headers:{'content-type':'application/json'}}),
   new Response(JSON.stringify({text:'ok',duration:-1}),{status:200,headers:{'content-type':'application/json'}}),
   new Response(JSON.stringify({text:'x'.repeat(1_048_577),duration:1}),{status:200,headers:{'content-type':'application/json'}}),
   new Response('{}',{status:500,headers:{'content-type':'application/json'}}),
 ])('rejects malformed/provider-error response without retry',async response=>{
  m.fetch.mockResolvedValue(response);
  await expect(groqUpstream.admittedTranscription!.execute({modelId:'whisper-large-v3',audioBytes:audio})).rejects.toThrow();
  expect(m.fetch).toHaveBeenCalledTimes(1);
 });
});
