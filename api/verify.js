import {getDb,flwRequest,json,method,body,signDownloadToken,markPaid} from './_lib.js';
export default async function handler(req,res){ if(!method(req,res,['GET','POST']))return; try{ const b=req.method==='POST'?await body(req):req.query||{}; const orderId=String(b.orderId||''); if(!orderId)return json(res,400,{error:'orderId is required'}); const ref=getDb().collection('orders').doc(orderId); const snap=await ref.get(); if(!snap.exists)return json(res,404,{error:'Order not found'}); const order=snap.data(); if(order.status==='paid')return json(res,200,{status:'paid',downloadToken:signDownloadToken(orderId,24*60*60),order:{id:orderId,productId:order.productId||'',productName:order.productName,amount:order.amount,currency:order.currency,reference:order.reference||'',receiptStatus:order.receiptStatus||''}}); let charge={};
 if(order.flutterwaveChargeId){
   const fw=await flwRequest(`/charges/${encodeURIComponent(order.flutterwaveChargeId)}`,{method:'GET'});
   charge=fw.data||{};
 }else if(order.reference){
   // Fallback path for a successful charge where the initial checkout response did not persist the charge id.
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
