import { auth } from '@/auth';
import { tonConfig,tonError,tonJson,TonWebError } from '@/lib/ton-wallet/http';
import { checkoutOptions } from '@/lib/ton-wallet/checkout-service';
export const dynamic='force-dynamic';
export async function GET(){try{tonConfig();const session=await auth();if(!session?.user?.id)throw new TonWebError('AUTHENTICATION_REQUIRED',401);return tonJson(await checkoutOptions(session.user.id));}catch(error){return tonError(error);}}
