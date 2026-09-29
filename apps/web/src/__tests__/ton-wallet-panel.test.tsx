import { beforeEach,afterEach,describe,expect,it,vi } from 'vitest';
import { render,screen,fireEvent,waitFor,act } from '@testing-library/react';
const m=vi.hoisted(()=>({listener:null as any,send:vi.fn(),open:vi.fn(),params:vi.fn(),disconnect:vi.fn(),network:vi.fn(),wallet:null as any}));
vi.mock('@tonconnect/ui-react',()=>({TonConnectUIProvider:({children}:any)=>children,TonConnectButton:()=>null,useTonWallet:()=>m.wallet,useTonConnectUI:()=>[{onStatusChange:(f:any)=>{m.listener=f;return ()=>{};},setConnectRequestParameters:m.params,setConnectionNetwork:m.network,openModal:m.open,disconnect:m.disconnect,get wallet(){return m.wallet;},sendTransaction:m.send}]}));
vi.mock('next/navigation',()=>({useRouter:()=>({refresh:vi.fn(),push:vi.fn()})}));
vi.mock('next-auth/react',()=>({signIn:vi.fn().mockResolvedValue({ok:true})}));
import { TonWalletPanel } from '../components/ton/TonWalletPanel';
beforeEach(()=>{vi.clearAllMocks();m.listener=null;m.wallet=null;vi.stubGlobal('fetch',vi.fn().mockImplementation(async(url)=>String(url).endsWith('/api/ton/config')?Response.json({enabled:true}):String(url).endsWith('/challenge')?Response.json({challengeId:'00000000-0000-4000-8000-000000000001',payload:'testnonce'}):String(url).endsWith('/proof')?Response.json({kind:'linked',wallet:{id:'wallet'}}):Response.json({wallets:[]})));});
afterEach(()=>vi.unstubAllGlobals());
describe('wallet proof consent and duplicate event handling',()=>{
 it('requires explicit account linking consent before asking wallet for a signature',async()=>{render(<TonWalletPanel mode="manage"/>);const button=await screen.findByRole('button',{name:'Подписать привязку'});expect(button).toBeDisabled();fireEvent.click(screen.getByRole('checkbox',{name:/разрешаю привязать/i}));fireEvent.click(button);await waitFor(()=>expect(m.open).toHaveBeenCalledTimes(1));expect(m.params).toHaveBeenLastCalledWith({state:'ready',value:{tonProof:'testnonce'}});});
 it('submits the signature once even if wallet replays a connection event',async()=>{render(<TonWalletPanel mode="manage"/>);fireEvent.click(await screen.findByRole('checkbox',{name:/разрешаю привязать/i}));fireEvent.click(screen.getByRole('button',{name:'Подписать привязку'}));await waitFor(()=>expect(m.open).toHaveBeenCalled());const wallet={account:{address:'0:'+ '1'.repeat(64),chain:'-3',publicKey:'a'.repeat(64),walletStateInit:'fixture'},connectItems:{tonProof:{name:'ton_proof',proof:{timestamp:'1',domain:{lengthBytes:1,value:'a'},payload:'testnonce',signature:'fixture'}}}};await act(async()=>{await m.listener(wallet);await m.listener(wallet);});expect(vi.mocked(fetch).mock.calls.filter(([u])=>String(u).endsWith('/proof'))).toHaveLength(1);await waitFor(()=>expect(screen.getByRole('status')).toHaveTextContent('Кошелёк привязан'));});
 it('does not treat connected wallet on another network as authenticated',async()=>{render(<TonWalletPanel mode="login"/>);fireEvent.click(await screen.findByRole('button',{name:'Войти через TON'}));await waitFor(()=>expect(m.open).toHaveBeenCalled());await act(async()=>{await m.listener({account:{chain:'-239'}});});expect(vi.mocked(fetch).mock.calls.filter(([u])=>String(u).endsWith('/proof'))).toHaveLength(0);expect(screen.getByRole('status')).toHaveTextContent('testnet');});
 it('ignores a stale proof event from the previous connection after starting a fresh challenge',async()=>{
  const stale={account:{address:'0:'+ '1'.repeat(64),chain:'-3',publicKey:'a'.repeat(64),walletStateInit:'fixture'},connectItems:{tonProof:{name:'ton_proof',proof:{timestamp:'1',domain:{lengthBytes:1,value:'a'},payload:'oldnonce',signature:'fixture'}}}};
  m.wallet=stale;
  m.disconnect.mockImplementationOnce(async()=>{await m.listener(stale);await m.listener(null);m.wallet=null;});
  render(<TonWalletPanel mode="manage"/>);
  fireEvent.click(await screen.findByRole('checkbox',{name:/разрешаю привязать/i}));
  fireEvent.click(screen.getByRole('button',{name:'Подписать привязку'}));
  await waitFor(()=>expect(m.open).toHaveBeenCalledTimes(1));
  expect(vi.mocked(fetch).mock.calls.filter(([u])=>String(u).endsWith('/proof'))).toHaveLength(0);
  const fresh={...stale,connectItems:{tonProof:{name:'ton_proof',proof:{...stale.connectItems.tonProof.proof,payload:'testnonce'}}}};
  await act(async()=>{await m.listener(fresh);});
  await waitFor(()=>expect(vi.mocked(fetch).mock.calls.filter(([u])=>String(u).endsWith('/proof'))).toHaveLength(1));
 });

});
