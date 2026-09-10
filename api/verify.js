import {getDb,flwRequest,json,method,body,signDownloadToken,markPaid} from './_lib.js';
export default async function handler(req,res){ if(!method(req,res,['GET','POST']))return; try{ const b=req.method==='POST'?await body(req):req.query||{};
 if(req.method==='POST' && String(b.action||'').toLowerCase()==='recover_purchase'){
   const inputEmail=String(b.email||'').trim();
   const email=inputEmail.toLowerCase();
   const reference=String(b.reference||'').trim();
   if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))return json(res,400,{error:'Enter the email address used for the purchase.'});
   if(reference.length<8||reference.length>100)return json(res,400,{error:'Enter the Flutterwave payment reference from your original payment receipt.'});

   const db=getDb();
   const normalize=v=>String(v??'').trim().toLowerCase();
   const refFields=['reference','flutterwaveReference','tx_ref','txRef','transactionRef','transaction_reference','paymentReference','payment_ref','flw_ref','flwRef'];
   const candidateMap=new Map();
   // Current orders store normalized email. The second query also supports older records
   // that may have preserved the customer's original email casing.
   for(const candidateEmail of [...new Set([email,inputEmail])]){
     const snap=await db.collection('orders').where('email','==',candidateEmail).limit(50).get();
     snap.docs.forEach(d=>candidateMap.set(d.id,{id:d.id,...d.data()}));
   }
   let candidates=[...candidateMap.values()];
   let charge=null;

   // Always re-query Flutterwave with the supplied reference. A previously-paid Firestore
   // record is not enough on its own for recovery; Flutterwave remains the payment source of truth.
   try{
     const fw=await flwRequest(`/charges?reference=${encodeURIComponent(reference)}`,{method:'GET'});
     const rows=Array.isArray(fw.data)?fw.data:[];
     charge=rows.find(c=>normalize(c.reference)===normalize(reference))||null;
   }catch(e){
     // If Flutterwave cannot be reached, only an already-known exact order reference can be
     // identified locally, but do not issue a recovery token without live verification.
     throw e;
   }
   if(!charge)return json(res,404,{error:'Flutterwave could not find a payment with that reference.'});

   const chargeEmail=normalize(charge.customer?.email||charge.customer_email||charge.email||'');
   if(chargeEmail && chargeEmail!==email)return json(res,403,{error:'The purchase email does not match the Flutterwave payment.'});

   let recoveryOrder=candidates.find(o=>refFields.some(k=>normalize(o[k])===normalize(reference)))||null;
   const chargeId=String(charge.id||'');
   if(!recoveryOrder && chargeId)recoveryOrder=candidates.find(o=>String(o.flutterwaveChargeId||'')===chargeId)||null;
   // Newer v4 charges include our order ID in metadata. This is the strongest legacy
   // fallback because it identifies the exact Firestore order without relying on email casing.
   const chargeOrderId=String(charge.meta?.order_id||charge.meta?.orderId||'').trim();
   if(!recoveryOrder && chargeOrderId){
     const snap=await db.collection('orders').doc(chargeOrderId).get();
     if(snap.exists)recoveryOrder={id:snap.id,...snap.data()};
   }

   // For truly old orders that have neither a stored reference nor charge ID, use the
   // verified Flutterwave customer/amount/currency and a conservative timestamp match.
   if(!recoveryOrder){
     let money=candidates.filter(o=>Number(o.amount)===Number(charge.amount)&&String(o.currency||'').toUpperCase()===String(charge.currency||'').toUpperCase());
     if(chargeEmail)money=money.filter(o=>normalize(o.email)===email);
     if(money.length===1)recoveryOrder=money[0];
     else if(money.length>1){
       const chargeTime=Date.parse(charge.created_at||charge.createdAt||charge.created_datetime||'');
       if(Number.isFinite(chargeTime)){
         const ranked=money.map(o=>({o,t:o.createdAt?.toDate?o.createdAt.toDate().getTime():Date.parse(o.createdAt||o.created_datetime||'')})).filter(x=>Number.isFinite(x.t)).sort((a,b)=>Math.abs(a.t-chargeTime)-Math.abs(b.t-chargeTime));
         if(ranked.length&&Math.abs(ranked[0].t-chargeTime)<=7*24*60*60*1000&&(ranked.length===1||Math.abs(ranked[0].t-chargeTime)<Math.abs(ranked[1].t-chargeTime))) recoveryOrder=ranked[0].o;
       }
     }
   }

   if(!recoveryOrder)return json(res,404,{error:'No purchase record matched that payment. If this is an older purchase, make sure you entered the same email used at checkout.'});
   if(normalize(recoveryOrder.email)!==email)return json(res,403,{error:'The purchase email does not match that payment.'});

   const valid=charge.status==='succeeded'
     && Number(charge.amount)===Number(recoveryOrder.amount)
     && String(charge.currency||'').toUpperCase()===String(recoveryOrder.currency||'').toUpperCase()
     && normalize(charge.reference)===normalize(reference);
   if(!valid)return json(res,409,{error:'Flutterwave could not confirm that payment as a completed charge for this purchase.'});

   const paid=await markPaid(recoveryOrder.id,{...charge,reference:charge.reference||reference});
   recoveryOrder.status='paid';
   recoveryOrder.reference=charge.reference||recoveryOrder.reference||reference;
   recoveryOrder.flutterwaveReference=charge.reference||recoveryOrder.flutterwaveReference||reference;
   recoveryOrder.receiptStatus=paid.receiptStatus;
   if(!String(recoveryOrder.driveFileId||'').trim())return json(res,409,{error:'This purchase is verified, but its source file is not ready for recovery yet.'});
   const token=signDownloadToken(recoveryOrder.id,24*60*60);
   return json(res,200,{ok:true,purchases:[{id:recoveryOrder.id,name:recoveryOrder.productName||'Purchased source code',reference:recoveryOrder.reference,amount:recoveryOrder.amount,currency:recoveryOrder.currency,url:`/api/download?token=${encodeURIComponent(token)}`}]});
 } const orderId=String(b.orderId||''); if(!orderId)return json(res,400,{error:'orderId is required'}); const ref=getDb().collection('orders').doc(orderId); const snap=await ref.get(); if(!snap.exists)return json(res,404,{error:'Order not found'}); const order=snap.data(); if(order.status==='paid')return json(res,200,{status:'paid',downloadToken:signDownloadToken(orderId,24*60*60),order:{id:orderId,productId:order.productId||'',productName:order.productName,amount:order.amount,currency:order.currency,reference:order.reference||'',receiptStatus:order.receiptStatus||''}}); let charge={};
 if(order.flutterwaveChargeId){
   const fw=await flwRequest(`/charges/${encodeURIComponent(order.flutterwaveChargeId)}`,{method:'GET'});
   charge=fw.data||{};
 }else if(order.reference){
   // Recovery path for a successful charge where the initial checkout response did not persist the charge id.
   const fw=await flwRequest(`/charges?reference=${encodeURIComponent(order.reference)}`,{method:'GET'});
   const rows=Array.isArray(fw.data)?fw.data:[];
   charge=rows.find(c=>String(c.reference||'')===String(order.reference))||rows[0]||{};
 }else{
   return json(res,200,{status:order.status||'pending'});
 }
 const valid=charge.status==='succeeded' && Number(charge.amount)===Number(order.amount) && String(charge.currency).toUpperCase()===String(order.currency).toUpperCase() && String(charge.reference)===String(order.reference);
 if(valid){const {receiptStatus}=await markPaid(orderId,{...charge,reference:charge.reference||order.reference}); return json(res,200,{status:'paid',downloadToken:signDownloadToken(orderId,24*60*60),order:{id:orderId,productId:order.productId||'',productName:order.productName,amount:order.amount,currency:order.currency,reference:order.reference||'',receiptStatus}});}
 if(['failed','voided'].includes(charge.status)) await ref.set({status:'failed',flutterwaveStatus:charge.status},{merge:true});
 await ref.set({flutterwaveStatus:charge.status||'pending',updatedAt:new Date()},{merge:true});
 return json(res,200,{status:charge.status||'pending',nextAction:charge.next_action||null,order:{id:orderId,productId:order.productId||'',productName:order.productName,amount:order.amount,currency:order.currency,reference:order.reference||''}});
 }catch(e){const a=e?.data?.error||{},d=e?.data?.diagnostic||{};const v=Array.isArray(a.validation_errors)?a.validation_errors:[];json(res,e.status&&e.status<500?e.status:500,{error:a.message||e.message||'Verification failed',details:{code:a.code||'',type:a.type||'',validation_errors:v,phase:d.phase||'',environment:d.environment||'',api_base_url:d.api_base_url||'',endpoint:d.endpoint||'',trace_id:d.trace_id||'',environment_hint:d.environment_hint||''}});}}
