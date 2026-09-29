import { auth } from '@/auth';
import { z } from 'zod';
import { checkTonOrigin,tonError,tonJson,readTonBody,TonWebError } from '@/lib/ton-wallet/http';
import { claimCheckout,recordCheckoutClientReport } from '@/lib/ton-wallet/checkout-service';
export const runtime='nodejs';
const schema=z.discriminatedUnion('action',[z.object({action:z.literal('claim')}).strict(),z.object({action:z.literal('report'),attemptId:z.string().uuid(),outcome:z.enum(['client_sent','client_rejected','client_unknown'])}).strict()]);
export async function POST(req:Request,{params}:{params:Promise<{id:string}>}){try{checkTonOrigin(req);const session=await auth();if(!session?.user?.id)throw new TonWebError('AUTHENTICATION_REQUIRED',401);const parsed=z.string().uuid().safeParse((await params).id);if(!parsed.success)throw new TonWebError('TON_CHECKOUT_INVALID');const input=await readTonBody(req,schema);return tonJson(input.action==='claim'?await claimCheckout(session.user.id,parsed.data):await recordCheckoutClientReport(session.user.id,{checkoutId:parsed.data,attemptId:input.attemptId,outcome:input.outcome}));}catch(error){return tonError(error);}}
