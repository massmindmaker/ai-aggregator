/** TON Connect v2 proof: bounded known-contract parsing, no RPC and no private key custody. */
import { createHash,createPublicKey,timingSafeEqual,verify } from 'node:crypto';
import { Cell,loadStateInit } from '@ton/core';
export interface TonWalletProofInput{
 address:string;network:'-3';publicKey:string;walletStateInit:string;
 proof:{timestamp:string;domain:{lengthBytes:number;value:string};payload:string;signature:string};
}
export interface TonWalletProofContext{domain:string;payload:string;network:'-3';issuedAtMs:number;expiresAtMs:number;nowMs:number;}
export interface VerifiedTonWallet{address:string;network:'-3';publicKey:string;walletVersion:'v4r2'|'v5r1';codeHash:string;proofDigest:string;}
const codes=Object.freeze({v4r2:'feb5ff6820e2ff0d9483e7e0d62c817d846789fb4ae580c878866d959dabd5c0',v5r1:'20834b7b72b112147e1b2fb457b84e74d1a30f04f737d4f62a668e9552d2b72f'});
const hash=(value:Uint8Array|string)=>createHash('sha256').update(value).digest();
function invalid():never{throw Error('TON_WALLET_PROOF_INVALID');}
function record(value:unknown,names:readonly string[]):Record<string,unknown>{
 if(value===null||typeof value!=='object'||Array.isArray(value)||Object.getPrototypeOf(value)!==Object.prototype)invalid();
 const keys=Reflect.ownKeys(value);if(keys.length!==names.length||keys.some(k=>typeof k!=='string'||!names.includes(k)))invalid();
 const output:Record<string,unknown>={};for(const key of names){const d=Object.getOwnPropertyDescriptor(value,key);if(!d||!('value'in d)||!d.enumerable)invalid();output[key]=d.value;}return output;
}
function text(value:unknown,min:number,max:number,pattern?:RegExp):string{
 if(typeof value!=='string'||value.length<min||value.length>max||value.trim()!==value||/[\u0000-\u001f\u007f]/.test(value)||(pattern&&pattern.exec(value)?.[0]!==value))invalid();return value;
}
function seconds(value:unknown):string{
 if(typeof value==='number'){if(!Number.isSafeInteger(value)||value<0)invalid();value=String(value);}
 const exact=text(value,1,16,/^(0|[1-9][0-9]*)$/);if(BigInt(exact)>BigInt(Number.MAX_SAFE_INTEGER))invalid();return exact;
}
function base64(value:string,maximum:number,exact?:number):Buffer{
 if(value.length>maximum*2||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value))invalid();
 const bytes=Buffer.from(value,'base64');if(bytes.length>maximum||bytes.length===0||(exact!==undefined&&bytes.length!==exact)||bytes.toString('base64')!==value)invalid();return bytes;
}
export function parseTonWalletProofInput(value:unknown):TonWalletProofInput{
 const r=record(value,['address','network','publicKey','walletStateInit','proof']),p=record(r.proof,['timestamp','domain','payload','signature']),d=record(p.domain,['lengthBytes','value']);
 if(r.network!=='-3'||!Number.isSafeInteger(d.lengthBytes)||Number(d.lengthBytes)<1||Number(d.lengthBytes)>300)invalid();
 return {address:text(r.address,66,66,/^0:[a-f0-9]{64}$/),network:'-3',publicKey:text(r.publicKey,64,64,/^[a-f0-9]{64}$/),walletStateInit:text(r.walletStateInit,16,16384),proof:{timestamp:seconds(p.timestamp),domain:{lengthBytes:Number(d.lengthBytes),value:text(d.value,3,300)},payload:text(p.payload,32,256),signature:text(p.signature,88,88)}};
}

