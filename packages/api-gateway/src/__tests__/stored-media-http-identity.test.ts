import { describe, expect, it } from 'vitest';
import { captureStoredMediaHttpIdentity } from '../billing/stored-media-http-identity';
const base={idempotencyKey:'idem_1',declaredSessionId:'sid-1'};
const image={model:'flux/test',prompt:'hello',n:2,aiag_mode:'balanced'};
describe('stored media HTTP identity',()=>{
  it('captures strict image v4 identity without raw idempotency key',()=>{
    const got=captureStoredMediaHttpIdentity({...base,routeKind:'image',body:image});
    expect(got).toMatchObject({contractVersion:4,routeKind:'image',billingMode:'stored',requestedMode:'balanced',declaredSessionId:'sid-1'});
    expect(got.body).toEqual({model:'flux/test',prompt:'hello',n:2});
    expect(JSON.stringify(got)).not.toContain('idem_1');
  });
  it('fingerprint changes on body/model/mode and route kind separates identities',()=>{
    const a=captureStoredMediaHttpIdentity({...base,routeKind:'image',body:image});
    const b=captureStoredMediaHttpIdentity({...base,routeKind:'image',body:{...image,prompt:'bye'}});
    const c=captureStoredMediaHttpIdentity({...base,routeKind:'video',body:{model:'flux/test',prompt:'hello',aiag_mode:'balanced'}});
    expect(a.requestFingerprint).not.toBe(b.requestFingerprint);
    expect(a.requestFingerprint).not.toBe(c.requestFingerprint);
    expect(a.idempotencyKeyDigest).toBe(c.idempotencyKeyDigest);
  });
  it('normalizes omitted image n to one',()=>{
    expect(captureStoredMediaHttpIdentity({...base,routeKind:'image',body:{model:'m',prompt:'p'}}).body).toMatchObject({n:1});
  });
  it.each([
    {routeKind:'image' as const,body:{...image,unknown:true}},
    {routeKind:'image' as const,body:{...image,n:5}},
    {routeKind:'video' as const,body:{model:'m',prompt:'p',image_url:'file:///tmp/x'}},
    {routeKind:'audio_speech' as const,body:{model:'m',input:''}},
  ])('rejects unsupported/invalid body %#',(value)=>{
    expect(()=>captureStoredMediaHttpIdentity({...base,...value})).toThrow('INVALID_STORED_MEDIA_HTTP_IDENTITY');
  });
  it('rejects BYOK before durable identity and never serializes secret',()=>{
    const secret='provider-secret-xyz';
    expect(()=>captureStoredMediaHttpIdentity({...base,routeKind:'image',body:image,byokKeyPresent:true})).toThrow('INVALID_STORED_MEDIA_HTTP_IDENTITY');
    expect(JSON.stringify(image)).not.toContain(secret);
  });
});
