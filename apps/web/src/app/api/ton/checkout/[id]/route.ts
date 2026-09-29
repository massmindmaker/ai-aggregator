import { auth } from '@/auth';
import { z } from 'zod';
import { tonConfig,tonError,tonJson,TonWebError } from '@/lib/ton-wallet/http';
import { readCheckout } from '@/lib/ton-wallet/checkout-service';
export const dynamic='force-dynamic';
export async function GET(_req:Request,{params}:{params:Promise<{id:string}>}){try{tonConfig();const session=await auth();if(!session?.user?.id)throw new TonWebError('AUTHENTICATION_REQUIRED',401);const parsed=z.string().uuid().safeParse((await params).id);if(!parsed.success)throw new TonWebError('TON_CHECKOUT_INVALID');return tonJson(await readCheckout(session.user.id,parsed.data));}catch(error){return tonError(error);}}
