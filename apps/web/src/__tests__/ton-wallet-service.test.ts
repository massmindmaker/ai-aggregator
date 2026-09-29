import { afterEach,beforeEach,describe,expect,it,vi } from 'vitest';
const m=vi.hoisted(()=>({consume:vi.fn(),check:vi.fn()}));
vi.mock('@/lib/db',()=>({db:{$client:{connect:vi.fn()},query:{users:{findFirst:vi.fn()}}}}));
vi.mock('@aiag/database',()=>({
 issueTonWalletChallenge:vi.fn(),completeTonWalletProof:vi.fn(),listTonWallets:vi.fn(),
 consumeTonWalletTicket:m.consume,checkTonWalletSession:m.check,reserveTonWalletPasswordAttempt:vi.fn(),revokeTonWallet:vi.fn()
}));
import { authorizeWalletTicket } from '../lib/ton-wallet/service';
const origin='https://app.example.test',ticket='00000000-0000-4000-8000-000000000001.'+'a'.repeat(64),cookie='__Host-aiag-ton-browser='+'b'.repeat(64);
beforeEach(()=>{vi.resetAllMocks();vi.stubEnv('TON_WALLET_ENABLED','1');vi.stubEnv('TON_WALLET_ORIGIN',origin);vi.stubEnv('TON_WALLET_NETWORK','-3');m.consume.mockResolvedValue({id:'u'});});
afterEach(()=>vi.unstubAllEnvs());
describe('wallet credential service request binding',()=>{
 it('rejects missing or cross-origin Auth.js request before consuming a one-time ticket',async()=>{expect(await authorizeWalletTicket({ticket},undefined as never)).toBeNull();expect(await authorizeWalletTicket({ticket},new Request(origin+'/api/auth',{headers:{origin:'https://evil.example.test',cookie}}))).toBeNull();expect(m.consume).not.toHaveBeenCalled();});
 it('consumes only same-origin browser-bound ticket',async()=>{expect(await authorizeWalletTicket({ticket},new Request(origin+'/api/auth',{headers:{origin,cookie}}))).toEqual({id:'u'});expect(m.consume).toHaveBeenCalledTimes(1);expect(m.consume.mock.calls[0][1]).toMatchObject({ticket});expect(m.consume.mock.calls[0][1].browserHash).toMatch(/^[0-9a-f]{64}$/);});
});
