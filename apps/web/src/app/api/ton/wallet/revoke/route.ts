import { auth } from '@/auth';
import { checkTonOrigin,readTonBody,revokeSchema,tonJson,tonError,TonWebError } from '@/lib/ton-wallet/http';
import { revokeWallet } from '@/lib/ton-wallet/service';
export const runtime='nodejs';
export async function POST(req:Request){try{checkTonOrigin(req);const session=await auth();if(!session?.user?.id)throw new TonWebError('AUTHENTICATION_REQUIRED',401);const input=await readTonBody(req,revokeSchema);return tonJson(await revokeWallet(session.user.id,input));}catch(e){return tonError(e);}}
