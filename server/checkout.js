import crypto from 'node:crypto';
import admin from 'firebase-admin';
import {getDb,flwRequest,json,method,body,encryptCardField,randomNonce} from './_lib.js';

function splitName(value){const parts=String(value||'').trim().split(/\s+/).filter(Boolean);return {first:parts.shift()||'',last:parts.join(' ')||''};}
function cardError(msg){const e=new Error(msg);e.status=400;return e;}
function cleanCard(card){
  if(!card||typeof card!=='object')throw cardError('Card details are required.');
  const number=String(card.number||'').replace(/\D/g,''),cvv=String(card.cvv||'').replace(/\D/g,''),month=String(card.expiry_month||'').replace(/\D/g,''),rawYear=String(card.expiry_year||'').replace(/\D/g,'');
  const year=rawYear.length===4?rawYear:(rawYear.length===2?`20${rawYear}`:'');
  if(!/^\d{12,19}$/.test(number))throw cardError('Enter a valid card number.');
  if(!/^\d{3,4}$/.test(cvv))throw cardError('Enter a valid CVV.');
  if(!/^(0[1-9]|1[0-2])$/.test(month)||!/^\d{4}$/.test(year))throw cardError('Enter a valid card expiry.');
  const y=Number(year),m=Number(month),now=new Date();if(y<now.getFullYear()||(y===now.getFullYear()&&m<now.getMonth()+1))throw cardError('Your card has expired.');
  return {number,cvv,month,year:year.slice(-2)};
}
async function buyer(req){
  const token=String(req.headers.authorization||'').replace(/^Bearer\s+/i,'').trim();
  if(!token)throw Object.assign(new Error('Buyer sign-in is required.'),{status:401});
  try{const u=await admin.auth().verifyIdToken(token);if(u.firebase?.sign_in_provider!=='google.com')throw new Error('A Google buyer account is required.');return u;}
  catch(e){throw Object.assign(new Error(e.message==='A Google buyer account is required.'?e.message:'Your buyer session expired. Please refresh and try again.'),{status:401});}
}
export default async function handler(req,res){
  if(!method(req,res,['POST']))return;
  try{
    const decoded=await buyer(req),b=await body(req),productId=String(b.productId||'').trim(),email=String(b.email||'').trim().toLowerCase(),name=String(b.name||'').trim(),paymentMethod=b.payment_method;
    if(!productId||!email||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||!name||!paymentMethod)return json(res,400,{error:'Product, name, email and payment method are required.'});
    const db=getDb(),doc=await db.collection('products').doc(productId).get();if(!doc.exists)return json(res,404,{error:'Product not found.'});const p=doc.data()||{};
    if(!['active','published'].includes(p.status))return json(res,400,{error:'Product is not available.'});
    if(!String(p.sourceDriveId||p.sourceUrl||'').trim())return json(res,409,{error:'This product is not ready for verified delivery yet.'});
    const currency=String(b.currency||'USD').toUpperCase();if(!['USD','NGN'].includes(currency))return json(res,400,{error:'Choose USD or NGN.'});const amount=currency==='NGN'?(Number(p.priceNGN)>0?Number(p.priceNGN):Math.round(Number(p.priceUSD||0)*1200)):Number(p.priceUSD);if(!Number.isFinite(amount)||amount<0.01)return json(res,400,{error:`This product does not have a valid ${currency} price.`});
    const pendingSnap=await db.collection('orders').where('buyerUid','==',decoded.uid).limit(50).get();const pending=pendingSnap.docs.map(d=>({id:d.id,...d.data()})).find(o=>o.productId===productId&&o.status==='pending'&&(Date.now()-(new Date(o.createdAt||0).getTime()||0))<15*60*1000);if(pending&&pending.flutterwaveChargeId)return json(res,200,{orderId:pending.id,reference:pending.reference,status:pending.flutterwaveStatus||'pending',chargeId:pending.flutterwaveChargeId,nextAction:pending.nextAction||null});
    const orderId=crypto.randomUUID(),reference=`WYC${orderId.replaceAll('-','').slice(0,30)}`,card=cleanCard(paymentMethod.type==='card'?paymentMethod.card:null),encryptionKey=process.env.FLW_ENCRYPTION_KEY;if(!encryptionKey)throw new Error('Missing FLW_ENCRYPTION_KEY');
    await db.collection('orders').doc(orderId).set({productId,productName:p.name||'',sellerUid:p.sellerUid||'',buyerUid:decoded.uid,email,name,amount,currency,reference,status:'pending',createdAt:new Date()});
    const appUrl=String(process.env.APP_URL||'').trim().replace(/\/$/,'');if(!/^https:\/\/[^\s]+$/i.test(appUrl))throw new Error('APP_URL must be a valid HTTPS URL');
    const nonce=randomNonce(),encryptedCard={encrypted_card_number:encryptCardField(card.number,encryptionKey,nonce),encrypted_expiry_month:encryptCardField(card.month,encryptionKey,nonce),encrypted_expiry_year:encryptCardField(card.year,encryptionKey,nonce),encrypted_cvv:encryptCardField(card.cvv,encryptionKey,nonce),nonce};
    const fw=await flwRequest('/orchestration/direct-charges',{method:'POST',headers:{'X-Idempotency-Key':orderId.replaceAll('-','')},body:JSON.stringify({amount,currency,reference,redirect_url:`${appUrl}/?payment=return&order=${encodeURIComponent(orderId)}`,customer:{email,name:splitName(name)},payment_method:{type:'card',card:encryptedCard},meta:{order_id:orderId,product_id:productId,buyer_uid:decoded.uid}})});
    const data=fw.data||{};await db.collection('orders').doc(orderId).set({flutterwaveChargeId:data.id||'',flutterwaveStatus:data.status||'pending',nextAction:data.next_action||null,updatedAt:new Date()},{merge:true});
    return json(res,200,{orderId,reference,status:data.status||'pending',chargeId:data.id||'',nextAction:data.next_action||null});
  }catch(e){const a=e?.data?.error||{},d=e?.data?.diagnostic||{};json(res,e.status&&e.status<500?e.status:500,{error:a.message||e.message||'Checkout failed.',details:{code:a.code||'',type:a.type||'',phase:d.phase||'',trace_id:d.trace_id||''}});}
}
