import {getDb,flwRequest,json,method,body,encryptCardField,randomNonce} from './_lib.js';

function authError(msg){const e=new Error(msg);e.status=400;return e;}

export default async function handler(req,res){
  if(!method(req,res,['POST']))return;
  try{
    const b=await body(req);
    const orderId=String(b.orderId||'').trim();
    const kind=String(b.kind||'').trim();
    if(!orderId)return json(res,400,{error:'orderId is required'});
    if(!['pin','otp','avs'].includes(kind))return json(res,400,{error:'Unsupported authorization type'});

    const ref=getDb().collection('orders').doc(orderId);
    const snap=await ref.get();
    if(!snap.exists)return json(res,404,{error:'Order not found'});
    const order=snap.data();
    if(order.status==='paid')return json(res,200,{status:'paid'});
    const chargeId=String(order.flutterwaveChargeId||'').trim();
    if(!chargeId)return json(res,400,{error:'This order has no charge to authorize yet. Please start checkout again.'});

    let authorization;
    if(kind==='pin'){
      const pin=String(b.pin||'').replace(/\D/g,'');
      if(!/^\d{4,6}$/.test(pin))throw authError('Enter the 4-6 digit PIN on your card.');
      const encryptionKey=process.env.FLW_ENCRYPTION_KEY;
      if(!encryptionKey)throw new Error('Missing FLW_ENCRYPTION_KEY');
      const nonce=randomNonce();
      authorization={type:'pin',pin:{nonce,encrypted_pin:encryptCardField(pin,encryptionKey,nonce)}};
    }else if(kind==='otp'){
      const code=String(b.otp||'').replace(/\D/g,'');
      if(!/^\d{4,8}$/.test(code))throw authError('Enter the code sent to you.');
      authorization={type:'otp',otp:{code}};
    }else{
      const a=b.address&&typeof b.address==='object'?b.address:{};
      const address={
        country:String(a.country||'').trim().toUpperCase(),
        city:String(a.city||'').trim(),
        state:String(a.state||'').trim(),
        postal_code:String(a.postal_code||'').trim(),
        line1:String(a.line1||'').trim(),
        line2:String(a.line2||'').trim()
      };
      if(!/^[A-Z]{2}$/.test(address.country)||!address.city||!address.line1||!address.postal_code)throw authError('Enter a complete billing address.');
      if(!address.line2)delete address.line2;
      authorization={type:'avs',avs:{address}};
    }

    // Submits the PIN/OTP/AVS challenge Flutterwave asked for back to the same charge via the
    // v4 update-charge endpoint. Until this call happens, a charge that returned
    // next_action.type === 'authorize' just sits pending forever — polling /api/verify alone
    // can never resolve it.
    const fw=await flwRequest(`/charges/${encodeURIComponent(chargeId)}`,{method:'PUT',body:JSON.stringify({authorization})});
    const data=fw.data||{};
    await ref.set({flutterwaveStatus:data.status||order.flutterwaveStatus||'',updatedAt:new Date()},{merge:true});
    return json(res,200,{status:data.status||'pending',nextAction:data.next_action||null});
  }catch(e){
    const apiError=e?.data?.error||{};
    const diagnostic=e?.data?.diagnostic||{};
    const validation=Array.isArray(apiError.validation_errors)?apiError.validation_errors:[];
    const details={code:apiError.code||'',type:apiError.type||'',validation_errors:validation,phase:diagnostic.phase||'',environment:diagnostic.environment||'',api_base_url:diagnostic.api_base_url||'',endpoint:diagnostic.endpoint||'',trace_id:diagnostic.trace_id||'',environment_hint:diagnostic.environment_hint||''};
    return json(res,e.status&&e.status<500?e.status:500,{error:apiError.message||e.message||'Could not confirm this payment step.',details});
  }
}
