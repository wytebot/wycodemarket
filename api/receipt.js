import {getDb,json,method,body,verifyDownloadToken,sendPurchaseReceipt} from './_lib.js';

export default async function handler(req,res){
  if(!method(req,res,['POST']))return;
  let orderId='';
  try{
    const b=await body(req);
    const token=String(b.token||'');
    const p=verifyDownloadToken(token);
    orderId=p.oid;
    const ref=getDb().collection('orders').doc(orderId);
    const snap=await ref.get();
    if(!snap.exists)return json(res,404,{error:'Order not found'});
    const order=snap.data();
    if(order.status!=='paid')return json(res,403,{error:'Payment not verified'});
    if(order.kind==='pro')return json(res,200,{status:'not_required'});
    if(order.receiptStatus==='sent')return json(res,200,{status:'sent'});
    if(!order.email)return json(res,409,{error:'Purchase email is missing'});
    await sendPurchaseReceipt({to:order.email,name:order.name,productName:order.productName,orderId,amount:order.amount,currency:order.currency,reference:order.reference});
    await ref.set({receiptStatus:'sent',receiptSentAt:new Date(),receiptError:''},{merge:true});
    return json(res,200,{status:'sent'});
  }catch(e){
    if(orderId){try{await getDb().collection('orders').doc(orderId).set({receiptStatus:'failed',receiptError:String(e?.message||e).slice(0,500)},{merge:true});}catch{}}
    return json(res,e.message==='Expired token'||e.message==='Invalid token'?401:(e.status||500),{error:e.message||'Receipt delivery failed'});
  }
}
