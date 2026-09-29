import { randomUUID } from 'node:crypto';
import { Client,Pool } from 'pg';
import { withOwnedAuthorDb } from './author-owned-db.native.fixture';
import type { TonPaymentDatabase } from '../../src/ton-payment-types';
export async function withWalletAuthDb(run:(f:{db:TonPaymentDatabase;query:(text:string,values?:unknown[])=>Promise<any[]>;user:string;other:string;url:string})=>Promise<void>){
 await withOwnedAuthorDb(async(_,url)=>{
  const pool=new Pool({connectionString:url,ssl:false,max:4}),root=new Client({connectionString:url,ssl:false});await root.connect();
  const db:TonPaymentDatabase={transaction:async fn=>{const c=await pool.connect();await c.query('BEGIN');try{const result=await fn({query:async config=>{const r=await c.query(config.text,[...config.values]);return {rows:r.rows,rowCount:r.rowCount};}});await c.query('COMMIT');return result;}catch(error){await c.query('ROLLBACK');throw error;}finally{c.release();}}};
  const query=async(text:string,values:unknown[]=[])=> (await root.query(text,values)).rows;
  try{const user=randomUUID(),other=randomUUID();await query("INSERT INTO users(id,email,password_hash) VALUES($1,$2,'fixture-password-hash'),($3,$4,'fixture-password-hash')",[user,user+'@example.test',other,other+'@example.test']);await run({db,query,user,other,url});}
  finally{await pool.end();await root.end();}
 });
}
