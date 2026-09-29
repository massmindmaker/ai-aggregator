import { tonConfig,tonJson } from '@/lib/ton-wallet/http';
export const dynamic='force-dynamic';
export async function GET(){try{const config=tonConfig();return tonJson({enabled:true,network:config.network,manifestUrl:config.origin+'/tonconnect-manifest.json'});}catch{return tonJson({enabled:false});}}
