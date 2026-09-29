import { auth } from '@/auth';
import { checkTonOrigin,tonBrowser,readTonBody,challengeSchema,tonJson,tonError,TonWebError } from '@/lib/ton-wallet/http';
import { issueWallet } from '@/lib/ton-wallet/service';
export const runtime='nodejs';
export async function POST(req:Request){try{const config=checkTonOrigin(req),input=await readTonBody(req,challengeSchema);const session=input.purpose==='link'?await auth():null;if(input.purpose==='link'&&!session?.user?.id)throw new TonWebError('AUTHENTICATION_REQUIRED',401);
 const browser=tonBrowser(req,config,true);const result=await issueWallet({purpose:input.purpose,actorUserId:session?.user.id??null,browserHash:browser.hash,domain:config.domain});
 return tonJson(result,200,browser.cookie?{'Set-Cookie':browser.cookie}:{});
}catch(e){return tonError(e);}}
