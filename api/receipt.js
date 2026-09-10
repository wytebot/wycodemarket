import {getDb,json,method,body,verifyDownloadToken} from './_lib.js';

// Email receipts are intentionally disabled: WyCode Market purchase recovery does not
// depend on an email provider. The verified payment screen and reference are the
// source of truth, and customers can recover later with email + Flutterwave reference.
export default async function handler(req,res){
  if(!method(req,res,['POST']))return;
  try{
    const b=await body(req);
    const p=verifyDownloadToken(String(b.token||''));
    const snap=await getDb().collection('orders').doc(p.oid).get();
    if(!snap.exists)return json(res,404,{error:'Order not found'});
    const order=snap.data();
    if(order.status!=='paid')return json(res,403,{error:'Payment not verified'});
    return json(res,200,{status:'not_sent',message:'Email receipts are disabled. Keep your payment reference; it can be used to recover the purchase later.'});
  }catch(e){return json(res,e.message==='Expired token'||e.message==='Invalid token'?401:(e.status||500),{error:e.message||'Receipt status failed'});}
}
