import {getDb,flwRequest,json,method,body,signDownloadToken,markPaid} from './_lib.js';
export default async function handler(req,res){ if(!method(req,res,['GET','POST']))return; try{ const b=req.method==='POST'?await body(req):req.query||{};
 if(req.method==='POST' && String(b.action||'').toLowerCase()==='recover_purchase'){
   const email=String(b.email||'').trim().toLowerCase();
   const reference=String(b.reference||'').trim();
   if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))return json(res,400,{error:'Enter the email address used for the purchase.'});
   if(reference.length<8||reference.length>100)return json(res,400,{error:'Enter the Flutterwave payment reference from your original payment receipt.'});

   const db=getDb();
   const normalize=v=>String(v??'').trim().toLowerCase();
   const refFields=['reference','flutterwaveReference','tx_ref','txRef','transactionRef','transaction_reference','paymentReference','payment_ref','flw_ref','flwRef'];
   const emailSnap=await db.collection('orders').where('email','==',email).limit(50).get();
   const candidates=emailSnap.docs.map(d=>({id:d.id,...d.data()}));
   const exact=candidates.find(o=>refFields.some(k=>normalize(o[k])===normalize(reference)));
   let recoveryOrder=exact||null;
   let charge=null;

   // New orders normally have the reference on the order. Older orders may not have that field,
   // so fall back to Flutterwave using the reference supplied from the original payment receipt.
   if(!recoveryOrder){
     try{
       const fw=await flwRequest(`/charges?reference=${encodeURIComponent(reference)}`,{method:'GET'});
       const rows=Array.isArray(fw.data)?fw.data:[];
       charge=rows.find(c=>normalize(c.reference)===normalize(reference))||rows[0]||null;
     }catch(e){
       // If Flutterwave cannot be queried, still allow an exact legacy reference match above.
       if(!exact) throw e;
     }
     if(charge){
       const chargeId=String(charge.id||'');
       recoveryOrder=candidates.find(o=>chargeId&&String(o.flutterwaveChargeId||'')===chargeId)||null;
       if(!recoveryOrder){
         const sameMoney=candidates.filter(o=>Number(o.amount)===Number(charge.amount)&&String(o.currency||'').toUpperCase()===String(charge.currency||'').toUpperCase());
         if(sameMoney.length===1) recoveryOrder=sameMoney[0];
         else if(sameMoney.length>1){
           const chargeTime=Date.parse(charge.created_at||charge.createdAt||'');
           if(Number.isFinite(chargeTime)){
             const ranked=sameMoney.map(o=>({o,t:o.createdAt?.toDate?o.createdAt.toDate().getTime():Date.parse(o.createdAt||'')})).filter(x=>Number.isFinite(x.t)).sort((a,b)=>Math.abs(a.t-chargeTime)-Math.abs(b.t-chargeTime));
             if(ranked.length&&Math.abs(ranked[0].t-chargeTime)<=7*24*60*60*1000&&(ranked.length===1||Math.abs(ranked[0].t-chargeTime)<Math.abs(ranked[1].t-chargeTime))) recoveryOrder=ranked[0].o;
           }
         }
       }
     }
   }

   if(!recoveryOrder)return json(res,404,{error:'No completed purchase matched that email and payment reference. Older purchases are supported when the reference appears on the original Flutterwave receipt.'});
   if(String(recoveryOrder.email||'').trim().toLowerCase()!==email)return json(res,403,{error:'The purchase email does not match that payment reference.'});

   // If this is an older paid order, its stored reference may be missing. When Flutterwave returned
   // a charge, re-check the critical payment fields before granting a new download token.
   if(charge){
     const valid=charge.status==='succeeded' && Number(charge.amount)===Number(recoveryOrder.amount) && String(charge.currency||'').toUpperCase()===String(recoveryOrder.currency||'').toUpperCase() && normalize(charge.reference)===normalize(reference);
     if(!valid)return json(res,409,{error:'Flutterwave could not confirm that payment as a completed charge for this purchase.'});
     const paid=await markPaid(recoveryOrder.id,{...charge,reference:charge.reference||reference});
     recoveryOrder.status='paid';
     recoveryOrder.reference=charge.reference||recoveryOrder.reference||reference;
     recoveryOrder.receiptStatus=paid.receiptStatus;
   }
   if(recoveryOrder.status!=='paid')return json(res,409,{error:'This payment has not been verified as completed yet.'});
   if(!String(recoveryOrder.driveFileId||'').trim())return json(res,409,{error:'This purchase is verified, but its source file is not ready for recovery yet.'});
   const token=signDownloadToken(recoveryOrder.id,24*60*60);
   return json(res,200,{ok:true,purchases:[{id:recoveryOrder.id,name:recoveryOrder.productName||'Purchased source code',reference:recoveryOrder.reference||recoveryOrder.flutterwaveReference||reference,amount:recoveryOrder.amount,currency:recoveryOrder.currency,url:`/api/download?token=${encodeURIComponent(token)}`}]});
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
