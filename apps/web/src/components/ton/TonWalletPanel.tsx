"use client";
import { useCallback,useEffect,useRef,useState } from 'react';
import { Address } from '@ton/core';
import { TonConnectUIProvider,useTonConnectUI,useTonWallet } from '@tonconnect/ui-react';
import { signIn } from 'next-auth/react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { sendOwnedTonCheckout,type TonPreparedTransaction } from '@/lib/ton-wallet/send-once';

type Mode='manage'|'login';
type LinkedWallet={id:string;address:string;network:'-3';walletVersion:string;createdAt:string};
type PackageOption={id:string;label:string;grantMicrocredits:string};
type Invoice={invoiceId:string;reference:string;expectedSender:string|null;recipient:string;amountAtomic:string;expiresAt:string;status:string};
type Checkout={checkoutId:string;invoice:Invoice;walletId:string;packageId:string;sendState:string;attemptId:string|null};
type Challenge={challengeId:string;payload:string;purpose:'link'|'login';consent:boolean};

export function TonWalletPanel({mode,showCheckout=false}:{mode:Mode;showCheckout?:boolean}){
 return <TonConnectUIProvider manifestUrl="/tonconnect-manifest.json" restoreConnection={true} language="ru" analytics={{mode:'off'}}>
  <TonWalletInner mode={mode} showCheckout={showCheckout}/>
 </TonConnectUIProvider>;
}
function TonWalletInner({mode,showCheckout}:{mode:Mode;showCheckout:boolean}){
 const router=useRouter(),wallet=useTonWallet(),[ui]=useTonConnectUI();
 const [enabled,setEnabled]=useState<boolean|null>(null),[consent,setConsent]=useState(false),[status,setStatus]=useState(''),[busy,setBusy]=useState(false);
 const [linked,setLinked]=useState<LinkedWallet[]>([]),[packages,setPackages]=useState<PackageOption[]>([]),[selectedWallet,setSelectedWallet]=useState(''),[selectedPackage,setSelectedPackage]=useState('');
 const [checkout,setCheckout]=useState<Checkout|null>(null),[passwords,setPasswords]=useState<Record<string,string>>({});
 const challenge=useRef<Challenge|null>(null),submitted=useRef(false),createKey=useRef<string|null>(null),sending=useRef(false);

 const refresh=useCallback(async()=>{
  if(mode!=='manage')return;
  const [walletResponse,optionResponse]=await Promise.all([fetch('/api/ton/wallet',{cache:'no-store'}),showCheckout?fetch('/api/ton/checkout/options',{cache:'no-store'}):Promise.resolve(null)]);
  if(walletResponse.ok){const data=await walletResponse.json() as {wallets?:LinkedWallet[]};setLinked(data.wallets??[]);setSelectedWallet(v=>v||(data.wallets?.[0]?.id??''));}
  if(optionResponse?.ok){const data=await optionResponse.json() as {packages?:PackageOption[]};setPackages(data.packages??[]);setSelectedPackage(v=>v||(data.packages?.[0]?.id??''));}
 },[mode,showCheckout]);

 useEffect(()=>{void(async()=>{try{const r=await fetch('/api/ton/config',{cache:'no-store'}),v=await r.json() as {enabled?:boolean};setEnabled(r.ok&&v.enabled===true);if(r.ok&&v.enabled===true)await refresh();}catch{setEnabled(false);}})();},[refresh]);
 useEffect(()=>{try{ui.setConnectionNetwork('-3');}catch{};const unsubscribe=ui.onStatusChange(current=>{void acceptWallet(current as any);},()=>setStatus('Кошелёк вернул ошибку подключения.'));return ()=>unsubscribe();},[ui]);

 async function acceptWallet(current:any){
  const pending=challenge.current;if(!pending||submitted.current||!current)return;
  if(current?.account?.chain!=='-3'){setStatus('Нужен кошелёк TON testnet.');return;}
  const proof=current?.connectItems?.tonProof;
  if(!current.account.publicKey||!current.account.walletStateInit||proof?.name!=='ton_proof'||!proof.proof){setStatus('Кошелёк не вернул TON Proof. Создайте новый запрос подписи.');return;}
  if(proof.proof.payload!==pending.payload)return;
  submitted.current=true;setBusy(true);
  try{
   const response=await fetch('/api/ton/wallet/proof',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({
    purpose:pending.purpose,challengeId:pending.challengeId,consent:pending.consent,
    proof:{address:current.account.address,network:'-3',publicKey:current.account.publicKey,walletStateInit:current.account.walletStateInit,proof:{...proof.proof,timestamp:String(proof.proof.timestamp)}}
   })});
   const result=await response.json();
   if(!response.ok)throw Error(result?.error??'proof');
   challenge.current=null;ui.setConnectRequestParameters(null);
   if(result.kind==='login_ticket'){
    const auth=await signIn('ton-wallet',{ticket:result.ticket,redirect:false});
    if(auth?.error)throw Error('login');setStatus('Вход подтверждён кошельком.');router.push('/dashboard');return;
   }
   setStatus('Кошелёк привязан к аккаунту.');setConsent(false);await refresh();router.refresh();
  }catch{setStatus('Подпись не подтверждена. Создайте новый запрос и повторите вручную.');}
  finally{setBusy(false);}
 }
 async function startProof(){
  if(mode==='manage'&&!consent)return;
  setBusy(true);setStatus('');submitted.current=false;challenge.current=null;
  try{
   const purpose=mode==='manage'?'link':'login';
   ui.setConnectRequestParameters(null);challenge.current=null;submitted.current=false;
   if(wallet)await ui.disconnect();
   const response=await fetch('/api/ton/wallet/challenge',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({purpose})});
   const data=await response.json();if(!response.ok)throw Error(data?.error??'challenge');
   challenge.current={challengeId:data.challengeId,payload:data.payload,purpose,consent:mode==='manage'&&consent};
   ui.setConnectionNetwork('-3');ui.setConnectRequestParameters({state:'ready',value:{tonProof:data.payload}});await ui.openModal();
  }catch{setStatus('Не удалось начать безопасную подпись. Попробуйте позже.');}
  finally{setBusy(false);}
 }
 async function revoke(id:string){
  const password=passwords[id]??'';if(!password)return;setBusy(true);
  try{const response=await fetch('/api/ton/wallet/revoke',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({walletId:id,password})});const result=await response.json();if(!response.ok)throw Error(result?.error);setStatus('Кошелёк отвязан. TON-сессия для него больше недействительна.');setPasswords(v=>({...v,[id]:''}));await refresh();router.refresh();}catch{setStatus('Не удалось отвязать кошелёк: проверьте текущий пароль.');}finally{setBusy(false);}
 }
 async function createCheckout(){
  if(!selectedWallet||!selectedPackage)return;setBusy(true);setStatus('');
  if(!createKey.current)createKey.current=crypto.randomUUID();
  try{const response=await fetch('/api/ton/checkout',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({walletId:selectedWallet,packageId:selectedPackage,idempotencyKey:createKey.current})});const result=await response.json();if(!response.ok)throw Error(result?.error);setCheckout(result);createKey.current=null;setStatus('Счёт сохранён. Сумма и получатель зафиксированы сервером.');}catch{setStatus('Исход создания счёта неизвестен. Повтор использует тот же ключ и не создаёт второй счёт.');}finally{setBusy(false);}
 }
 async function sendCheckout(){
  if(!checkout||sending.current)return;sending.current=true;setBusy(true);setStatus('');
  const state=await sendOwnedTonCheckout(checkout.invoice,wallet?.account.address??null,{
   claim:async()=>{const r=await fetch('/api/ton/checkout/'+checkout.checkoutId+'/action',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'claim'})});return r.json();},
   send:async(transaction:TonPreparedTransaction)=>ui.sendTransaction({network:'-3',from:transaction.from,validUntil:transaction.validUntil,messages:transaction.messages.map(m=>({address:Address.parseRaw(m.address).toString({testOnly:true,bounceable:true,urlSafe:true}),amount:m.amount,payload:m.payload}))}),
   report:async value=>{const r=await fetch('/api/ton/checkout/'+checkout.checkoutId+'/action',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'report',...value})});if(!r.ok)throw Error();return r.json();}
  });
  try{const r=await fetch('/api/ton/checkout/'+checkout.checkoutId,{cache:'no-store'});if(r.ok)setCheckout(await r.json());}catch{}
  setStatus(state.state==='wallet_ack'?'Кошелёк принял транзакцию. Кредиты появятся только после проверки блокчейна.':state.state==='wallet_changed'?'Подключён другой кошелёк. Отправка не выполнялась.':'Исход отправки неизвестен. Повторная отправка заблокирована; дождитесь сверки.');
  setBusy(false);sending.current=false;
 }
 if(enabled===null)return <p role="status" className="text-sm text-muted-foreground">Проверяем TON…</p>;
 if(!enabled)return null;
 return <section className="rounded-2xl border border-border bg-card p-5 sm:p-6">
  <div className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="text-lg font-semibold">TON testnet</h2><p className="mt-1 text-sm text-muted-foreground">Подпись не передаёт приватный ключ. Mainnet и реальные выплаты не включены.</p></div>{wallet&&<code className="max-w-full break-all text-xs text-muted-foreground">{wallet.account.address}</code>}</div>
  {mode==='manage'&&<label className="mt-4 flex items-start gap-3 text-sm"><input type="checkbox" checked={consent} onChange={e=>setConsent(e.target.checked)} className="mt-1"/>Разрешаю привязать выбранный TON testnet-кошелёк к моему аккаунту.</label>}
  <div className="mt-4 flex flex-wrap gap-3"><Button type="button" onClick={()=>void startProof()} disabled={busy||(mode==='manage'&&!consent)}>{mode==='manage'?'Подписать привязку':'Войти через TON'}</Button></div>
  {status&&<p role="status" className="mt-4 text-sm">{status}</p>}
  {mode==='manage'&&linked.length>0&&<div className="mt-6 space-y-3"><h3 className="font-semibold">Привязанные кошельки</h3>{linked.map(item=><div key={item.id} className="rounded-lg border p-3"><code className="block break-all text-xs">{item.address}</code><p className="mt-1 text-xs text-muted-foreground">{item.walletVersion} · testnet</p><div className="mt-3 flex flex-col gap-2 sm:flex-row"><Input type="password" autoComplete="current-password" aria-label={'Текущий пароль '+item.id} placeholder="Текущий пароль" value={passwords[item.id]??''} onChange={e=>setPasswords(v=>({...v,[item.id]:e.target.value}))}/><Button variant="outline" disabled={busy||!(passwords[item.id]??'')} onClick={()=>void revoke(item.id)}>Отвязать</Button></div></div>)}</div>}
  {mode==='manage'&&showCheckout&&linked.length>0&&packages.length>0&&<div className="mt-6 border-t pt-5"><h3 className="font-semibold">Пополнение через TON testnet</h3><p className="mt-1 text-sm text-muted-foreground">Выберите серверный пакет. Клиент не передаёт сумму, курс или адрес получателя.</p>
   <div className="mt-4 grid gap-3 sm:grid-cols-2"><label className="grid gap-1 text-sm">Кошелёк<select className="rounded-md border bg-background p-2" value={selectedWallet} onChange={e=>setSelectedWallet(e.target.value)}>{linked.map(x=><option key={x.id} value={x.id}>{x.address.slice(0,12)}…</option>)}</select></label><label className="grid gap-1 text-sm">Пакет<select className="rounded-md border bg-background p-2" value={selectedPackage} onChange={e=>setSelectedPackage(e.target.value)}>{packages.map(x=><option key={x.id} value={x.id}>{x.label} · {formatCredits(x.grantMicrocredits)} кредитов</option>)}</select></label></div>
   {!checkout?<Button className="mt-4" disabled={busy} onClick={()=>void createCheckout()}>Создать TON-счёт</Button>:<div className="mt-4 rounded-lg border p-4"><p className="font-medium">{formatNano(checkout.invoice.amountAtomic)} TON · {formatCredits(packages.find(x=>x.id===checkout.packageId)?.grantMicrocredits??'0')} кредитов</p><p className="mt-1 text-xs text-muted-foreground">Статус блокчейна: {checkout.invoice.status}. Ответ кошелька сам по себе не начисляет кредиты.</p><Button className="mt-3" disabled={busy||checkout.sendState!=='not_sent'} onClick={()=>void sendCheckout()}>Отправить один раз</Button>{checkout.sendState!=='not_sent'&&<p className="mt-2 text-sm">Повторная отправка отключена. Проверяем уже сохранённую операцию.</p>}</div>}
  </div>}
 </section>;
}
function formatCredits(value:string){if(!/^\d+$/.test(value))return '—';const n=BigInt(value);return (n/1000n).toString()+((n%1000n)?','+(n%1000n).toString().padStart(3,'0').replace(/0+$/,''):'');}
function formatNano(value:string){if(!/^\d+$/.test(value))return '—';const n=BigInt(value),f=(n%1_000_000_000n).toString().padStart(9,'0').replace(/0+$/,'');return (n/1_000_000_000n).toString()+(f?'.'+f:'');}
