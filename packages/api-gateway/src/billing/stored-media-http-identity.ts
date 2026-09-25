import { createHash } from 'node:crypto';
import { captureDeclaredSessionId } from './admission-internal';
import { parseAdmissionJsonObject } from './admission-result';

export type StoredMediaRouteKind = 'image' | 'video' | 'audio_speech';
export type StoredMediaMode = 'auto' | 'fastest' | 'cheapest' | 'balanced' | 'ru-only';
export type StoredMediaHttpIdentity = Readonly<{
  contractVersion: 4;
  routeKind: StoredMediaRouteKind;
  billingMode: 'stored';
  idempotencyKeyDigest: string;
  requestFingerprint: string;
  requestedMode: StoredMediaMode | null;
  declaredSessionId: string | null;
  body: Readonly<Record<string, unknown>>;
}>;

const BAD = 'INVALID_STORED_MEDIA_HTTP_IDENTITY';
function bad(): never { throw new TypeError(BAD); }
function sha(value: string): string { return createHash('sha256').update(value, 'utf8').digest('hex'); }
function idem(value: unknown): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 128 || /[^A-Za-z0-9._:-]/.test(value)) bad();
  return value;
}
function mode(value: unknown): StoredMediaMode {
  if (!['auto','fastest','cheapest','balanced','ru-only'].includes(String(value))) bad();
  return value as StoredMediaMode;
}
function text(value: unknown, max = 32768): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > max) bad();
  for (let i=0;i<value.length;i++) {
    const c=value.charCodeAt(i);
    if (c>=0xd800 && c<=0xdbff) { const n=value.charCodeAt(++i); if (!(n>=0xdc00&&n<=0xdfff)) bad(); }
    else if (c>=0xdc00&&c<=0xdfff) bad();
  }
  return value;
}
function optionalText(value: unknown, max = 2048): string | undefined {
  return value === undefined ? undefined : text(value, max);
}
function url(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  const raw=text(value,4096); let parsed:URL;
  try { parsed=new URL(raw); } catch { return bad(); }
  if (!['http:','https:'].includes(parsed.protocol) || parsed.username || parsed.password) bad();
  return raw;
}
function allowed(object: Record<string, unknown>, names: readonly string[]): void {
  if (Object.keys(object).some((key)=>!names.includes(key))) bad();
}
function frozenBody(routeKind: StoredMediaRouteKind, raw: Record<string, unknown>): Readonly<Record<string, unknown>> {
  if (typeof raw.model !== 'string') bad();
  const model=text(raw.model,128);
  if (routeKind === 'image') {
    allowed(raw,['model','prompt','n','size','negative_prompt','reference_image_url','aiag_mode']);
    const n=raw.n===undefined?1:raw.n;
    if (!Number.isSafeInteger(n) || Number(n)<1 || Number(n)>4) bad();
    return Object.freeze({model,prompt:text(raw.prompt),n:Number(n),
      ...(raw.size===undefined?{}:{size:optionalText(raw.size,128)}),
      ...(raw.negative_prompt===undefined?{}:{negative_prompt:optionalText(raw.negative_prompt,32768)}),
      ...(raw.reference_image_url===undefined?{}:{reference_image_url:url(raw.reference_image_url)})});
  }
  if (routeKind === 'video') {
    allowed(raw,['model','prompt','duration_s','aspect_ratio','image_url','aiag_mode']);
    if (raw.duration_s!==undefined && (!Number.isSafeInteger(raw.duration_s)||Number(raw.duration_s)<=0||Number(raw.duration_s)>3600)) bad();
    return Object.freeze({model,prompt:text(raw.prompt),
      ...(raw.duration_s===undefined?{}:{duration_s:Number(raw.duration_s)}),
      ...(raw.aspect_ratio===undefined?{}:{aspect_ratio:optionalText(raw.aspect_ratio,64)}),
      ...(raw.image_url===undefined?{}:{image_url:url(raw.image_url)})});
  }
  allowed(raw,['model','input','voice','format','aiag_mode']);
  return Object.freeze({model,input:text(raw.input),
    ...(raw.voice===undefined?{}:{voice:optionalText(raw.voice,128)}),
    ...(raw.format===undefined?{}:{format:optionalText(raw.format,64)})});
}

export function captureStoredMediaHttpIdentity(args: Readonly<{
  routeKind: StoredMediaRouteKind;
  body: unknown;
  idempotencyKey: unknown;
  declaredSessionId: unknown;
  byokKeyPresent?: boolean;
}>): StoredMediaHttpIdentity {
  try {
    if (!['image','video','audio_speech'].includes(args.routeKind) || args.byokKeyPresent) bad();
    const raw=parseAdmissionJsonObject(args.body);
    const requestedMode=Object.hasOwn(raw,'aiag_mode')?mode(raw.aiag_mode):null;
    const body=frozenBody(args.routeKind,raw);
    const declaredSessionId=captureDeclaredSessionId(args.declaredSessionId);
    const canonical=JSON.stringify([4,args.routeKind,'stored',body.model,requestedMode,declaredSessionId,body]);
    return Object.freeze({
      contractVersion:4, routeKind:args.routeKind, billingMode:'stored',
      idempotencyKeyDigest:sha(idem(args.idempotencyKey)),
      requestFingerprint:sha(canonical), requestedMode, declaredSessionId, body,
    });
  } catch { return bad(); }
}
