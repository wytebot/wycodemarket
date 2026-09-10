import crypto from 'node:crypto';
import {getDb,flwRequest,json,method,body,encryptCardField,randomNonce} from './_lib.js';

function splitName(value){
  const parts=String(value||'').trim().split(/\s+/).filter(Boolean);
  return {first:parts.shift()||'',last:parts.join(' ')||parts[0]||''};
}

function cardError(msg){const e=new Error(msg);e.status=400;return e;}
function cleanCard(card){
  if(!card || typeof card!=='object') throw cardError('Card details are required');
  const number=String(card.number||'').replace(/\D/g,'');
  const cvv=String(card.cvv||'').replace(/\D/g,'');
  const month=String(card.expiry_month||'').replace(/\D/g,'');
  const year=String(card.expiry_year||'').replace(/\D/g,'');
  if(!/^\d{12,19}$/.test(number)) throw cardError('Enter a valid card number');
  if(!/^\d{3,4}$/.test(cvv)) throw cardError('Enter a valid CVV');
  if(!/^(0[1-9]|1[0-2])$/.test(month)) throw cardError('Enter a valid expiry month');
  if(!/^\d{2,4}$/.test(year)) throw cardError('Enter a valid expiry year');
  return {number,cvv,month,year};
}

export default async function handler(req,res){
  if(!method(req,res,['POST']))return;
  try{
    const b=await body(req);
    const productId=String(b.productId||'').trim();
    const email=String(b.email||'').trim().toLowerCase();
    const name=String(b.name||'').trim();
    const paymentMethod=b.payment_method;
    if(!productId||!email||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||!name||!paymentMethod){
      return json(res,400,{error:'Product, name, email and payment method are required'});
    }

    const doc=await getDb().collection('products').doc(productId).get();
    if(!doc.exists)return json(res,404,{error:'Product not found'});
    const p=doc.data();
    if(!['active','published'].includes(p.status))return json(res,400,{error:'Product is not available'});
    if(!String(p.driveFileId||'').trim())return json(res,409,{error:'This product is not ready for delivery yet. Please try another product.'});
    const requestedCurrency=String(b.currency||'').toUpperCase();
    const usd=Number(p.priceUSD), ngn=Number(p.priceNGN);
    const legacyAmount=Number(p.price), legacyCurrency=String(p.currency||'USD').toUpperCase();
    const available={};
    if(Number.isFinite(usd)&&usd>=0.01)available.USD=usd;
    if(Number.isFinite(ngn)&&ngn>=0.01)available.NGN=ngn;
    if(!Object.keys(available).length&&Number.isFinite(legacyAmount)&&legacyAmount>=0.01)available[legacyCurrency]=legacyAmount;
    const currency=requestedCurrency||legacyCurrency;
    const amount=available[currency];
    if(!Number.isFinite(amount)||amount<0.01)return json(res,400,{error:`This product does not have a valid ${currency} price. Choose an available currency.`});

    const orderId=crypto.randomUUID();
    const reference=`WYC${orderId.replaceAll('-','').slice(0,30)}`;
    const names=splitName(name);
    const card=cleanCard(paymentMethod.type==='card'?paymentMethod.card:null);
    const encryptionKey=process.env.FLW_ENCRYPTION_KEY;
    if(!encryptionKey) throw new Error('Missing FLW_ENCRYPTION_KEY');
    const nonce=randomNonce();

    await getDb().collection('orders').doc(orderId).set({productId,productName:p.name||'',email,name,amount,currency,reference,status:'pending',createdAt:new Date(),driveFileId:p.driveFileId||''});

    const appUrl=String(process.env.APP_URL||'').trim().replace(/\/$/,'');
    if(!/^https:\/\/[^\s]+$/i.test(appUrl)) throw new Error('APP_URL must be a valid HTTPS URL');
    const redirect=`${appUrl}/?payment=return&order=${encodeURIComponent(orderId)}`;
    const encryptedCard={
      encrypted_card_number:encryptCardField(card.number,encryptionKey,nonce),
      encrypted_expiry_month:encryptCardField(card.month,encryptionKey,nonce),
      encrypted_expiry_year:encryptCardField(card.year,encryptionKey,nonce),
      encrypted_cvv:encryptCardField(card.cvv,encryptionKey,nonce),
      nonce
    };

    const fw=await flwRequest('/orchestration/direct-charges',{
      method:'POST',
      headers:{'X-Idempotency-Key':orderId.replaceAll('-','')},
      body:JSON.stringify({
        amount,currency,reference,redirect_url:redirect,
        customer:{email,name:names,meta:{order_id:orderId,product_id:productId}},
        payment_method:{type:'card',card:encryptedCard},
        meta:{order_id:orderId,product_id:productId}
      })
    });
    const data=fw.data||{};
    await getDb().collection('orders').doc(orderId).set({flutterwaveChargeId:data.id||'',flutterwaveStatus:data.status||'pending',updatedAt:new Date()},{merge:true});
    return json(res,200,{orderId,reference,status:data.status||'pending',chargeId:data.id||'',nextAction:data.next_action||null});
  }catch(e){
    json(res,e.status&&e.status<500?e.status:500,{error:e.message||'Checkout failed',details:process.env.NODE_ENV==='production'?undefined:e.data});
  }
}
