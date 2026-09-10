import crypto from 'node:crypto';
import {getDb,flwRequest,json,method,rawBody,markPaid} from './_lib.js';

export const config = { api: { bodyParser: false } };

export default async function handler(req,res){
  if(!method(req,res,['POST']))return;
  try{
    const raw=await rawBody(req);
    const sig=String(req.headers['flutterwave-signature']||'');
    const secret=process.env.FLW_WEBHOOK_SECRET;
    if(!secret||!sig)return json(res,401,{error:'Invalid webhook signature'});
    const expected=crypto.createHmac('sha256',secret).update(raw).digest('base64');
    const a=Buffer.from(sig),b=Buffer.from(expected);
    if(a.length!==b.length||!crypto.timingSafeEqual(a,b))return json(res,401,{error:'Invalid webhook signature'});
    let p;
    try{p=JSON.parse(raw.toString('utf8'));}catch{return json(res,400,{error:'Invalid webhook JSON'});}
    const d=p.data||{};
    const orderId=d.meta?.order_id||d.meta?.orderId;
    let ref=null;
    if(orderId)ref=getDb().collection('orders').doc(String(orderId));
    else if(d.reference){const q=await getDb().collection('orders').where('reference','==',d.reference).limit(1).get();if(!q.empty)ref=q.docs[0].ref;}
    if(ref){
      const snap=await ref.get();
      if(snap.exists){
        const o=snap.data();
        if(d.id){
          const charge=await flwRequest(`/charges/${encodeURIComponent(d.id)}`,{method:'GET'});
          const c=charge.data||{};
          const valid=c.status==='succeeded'&&Number(c.amount)===Number(o.amount)&&String(c.currency).toUpperCase()===String(o.currency).toUpperCase()&&String(c.reference)===String(o.reference);
          if(valid) await markPaid(ref.id,{...c,reference:c.reference||o.reference});
          await ref.set({flutterwaveStatus:c.status||d.status,webhookId:p.id||'',updatedAt:new Date()},{merge:true});
        }
      }
    }
    return json(res,200,{received:true});
  }catch(e){return json(res,500,{error:'Webhook processing failed'});}
}
