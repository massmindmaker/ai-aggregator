import { z } from 'zod';
import type { TonCheckoutPolicy } from '@aiag/database';
import { TonWebError } from './http';
const amount=z.string().regex(/^(0|[1-9][0-9]{0,18})$/).refine(x=>BigInt(x)<=9223372036854775807n);
const positive=amount.refine(x=>BigInt(x)>0n);
const label=z.string().min(1).max(128).regex(/^[a-zA-Z0-9._:-]+$/);
const schema=z.object({revision:label,recipient:z.string().regex(/^0:[a-f0-9]{64}$/),network:z.literal('tvm:-3'),finalityPolicyId:label,verifierVersion:label,quoteLifetimeSeconds:z.number().int().min(30).max(600),maxFxAgeSeconds:z.number().int().min(1).max(86400),
 fx:z.object({numerator:positive,denominator:positive,rounding:z.enum(['floor','ceil','half-up']),source:label,observedAtMs:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),expiresAtMs:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)}).strict(),
 additionalFeeAtomic:amount,packages:z.array(z.object({id:z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),label:z.string().min(1).max(120),grantMicrocredits:positive}).strict()).min(1).max(20)}).strict();
export function parseCheckoutPolicy(raw:string|undefined):TonCheckoutPolicy{
 try{if(!raw||raw.length>16384)throw Error();const policy=schema.parse(JSON.parse(raw));if(new Set(policy.packages.map(x=>x.id)).size!==policy.packages.length)throw Error();return policy;}catch{throw new TonWebError('TON_CHECKOUT_POLICY_UNAVAILABLE',503);}
}
