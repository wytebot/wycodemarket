import crypto from 'node:crypto';
import {getDb,flwRequest,json,method,body,encryptCardField,randomNonce} from './_lib.js';

function splitName(value){const parts=String(value||'').trim().split(/\s+/).filter(Boolean);const first=parts.shift()||'';return {first,last:parts.join(' ')||first};}
function cardError(msg){const e=new Error(msg);e.status=400;return e;}
function cleanCard(card){
  if(!card||typeof card!=='object')throw cardError('Card details are required');
  const number=String(card.number||'').replace(/\D/g,'');
  const cvv=String(card.cvv||'').replace(/\D/g,'');
  const month=String(card.expiry_month||'').replace(/\D/g,'');
  const year=String(card.expiry_year||'').replace(/\D/g,'');
  if(!/^\d{12,19}$/.test(number))throw cardError('Enter a valid card number');
  if(!/^\d{3,4}$/.test(cvv))throw cardError('Enter a valid CVV');
  if(!/^(0[1-9]|1[0-2])$/.test(month))throw cardError('Enter a valid expiry month');
  if(!/^\d{2,4}$/.test(year))throw cardError('Enter a valid expiry year');
  return {number,cvv,month,year};
}

const PRICES={USD:{amount:16,currency:'USD'},NGN:{amount:17500,currency:'NGN'}};

export default async function handler(req,res){
  if(!method(req,res,['POST']))return;
  try{
    const b=await body(req);
    const email=String(b.email||'').trim().toLowerCase();
    const name=String(b.name||'').trim();
    const currency=String(b.currency||'NGN').toUpperCase();
    const paymentMethod=b.payment_method;
    if(!emailRx(email)||!name)return json(res,400,{error:'Name and email are required'});
    if(process.env.PRO_FREE_TEST_MODE!=='true'&&!paymentMethod)return json(res,400,{error:'Payment method is required'});
    if(!PRICES[currency])return json(res,400,{error:'Choose USD or NGN for Pro payment'});

    const db=getDb();
    if(process.env.PRO_FREE_TEST_MODE==='true'){
      const customerRef=db.collection('customers').doc(Buffer.from(email).toString('base64url'));
      const customerSnap=await customerRef.get();
      const existing=customerSnap.exists?customerSnap.data():{};
      if(existing?.pro===true||existing?.plan==='pro')return json(res,200,{status:'paid',plan:'pro',test:true,amount:0,currency:'TEST'});
      const orderId=crypto.randomUUID();
      await db.collection('orders').doc(orderId).set({kind:'pro',plan:'pro',email,name,amount:0,currency:'TEST',reference:`WYTEST${orderId.replaceAll('-','').slice(0,24)}`,status:'paid',paymentMode:'free-test',createdAt:new Date(),updatedAt:new Date(),driveFileId:''});
      await customerRef.set({email,name,pro:true,plan:'pro',proTest:true,proGrantedAt:new Date(),updatedAt:new Date()},{merge:true});
      return json(res,200,{orderId,status:'paid',plan:'pro',test:true,amount:0,currency:'TEST'});
    }

    const customerRef=db.collection('customers').doc(Buffer.from(email).toString('base64url'));
    const customerSnap=await customerRef.get();
    const customer=customerSnap.exists?customerSnap.data():null;
    if(customer?.pro===true||customer?.plan==='pro')return json(res,409,{error:'This email already has Pro access.'});

    const card=cleanCard(paymentMethod.type==='card'?paymentMethod.card:null);
    const encryptionKey=process.env.FLW_ENCRYPTION_KEY;
    if(!encryptionKey)throw new Error('Missing FLW_ENCRYPTION_KEY');
    const price=PRICES[currency];
    const orderId=crypto.randomUUID();
    const reference=`WYP${orderId.replaceAll('-','').slice(0,30)}`;
    const names=splitName(name);
    const nonce=randomNonce();
    const appUrl=String(process.env.APP_URL||'').trim().replace(/\/$/,'');
    if(!/^https:\/\/[^\s]+$/i.test(appUrl))throw new Error('APP_URL must be a valid HTTPS URL');
    const redirect=`${appUrl}/?payment=pro-return&order=${encodeURIComponent(orderId)}`;

    await db.collection('orders').doc(orderId).set({
      kind:'pro',plan:'pro',email,name,amount:price.amount,currency:price.currency,reference,status:'pending',createdAt:new Date(),driveFileId:''
    });

    const encryptedCard={
      encrypted_card_number:encryptCardField(card.number,encryptionKey,nonce),
      encrypted_expiry_month:encryptCardField(card.month,encryptionKey,nonce),
      encrypted_expiry_year:encryptCardField(card.year,encryptionKey,nonce),
      encrypted_cvv:encryptCardField(card.cvv,encryptionKey,nonce),nonce
    };
    const fw=await flwRequest('/orchestration/direct-charges',{
      method:'POST',
      headers:{'X-Idempotency-Key':orderId.replaceAll('-','')},
      body:JSON.stringify({
        amount:price.amount,currency:price.currency,reference,redirect_url:redirect,
        customer:{email,name:names,meta:{order_id:orderId,plan:'pro'}},
        payment_method:{type:'card',card:encryptedCard},
        meta:{order_id:orderId,plan:'pro'}
      })
    });
    const data=fw.data||{};
    await db.collection('orders').doc(orderId).set({flutterwaveChargeId:data.id||'',flutterwaveStatus:data.status||'pending',updatedAt:new Date()},{merge:true});
    return json(res,200,{orderId,reference,status:data.status||'pending',chargeId:data.id||'',nextAction:data.next_action||null,amount:price.amount,currency:price.currency});
  }catch(e){return json(res,e.status&&e.status<500?e.status:500,{error:e.message||'Pro payment could not be started',details:process.env.NODE_ENV==='production'?undefined:e.data});}
}
function emailRx(v){return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)}
