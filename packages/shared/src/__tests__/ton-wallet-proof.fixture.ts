import { createHash,createPrivateKey,sign } from 'node:crypto';
import { beginCell,storeStateInit } from '@ton/core';
import { WalletContractV4 } from '@ton/ton';
import { keyPairFromSeed } from '@ton/crypto';
export function walletProofFixture(payload:string,domain='app.example.test',timestamp=Math.floor(Date.now()/1000),seedByte=7){
 const seed=Buffer.alloc(32,seedByte),pair=keyPairFromSeed(seed),wallet=WalletContractV4.create({workchain:0,publicKey:pair.publicKey});
 const wc=Buffer.alloc(4),length=Buffer.alloc(4),time=Buffer.alloc(8),domainBytes=Buffer.from(domain);wc.writeInt32BE(0);length.writeUInt32LE(domainBytes.length);time.writeBigUInt64LE(BigInt(timestamp));
 const sha=(v:Uint8Array)=>createHash('sha256').update(v).digest();const message=Buffer.concat([Buffer.from('ton-proof-item-v2/'),wc,wallet.address.hash,length,domainBytes,time,Buffer.from(payload)]);
 const digest=sha(Buffer.concat([Buffer.from([255,255]),Buffer.from('ton-connect'),sha(message)]));
 const key=createPrivateKey({key:Buffer.concat([Buffer.from('302e020100300506032b657004220420','hex'),seed]),format:'der',type:'pkcs8'});
 return {address:wallet.address.toRawString(),network:'-3',publicKey:pair.publicKey.toString('hex'),walletStateInit:beginCell().store(storeStateInit(wallet.init)).endCell().toBoc().toString('base64'),proof:{timestamp,domain:{lengthBytes:domainBytes.length,value:domain},payload,signature:sign(null,digest,key).toString('base64')}};
}
