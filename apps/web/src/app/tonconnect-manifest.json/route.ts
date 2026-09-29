import { tonConfig,tonJson,tonError } from '@/lib/ton-wallet/http';
export const dynamic='force-dynamic';
export async function GET(){try{const config=tonConfig();return tonJson({url:config.origin,name:'AI Aggregator',iconUrl:config.origin+'/icon.svg'});}catch(e){return tonError(e);}}
