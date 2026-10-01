import crypto from 'node:crypto';
import admin from 'firebase-admin';
import {getDb,flwRequest,json,method,rawBody,markPaid} from './_lib.js';

export const config = { api: { bodyParser: false } };

function signatureValid(raw, headers) {
  const configured=String(process.env.FLW_WEBHOOK_SECRET||'').trim();
  if(!configured) return false;
  const secretHash=String(headers['verif-hash']||headers['Verif-Hash']||'').trim();
  if(secretHash){const a=Buffer.from(secretHash),b=Buffer.from(configured);return a.length===b.length && crypto.timingSafeEqual(a,b);}
  const hmac=String(headers['flutterwave-signature']||headers['Flutterwave-Signature']||'').trim();
  if(!hmac) return false;
  const expected=crypto.createHmac('sha256',configured).update(raw).digest('base64');
  const a=Buffer.from(hmac),b=Buffer.from(expected);
  return a.length===b.length && crypto.timingSafeEqual(a,b);
}
function successful(status){return ['succeeded','successful'].includes(String(status||'').toLowerCase());}

async function verifyCharge(id){
  if(!id) return null;
  return (await flwRequest(`/charges/${encodeURIComponent(id)}`,{method:'GET'})).data||null;
}


async function processTransferWebhook(db,d){
  const reference=String(d?.reference||'').trim(), transferId=String(d?.id||'').trim();
  if(!reference&&!transferId)return false;
  const q=reference?await db.collection('payouts').where('reference','==',reference).limit(1).get():await db.collection('payouts').where('providerId','==',transferId).limit(1).get();
  if(q.empty)return false;
  const payoutRef=q.docs[0].ref, payout=q.docs[0].data()||{};
  if(['successful','failed','cancelled'].includes(String(payout.status||'').toLowerCase()))return true;
  let transfer=d;
  if(transferId){
    try{const verified=(await flwRequest(`/transfers/${encodeURIComponent(transferId)}`,{method:'GET'})).data; if(verified)transfer=verified;}catch{}
  }
  const status=String(transfer?.status||d?.status||'').toUpperCase();
  if(!['SUCCESSFUL','FAILED','CANCELLED'].includes(status)){
    await payoutRef.set({status:status||'pending',provider:transfer,updatedAt:admin.firestore.FieldValue.serverTimestamp()},{merge:true});
    return true;
  }
  const uid=String(payout.uid||'');
  if(!uid)return false;
  const currency=String(payout.currency||'').toUpperCase(), balanceField=currency==='NGN'?'balanceNGN':'balanceUSD', withdrawnField=currency==='NGN'?'withdrawnNGN':'withdrawnUSD';
  await db.runTransaction(async tx=>{
    const [freshPayout,sellerSnap]=await Promise.all([tx.get(payoutRef),tx.get(db.collection('sellers').doc(uid))]);
    const fp=freshPayout.data()||{};
    if(['successful','failed','cancelled'].includes(String(fp.status||'').toLowerCase()))return;
    if(status==='SUCCESSFUL'){
      tx.set(payoutRef,{status:'successful',provider:transfer,completedAt:admin.firestore.FieldValue.serverTimestamp(),updatedAt:admin.firestore.FieldValue.serverTimestamp()},{merge:true});
    }else{
      const seller=sellerSnap.data()||{};
      const amount=Number(fp.amount||0);
      tx.set(db.collection('sellers').doc(uid),{[balanceField]:admin.firestore.FieldValue.increment(amount),[withdrawnField]:admin.firestore.FieldValue.increment(-amount),updatedAt:admin.firestore.FieldValue.serverTimestamp()},{merge:true});
      tx.set(payoutRef,{status:'failed',provider:transfer,error:String(transfer?.complete_message||'Flutterwave marked the payout as failed.'),refunded:true,updatedAt:admin.firestore.FieldValue.serverTimestamp()},{merge:true});
    }
  });
  return true;
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
    let p;try{p=JSON.parse(raw.toString('utf8'));}catch{return json(res,400,{error:'Invalid webhook JSON'});}
    const source=String(p.source||'').toLowerCase();
    const wytelabSecret=String(process.env.WYCOD_MARKET_WEBHOOK_SECRET||'').trim();
    let trustedWytelab=false;
    if(source==='wytelab'){
      const sig=String(req.headers['x-wytelab-signature']||'').trim();
      if(!wytelabSecret||!sig)return json(res,401,{error:'Missing Wytelab webhook signature'});
      const expected=crypto.createHmac('sha256',wytelabSecret).update(raw).digest('base64');
      const a=Buffer.from(sig),b=Buffer.from(expected);
      trustedWytelab=a.length===b.length&&crypto.timingSafeEqual(a,b);
      if(!trustedWytelab)return json(res,401,{error:'Invalid Wytelab webhook signature'});
    }else if(!signatureValid(raw,req.headers))return json(res,401,{error:'Invalid Flutterwave webhook signature'});
    const db=getDb(),eventId=String(p.id||req.headers['x-wytelab-event-id']||''),eventKey=`${source==='wytelab'?'wytelab':'flutterwave'}:${eventId}`;
    if(eventId){
      const eventRef=db.collection('flutterwaveWebhookEvents').doc(eventKey),eventSnap=await eventRef.get();
      if(eventSnap.exists&&eventSnap.data()?.processed)return json(res,200,{received:true,duplicate:true});
      await eventRef.set({type:String(p.type||''),status:String(p.data?.status||''),receivedAt:admin.firestore.FieldValue.serverTimestamp(),processed:false},{merge:true});
    }
    const d=p.data||{},chargeId=String(d.id||d.charge_id||'');
    const meta=d.meta||{};
    if(trustedWytelab){
      const orderId=String(d.order_id||meta.order_id||'').trim(), reference=String(d.reference||'').trim(), status=String(d.status||'').toLowerCase();
      if(!orderId||!reference||status!=='succeeded'||!Number.isFinite(Number(d.amount))||Number(d.amount)<=0||!String(d.currency||'').trim())return json(res,400,{error:'Invalid verified Wytelab payment event'});
      let processed=false;
      const orderRef=db.collection('orders').doc(orderId),os=await orderRef.get();
      if(os.exists){
        const o=os.data()||{};
        if(String(o.reference)===reference&&Number(o.amount)===Number(d.amount)&&String(o.currency||'').toUpperCase()===String(d.currency).toUpperCase()){
          await markPaid(orderId,{id:chargeId,reference,amount:Number(d.amount),currency:String(d.currency).toUpperCase(),status:'succeeded',flutterwaveReference:reference});
          processed=true;
        }
      }
      if(!processed){
        const planRef=db.collection('sellerPlanOrders').doc(orderId),ps=await planRef.get();
        if(ps.exists){
          const o=ps.data()||{};
          if(String(o.reference)===reference&&Number(o.amount)===Number(d.amount)&&String(o.currency||'USD').toUpperCase()===String(d.currency).toUpperCase())processed=await processSellerPlan(db,planRef,o,{id:chargeId,reference,amount:Number(d.amount),currency:String(d.currency).toUpperCase(),status:'succeeded'});
        }
      }
      if(eventId)await db.collection('flutterwaveWebhookEvents').doc(eventKey).set({processed,source:'wytelab',processedAt:admin.firestore.FieldValue.serverTimestamp()},{merge:true});
      return json(res,200,{received:true,processed,source:'wytelab'});
    }
    const eventType=String(p.type||'').toLowerCase();
    if(eventType==='transfer.disburse' || eventType==='transfer.completed' || String(p.event?.type||'').toLowerCase()==='transfer'){
      const processedTransfer=await processTransferWebhook(db,d);
      if(eventId)await db.collection('flutterwaveWebhookEvents').doc(eventKey).set({processed:processedTransfer,processedAt:admin.firestore.FieldValue.serverTimestamp()},{merge:true});
      return json(res,200,{received:true,processed:processedTransfer});
    }
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
    if(eventId)await db.collection('flutterwaveWebhookEvents').doc(eventKey).set({processed:true,processedAt:admin.firestore.FieldValue.serverTimestamp()},{merge:true});
    return json(res,200,{received:true,processed});
  }catch(e){return json(res,500,{error:'Webhook processing failed'});}
}
