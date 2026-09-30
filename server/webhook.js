import crypto from 'node:crypto';
import admin from 'firebase-admin';
import {getDb,flwRequest,json,method,rawBody,markPaid} from './_lib.js';

export const config = { api: { bodyParser: false } };

function signatureValid(raw, sig, secret) {
  if (!secret || !sig) return false;
  const expected=crypto.createHmac('sha256',secret).update(raw).digest('base64');
  const a=Buffer.from(String(sig)),b=Buffer.from(expected);
  return a.length===b.length && crypto.timingSafeEqual(a,b);
}
function successful(status){return ['succeeded','successful'].includes(String(status||'').toLowerCase());}

async function verifyCharge(id){
  if(!id) return null;
  return (await flwRequest(`/charges/${encodeURIComponent(id)}`,{method:'GET'})).data||null;
}

async function processSellerPlan(db,orderRef,order,charge){
  const valid=successful(charge?.status)
    && Number(charge?.amount)===Number(order.amount)
    && String(charge?.currency||'').toUpperCase()===String(order.currency||'USD').toUpperCase()
    && String(charge?.reference||'')===String(order.reference||'');
  if(!valid){
    await orderRef.set({flutterwaveStatus:charge?.status||'pending',updatedAt:admin.firestore.FieldValue.serverTimestamp()},{merge:true});
    return false;
  }
  if(order.status==='paid') return true;
  const sellerRef=db.collection('sellers').doc(String(order.uid));
  const sellerSnap=await sellerRef.get();
  if(!sellerSnap.exists) throw new Error('Seller account not found for plan payment.');
  const days=order.cycle==='annual'?365:30;
  const until=new Date(Date.now()+days*24*60*60*1000);
  await db.runTransaction(async tx=>{
    const [freshOrder,freshSeller]=await Promise.all([tx.get(orderRef),tx.get(sellerRef)]);
    const o=freshOrder.data()||{},s=freshSeller.data()||{};
    if(o.status==='paid')return;
    tx.set(sellerRef,{tier:order.tier,accessUntil:admin.firestore.Timestamp.fromDate(until),studioAccess:true,visibility:true,planPaidAt:admin.firestore.FieldValue.serverTimestamp(),cancelAt:null,cancelRequestedAt:null,updatedAt:admin.firestore.FieldValue.serverTimestamp()},{merge:true});
    tx.set(orderRef,{status:'paid',paidAt:admin.firestore.FieldValue.serverTimestamp(),verifiedAmount:Number(charge.amount),verifiedCurrency:charge.currency,flutterwaveStatus:charge.status,updatedAt:admin.firestore.FieldValue.serverTimestamp()},{merge:true});
  });
  return true;
}

export default async function handler(req,res){
  if(!method(req,res,['POST']))return;
  try{
    const raw=await rawBody(req);
    const sig=String(req.headers['flutterwave-signature']||'');
    if(!signatureValid(raw,sig,process.env.FLW_WEBHOOK_SECRET))return json(res,401,{error:'Invalid webhook signature'});
    let p;try{p=JSON.parse(raw.toString('utf8'));}catch{return json(res,400,{error:'Invalid webhook JSON'});}
    const db=getDb(),eventId=String(p.id||'');
    if(eventId){
      const eventRef=db.collection('flutterwaveWebhookEvents').doc(eventId),eventSnap=await eventRef.get();
      if(eventSnap.exists&&eventSnap.data()?.processed)return json(res,200,{received:true,duplicate:true});
      await eventRef.set({type:String(p.type||''),status:String(p.data?.status||''),receivedAt:admin.firestore.FieldValue.serverTimestamp(),processed:false},{merge:true});
    }
    const d=p.data||{},chargeId=String(d.id||'');
    const meta=d.meta||{};
    const orderId=String(meta.order_id||meta.orderId||'');
    let processed=false;
    if(orderId){
      const orderRef=db.collection('orders').doc(orderId),snap=await orderRef.get();
      if(snap.exists){
        const order=snap.data()||{};
        if(String(order.reference||'')===String(d.reference||'')||String(order.flutterwaveChargeId||'')===chargeId){
          const charge=await verifyCharge(chargeId||order.flutterwaveChargeId);
          if(successful(charge?.status)&&Number(charge.amount)===Number(order.amount)&&String(charge.currency||'').toUpperCase()===String(order.currency||'').toUpperCase()&&String(charge.reference||'')===String(order.reference||'')){
            await markPaid(orderId,charge);processed=true;
          }else{
            await orderRef.set({flutterwaveStatus:charge?.status||d.status||'pending',nextAction:charge?.next_action||null,updatedAt:admin.firestore.FieldValue.serverTimestamp()},{merge:true});
          }
        }
      }
    }
    if(!processed && meta.seller_uid&&meta.plan&&meta.cycle){
      const q=await db.collection('sellerPlanOrders').where('uid','==',String(meta.seller_uid)).where('reference','==',String(d.reference||'')).limit(1).get();
      if(!q.empty){
        const orderRef=q.docs[0].ref,order=q.docs[0].data()||{},charge=await verifyCharge(chargeId||order.flutterwaveChargeId);
        processed=await processSellerPlan(db,orderRef,order,charge);
      }
    }
    if(eventId)await db.collection('flutterwaveWebhookEvents').doc(eventId).set({processed:true,processedAt:admin.firestore.FieldValue.serverTimestamp()},{merge:true});
    return json(res,200,{received:true,processed});
  }catch(e){return json(res,500,{error:'Webhook processing failed'});}
}
