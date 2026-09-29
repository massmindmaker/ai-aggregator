import { describe,expect,it,vi } from 'vitest';
import { beginCell } from '@ton/core';
import { sendOwnedTonCheckout } from '../lib/ton-wallet/send-once';
const tx={network:'-3',from:'0:'+'1'.repeat(64),validUntil:Math.floor(Date.now()/1000)+120,messages:[{address:'0:'+'2'.repeat(64),amount:'1001',payload:beginCell().storeUint(0,32).storeStringTail('invoice:reference').endCell().toBoc().toString('base64')}]};
const invoice={reference:'invoice:reference',expectedSender:tx.from,recipient:tx.messages[0].address,amountAtomic:'1001',expiresAt:new Date(tx.validUntil*1000).toISOString()};
const setup=()=>({claim:vi.fn().mockResolvedValue({didClaim:true,attemptId:'00000000-0000-4000-8000-000000000001',transaction:tx}),send:vi.fn().mockResolvedValue({boc:'synthetic'}),report:vi.fn().mockResolvedValue({recorded:true,creditGranted:false,outcome:'client_sent'})});
describe('one-owned wallet send',()=>{
 it('validates claim and sends exactly once then records advisory only',async()=>{const d=setup();expect(await sendOwnedTonCheckout(invoice,tx.from,d)).toEqual({state:'wallet_ack'});expect(d.send).toHaveBeenCalledTimes(1);expect(d.report).toHaveBeenCalledWith({attemptId:'00000000-0000-4000-8000-000000000001',outcome:'client_sent'});});
 it.each([null,{didClaim:false,transaction:null},{didClaim:true,attemptId:'bad',transaction:tx},{didClaim:true,attemptId:'00000000-0000-4000-8000-000000000001',transaction:{...tx,messages:[{...tx.messages[0],amount:'1002'}]}}])('never sends on unknown/malformed/not-owned claim',async result=>{const d=setup();d.claim.mockResolvedValue(result);expect((await sendOwnedTonCheckout(invoice,tx.from,d)).state).toBe('unknown');expect(d.send).not.toHaveBeenCalled();});
 it('rejects changed connectedwallet before claiming',async()=>{const d=setup();expect((await sendOwnedTonCheckout(invoice,'0:'+'3'.repeat(64),d)).state).toBe('wallet_changed');expect(d.claim).not.toHaveBeenCalled();});
 it('does not retry SDK failures and never changes result to paid',async()=>{const d=setup();d.send.mockRejectedValue(Error('lost response'));expect((await sendOwnedTonCheckout(invoice,tx.from,d)).state).toBe('unknown');expect(d.send).toHaveBeenCalledTimes(1);expect(d.report).toHaveBeenCalledWith(expect.objectContaining({outcome:'client_unknown'}));});
 it('refuses a changed comment payload rather than sending funds to the wrong invoice',async()=>{const d=setup();d.claim.mockResolvedValue({didClaim:true,attemptId:'00000000-0000-4000-8000-000000000001',transaction:{...tx,messages:[{...tx.messages[0],payload:'AAAAAA=='}]}});expect((await sendOwnedTonCheckout(invoice,tx.from,d)).state).toBe('unknown');expect(d.send).not.toHaveBeenCalled();});

});
