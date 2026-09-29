import { describe,expect,it } from 'vitest';
import { parseReviewedPcmWav,quoteReviewedTranscription } from '../billing/stored-transcription-wav';
import { reviewedTranscriptionProfiles } from '../billing/reviewed-transcription-profiles';
const v3=reviewedTranscriptionProfiles.find(p=>p.modelSlug==='whisper-large-v3')!;

function wav(args:{seconds:number;sampleRate?:number;channels?:number;bits?:number;format?:number}):Uint8Array{
 const sampleRate=args.sampleRate??16000,channels=args.channels??1,bits=args.bits??16,format=args.format??1;
 const blockAlign=channels*bits/8,frames=Math.round(args.seconds*sampleRate),dataBytes=frames*blockAlign;
 const bytes=new Uint8Array(44+dataBytes),v=new DataView(bytes.buffer);
 const text=(at:number,s:string)=>{for(let i=0;i<s.length;i++)bytes[at+i]=s.charCodeAt(i);};
 text(0,'RIFF');v.setUint32(4,36+dataBytes,true);text(8,'WAVE');text(12,'fmt ');v.setUint32(16,16,true);
 v.setUint16(20,format,true);v.setUint16(22,channels,true);v.setUint32(24,sampleRate,true);v.setUint32(28,sampleRate*blockAlign,true);v.setUint16(32,blockAlign,true);v.setUint16(34,bits,true);
 text(36,'data');v.setUint32(40,dataBytes,true);return bytes;
}
describe('reviewed PCM WAV duration',()=>{
 it('binds exact bytes and derives trusted duration',()=>{const a=wav({seconds:12.5}),p=parseReviewedPcmWav(a);expect(p).toMatchObject({durationMs:12500,billableMs:12500,sampleRate:16000,channels:1,bitsPerSample:16,byteLength:a.length});expect(p.sha256).toMatch(/^[0-9a-f]{64}$/);});
 it('uses Groq minimum billed duration without changing measured duration',()=>{const p=parseReviewedPcmWav(wav({seconds:1}));expect(p.durationMs).toBe(1000);expect(p.billableMs).toBe(10000);});
 it.each([{format:3},{channels:3},{bits:12},{sampleRate:4000},{sampleRate:200000}])('rejects unsupported PCM shape %j',shape=>expect(()=>parseReviewedPcmWav(wav({seconds:1,...shape}))).toThrow());
 it('rejects malformed/truncated/multiple or inconsistent chunks',()=>{const base=wav({seconds:1});expect(()=>parseReviewedPcmWav(base.slice(0,30))).toThrow();const corrupt=base.slice();new DataView(corrupt.buffer).setUint32(28,1,true);expect(()=>parseReviewedPcmWav(corrupt)).toThrow();const junk=base.slice();junk[0]=0;expect(()=>parseReviewedPcmWav(junk)).toThrow();});
});
describe('reviewed Groq STT quote',()=>{
 it('rounds supplier USD cost upward to microcredit granularity and applies markup once',()=>{const q=quoteReviewedTranscription({profile:v3,billableMs:10000,markup:'1.2'});expect(q).toMatchObject({supplierRateUsdMicroPerHour:111000,supplierMaxUsdMicro:309n,supplierMaxMicrocredits:31n,retailMaxMicrocredits:38n});});
 it('rejects unknown models/duration/markup',()=>{expect(()=>quoteReviewedTranscription({profile:{...v3,adapterContract:'bad' as never},billableMs:10000,markup:'1'})).toThrow();expect(()=>quoteReviewedTranscription({profile:v3,billableMs:9999,markup:'1'})).toThrow();expect(()=>quoteReviewedTranscription({profile:v3,billableMs:10000,markup:'0'})).toThrow();expect(()=>quoteReviewedTranscription({profile:v3,billableMs:10000,markup:'1x2'})).toThrow();});
});