/** Reject bogus BoC allocation counts before entering the general cell decoder. */
function boundedStateInit(boc:Buffer):Cell{
 if(boc.length<12||boc.readUInt32BE(0)!==0xb5ee9c72)invalid();
 const flags=boc[4],size=flags&7,offset=boc[5];if(size<1||size>4||offset<1||offset>4||(flags&0x38)!==0)invalid();
 let at=6;const uint=(bytes:number)=>{if(at+bytes>boc.length)invalid();const value=boc.readUIntBE(at,bytes);at+=bytes;return value;};
 const cells=uint(size),roots=uint(size),absent=uint(size),dataBytes=uint(offset);
 if(cells<1||cells>128||roots!==1||absent!==0||dataBytes>12288||at+size+((flags&0x80)?cells*offset:0)+dataBytes+((flags&0x40)?4:0)!==boc.length)invalid();
 const parsed=Cell.fromBoc(boc);if(parsed.length!==1)invalid();
 const seen=new Set<Cell>(),queue:[Cell,number][]=[[parsed[0],0]];
 while(queue.length){const [cell,depth]=queue.pop()!;if(depth>24||cell.isExotic)invalid();if(seen.has(cell))continue;seen.add(cell);if(seen.size>128)invalid();for(const next of cell.refs)queue.push([next,depth+1]);}
 return parsed[0];
}
export function verifyTonWalletProof(value:unknown,expected:TonWalletProofContext):VerifiedTonWallet{
 try{
  const p=parseTonWalletProofInput(value);
  if(expected.network!=='-3'||!Number.isSafeInteger(expected.issuedAtMs)||!Number.isSafeInteger(expected.expiresAtMs)||!Number.isSafeInteger(expected.nowMs)||expected.expiresAtMs<=expected.issuedAtMs||expected.expiresAtMs-expected.issuedAtMs>120000||expected.nowMs<expected.issuedAtMs||expected.nowMs>=expected.expiresAtMs)invalid();
  const domain=text(expected.domain,3,300);if(!domain.includes('.')||new URL('https://'+domain).host!==domain||p.proof.domain.value!==domain||p.proof.domain.lengthBytes!==Buffer.byteLength(domain,'utf8')||p.proof.payload!==expected.payload)invalid();
  const timestamp=Number(p.proof.timestamp);if(timestamp<Math.floor(expected.issuedAtMs/1000)||timestamp*1000>=expected.expiresAtMs||timestamp>Math.floor(expected.nowMs/1000)+30)invalid();
  const stateCell=boundedStateInit(base64(p.walletStateInit,12288)),slice=stateCell.beginParse(),state=loadStateInit(slice);slice.endParse();
  if(!state.code||!state.data||state.splitDepth!==undefined||state.special!==undefined||(state.libraries&&state.libraries.size!==0)||'0:'+stateCell.hash().toString('hex')!==p.address)invalid();
  const codeHash=state.code.hash().toString('hex');const walletVersion=codeHash===codes.v4r2?'v4r2':codeHash===codes.v5r1?'v5r1':null;if(!walletVersion)invalid();
  const data=state.data.beginParse();if(walletVersion==='v5r1'&&!data.loadBit())invalid();
  if(data.loadUint(32)!==0)invalid();data.loadUint(32);const publicKey=data.loadBuffer(32);
  // Standard initial state has no plugins/extensions. Deployed state is not a StateInit.
  if(data.remainingBits!==1||data.remainingRefs!==0||data.loadBit())invalid();data.endParse();
  if(!timingSafeEqual(publicKey,Buffer.from(p.publicKey,'hex')))invalid();
  const length=Buffer.alloc(4),workchain=Buffer.alloc(4),time=Buffer.alloc(8);length.writeUInt32LE(p.proof.domain.lengthBytes);workchain.writeInt32BE(0);time.writeBigUInt64LE(BigInt(p.proof.timestamp));
  const message=Buffer.concat([Buffer.from('ton-proof-item-v2/'),workchain,Buffer.from(p.address.slice(2),'hex'),length,Buffer.from(domain,'utf8'),time,Buffer.from(p.proof.payload,'utf8')]);
  const digest=hash(Buffer.concat([Buffer.from([255,255]),Buffer.from('ton-connect'),hash(message)]));
  const key=createPublicKey({key:Buffer.concat([Buffer.from('302a300506032b6570032100','hex'),publicKey]),format:'der',type:'spki'});
  if(!verify(null,digest,key,base64(p.proof.signature,64,64)))invalid();
  return {address:p.address,network:'-3',publicKey:p.publicKey,walletVersion,codeHash,proofDigest:hash(JSON.stringify(p)).toString('hex')};
 }catch{invalid();}
}
