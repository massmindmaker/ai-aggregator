import { auth } from '@/auth';
import { tonConfig,tonJson,tonError,TonWebError } from '@/lib/ton-wallet/http';
import { listWallets } from '@/lib/ton-wallet/service';
export const dynamic='force-dynamic';
export async function GET(_req:Request){try{const config=tonConfig(),session=await auth();if(!session?.user?.id)throw new TonWebError('AUTHENTICATION_REQUIRED',401);return tonJson({wallets:await listWallets(session.user.id),network:config.network});}catch(e){return tonError(e);}}
