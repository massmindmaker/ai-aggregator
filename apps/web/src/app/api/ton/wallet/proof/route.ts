import { auth } from '@/auth';
import { checkTonOrigin,tonBrowser,readTonBody,proofSchema,tonJson,tonError,TonWebError } from '@/lib/ton-wallet/http';
import { completeWallet } from '@/lib/ton-wallet/service';
export const runtime='nodejs';
export async function POST(req:Request){try{const config=checkTonOrigin(req),browser=tonBrowser(req,config),input=await readTonBody(req,proofSchema);const session=input.purpose==='link'?await auth():null;if(input.purpose==='link'&&!session?.user?.id)throw new TonWebError('AUTHENTICATION_REQUIRED',401);
 return tonJson(await completeWallet({...input,actorUserId:session?.user.id??null,browserHash:browser.hash,domain:config.domain}));
}catch(e){return tonError(e);}}
