import { beforeEach,describe,expect,it,vi } from 'vitest';
const m=vi.hoisted(()=>({config:null as any,authorize:vi.fn(),verify:vi.fn(),find:vi.fn()}));
vi.mock('next-auth',()=>({default:(config:unknown)=>{m.config=config;return {handlers:{},auth:vi.fn(),signIn:vi.fn(),signOut:vi.fn()};}}));
vi.mock('@/lib/db',()=>({db:{query:{users:{findFirst:m.find}}}}));
vi.mock('@auth/drizzle-adapter',()=>({DrizzleAdapter:vi.fn()}));
vi.mock('@/lib/ton-wallet/service',()=>({authorizeWalletTicket:m.authorize,verifyWalletSession:m.verify}));
import '../auth';
const id='00000000-0000-4000-8000-000000000001',wallet='00000000-0000-4000-8000-000000000002';
beforeEach(()=>{vi.clearAllMocks();m.find.mockResolvedValue({role:'user'});m.verify.mockResolvedValue(true);});
describe('NextAuth additional wallet credential boundary',()=>{
 it('does not trust proxy Host unless deployment explicitly opts in',()=>{expect(m.config.trustHost).toBe(false);});
 it('keeps existing providers and adds a separate server-side ticket provider',async()=>{const providers=m.config.providers.map((p:any)=>p.options??p);expect(providers.some((p:any)=>p.id==='ton-wallet')).toBe(true);expect(providers.some((p:any)=>p.name==='credentials')).toBe(true);});
 it('records the wallet credential in JWT and checks it on every subsequent read',async()=>{const first=await m.config.callbacks.jwt({token:{},user:{id,tonWalletId:wallet}});expect(first.tonWalletId).toBe(wallet);expect(m.verify).toHaveBeenCalledWith(id,wallet);m.verify.mockClear();const next=await m.config.callbacks.jwt({token:first});expect(next.tonWalletId).toBe(wallet);expect(m.verify).toHaveBeenCalledWith(id,wallet);});
 it('returns null for revoked credential or unavailable verification',async()=>{m.verify.mockResolvedValueOnce(false);expect(await m.config.callbacks.jwt({token:{id,tonWalletId:wallet}})).toBeNull();m.verify.mockRejectedValueOnce(Error('offline'));expect(await m.config.callbacks.jwt({token:{id,tonWalletId:wallet}})).toBeNull();});
 it('never accepts wallet IDs from client session updates',async()=>{const token={id};const output=await m.config.callbacks.jwt({token,trigger:'update',session:{tonWalletId:wallet,id:wallet,name:'Display'}});expect(output.id).toBe(id);expect(output.tonWalletId).toBeUndefined();expect(m.verify).not.toHaveBeenCalled();});
 it('clears wallet-origin identity when a fresh normal login occurs',async()=>{const out=await m.config.callbacks.jwt({token:{id,tonWalletId:wallet},user:{id}});expect(out.tonWalletId).toBeUndefined();expect(m.verify).not.toHaveBeenCalled();});
});
