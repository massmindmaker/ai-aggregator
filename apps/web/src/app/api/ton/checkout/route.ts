import { auth } from '@/auth';
import { z } from 'zod';
import { checkTonOrigin,tonError,tonJson,readTonBody,TonWebError } from '@/lib/ton-wallet/http';
import { createCheckout } from '@/lib/ton-wallet/checkout-service';
export const runtime='nodejs';
const schema=z.object({packageId:z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),walletId:z.string().uuid(),idempotencyKey:z.string().regex(/^[a-zA-Z0-9_-]{1,96}$/)}).strict();
export async function POST(req:Request){try{checkTonOrigin(req);const session=await auth();if(!session?.user?.id)throw new TonWebError('AUTHENTICATION_REQUIRED',401);const input=await readTonBody(req,schema);return tonJson(await createCheckout(session.user.id,input));}catch(error){return tonError(error);}}
