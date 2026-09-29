import { describe,expect,it } from 'vitest';
import { captureStoredTranscriptionHttpRequest,StoredTranscriptionHttpContractError } from '../billing/stored-transcription-http-identity';

function wav(seconds=1):Uint8Array{
 const sampleRate=16000,blockAlign=2,frames=Math.round(seconds*sampleRate),dataBytes=frames*blockAlign;
 const bytes=new Uint8Array(44+dataBytes),v=new DataView(bytes.buffer);
 const text=(at:number,s:string)=>{for(let i=0;i<s.length;i++)bytes[at+i]=s.charCodeAt(i);};
 text(0,'RIFF');v.setUint32(4,36+dataBytes,true);text(8,'WAVE');text(12,'fmt ');v.setUint32(16,16,true);v.setUint16(20,1,true);v.setUint16(22,1,true);
 v.setUint32(24,sampleRate,true);v.setUint32(28,sampleRate*blockAlign,true);v.setUint16(32,blockAlign,true);v.setUint16(34,16,true);
 text(36,'data');v.setUint32(40,dataBytes,true);return bytes;
}
async function request(args:{bytes?:Uint8Array;model?:string;language?:string;key?:string;filename?:string;extra?:[string,string];responseFormat?:string}={}){
 const form=new FormData();
 form.append('model',args.model??'whisper-large-v3');
 if(args.language)form.append('language',args.language);
 if(args.responseFormat)form.append('response_format',args.responseFormat);
 if(args.extra)form.append(args.extra[0],args.extra[1]);
 form.append('file',new Blob([args.bytes??wav()],{type:'audio/wav'}),args.filename??'voice.wav');
 return new Request('https://gateway.test/v1/audio/transcriptions',{method:'POST',headers:{...(args.key===undefined?{'Idempotency-Key':'idem-1'}:args.key?{'Idempotency-Key':args.key}:{})},body:form});
}
describe('stored transcription multipart identity',()=>{
 it('captures reviewed WAV facts and exact file bytes',async()=>{const bytes=wav(2.5),r=await captureStoredTranscriptionHttpRequest(await request({bytes,language:'ru'}));expect(r.identity).toMatchObject({contractVersion:1,routeKind:'audio_transcription',billingMode:'stored',parserContract:'pcm-wav-riff-v1',model:'whisper-large-v3',language:'ru',audioSha256:r.audio.sha256,audioBytes:bytes.length,durationMs:2500,billableMs:10000});expect(r.audio.bytes).toEqual(bytes);expect(r.identity.idempotencyKeyDigest).toMatch(/^[0-9a-f]{64}$/);expect(r.identity.requestFingerprint).toMatch(/^[0-9a-f]{64}$/);});
 it('is independent of multipart boundary and filename',async()=>{const bytes=wav(1),a=await captureStoredTranscriptionHttpRequest(await request({bytes,filename:'a.wav'})),b=await captureStoredTranscriptionHttpRequest(await request({bytes,filename:'different.wav'}));expect(a.identity.requestFingerprint).toBe(b.identity.requestFingerprint);});
 it('changes fingerprint for different bytes/language and rejects unlaunched turbo',async()=>{const base=await captureStoredTranscriptionHttpRequest(await request());for(const req of [request({bytes:wav(2)}),request({language:'en'})])expect((await captureStoredTranscriptionHttpRequest(await req)).identity.requestFingerprint).not.toBe(base.identity.requestFingerprint);await expect(captureStoredTranscriptionHttpRequest(await request({model:'whisper-large-v3-turbo'}))).rejects.toBeInstanceOf(StoredTranscriptionHttpContractError);});
 it('accepts standard application/octet-stream WAV uploads',async()=>{const form=new FormData();form.append('model','whisper-large-v3');form.append('file',new Blob([wav()],{type:'application/octet-stream'}),'x.wav');const r=await captureStoredTranscriptionHttpRequest(new Request('https://x.test',{method:'POST',headers:{'Idempotency-Key':'k'},body:form}));expect(r.identity.model).toBe('whisper-large-v3');});
 it.each([
  request({key:''}),request({model:'other'}),request({language:'bad language'}),request({extra:['prompt','x']}),request({responseFormat:'verbose_json'}),
 ])('rejects missing/unreviewed/ambiguous fields before dispatch',async promise=>{await expect(captureStoredTranscriptionHttpRequest(await promise)).rejects.toBeInstanceOf(StoredTranscriptionHttpContractError);});
 it('rejects duplicate model or file parts',async()=>{for(const duplicate of ['model','file'] as const){const form=new FormData();form.append('model','whisper-large-v3');form.append('file',new Blob([wav()],{type:'audio/wav'}),'a.wav');if(duplicate==='model')form.append('model','whisper-large-v3');else form.append('file',new Blob([wav()],{type:'audio/wav'}),'b.wav');const req=new Request('https://x.test',{method:'POST',headers:{'Idempotency-Key':'k'},body:form});await expect(captureStoredTranscriptionHttpRequest(req)).rejects.toBeInstanceOf(StoredTranscriptionHttpContractError);}});
 it('rejects non-multipart and oversized declared length without reading body',async()=>{const plain=new Request('https://x.test',{method:'POST',headers:{'Idempotency-Key':'k','content-type':'application/json'},body:'{}'});await expect(captureStoredTranscriptionHttpRequest(plain)).rejects.toBeInstanceOf(StoredTranscriptionHttpContractError);const form=await request();const headers=new Headers(form.headers);headers.set('content-length','26000000');const tooLarge=new Request(form.url,{method:'POST',headers,body:form.body,duplex:'half'} as RequestInit);await expect(captureStoredTranscriptionHttpRequest(tooLarge)).rejects.toBeInstanceOf(StoredTranscriptionHttpContractError);});
 it('rejects byok and invalid response_format',async()=>{const req=await request({responseFormat:'json'});req.headers.set('x-upstream-key','private');await expect(captureStoredTranscriptionHttpRequest(req)).rejects.toMatchObject({code:'UNSUPPORTED_EXECUTION_CONTRACT'});});
});
