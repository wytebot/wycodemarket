import {body,getDb,json,method,verifyDownloadToken} from './_lib.js';

export default async function handler(req,res){
  if(!method(req,res,['POST']))return;
  try{
    const b=await body(req);
    const productId=String(b.productId||'').trim();
    const orderId=String(b.orderId||'').trim();
    const token=String(b.token||'').trim();
    const rating=Number(b.rating);
    if(!token)return json(res,401,{error:'A valid purchase token is required to rate this product.'});
    let tokenPayload;
    try{ tokenPayload=verifyDownloadToken(token); }catch(e){ return json(res,401,{error:e.message==='Expired token'?'Your purchase session has expired. Download the purchase again to rate it.':'Invalid purchase token.'}); }
    if(String(tokenPayload.oid)!==orderId)return json(res,403,{error:'Purchase token does not match this order.'});
    if(!productId||!orderId)return json(res,400,{error:'Product and order are required.'});
    if(!Number.isInteger(rating)||rating<1||rating>5)return json(res,400,{error:'Rating must be a whole number from 1 to 5.'});
    const db=getDb();
    const productRef=db.collection('products').doc(productId);
    const orderRef=db.collection('orders').doc(orderId);
    const ratingRef=productRef.collection('ratings').doc(orderId);
    const result=await db.runTransaction(async tx=>{
      const [productSnap,orderSnap,ratingSnap]=await Promise.all([tx.get(productRef),tx.get(orderRef),tx.get(ratingRef)]);
      if(!productSnap.exists)return {error:'Product not found.',status:404};
      if(!orderSnap.exists)return {error:'Purchase not found.',status:404};
      const product=productSnap.data()||{};
      const order=orderSnap.data()||{};
      if(order.status!=='paid')return {error:'Only completed purchases can be rated.',status:403};
      if(String(order.productId)!==productId)return {error:'This purchase does not belong to this product.',status:403};
      if(product.status!=='active'&&product.status!=='published')return {error:'This product is not currently published.',status:409};
      const old=ratingSnap.exists?Number(ratingSnap.data()?.rating||0):0;
      const oldCount=Number.isFinite(Number(product.ratingCount))&&Number(product.ratingCount)>0?Number(product.ratingCount):0;
      const storedSum=Number(product.ratingSum);
      const oldSum=Number.isFinite(storedSum)?storedSum:(oldCount>0?Number(product.ratingAverage||product.rating||0)*oldCount:0);
      const nextSum=oldSum-old+(rating);
      const nextCount=old?oldCount:oldCount+1;
      const avg=nextCount?Math.round((nextSum/nextCount)*10)/10:0;
      tx.set(ratingRef,{rating,orderId,updatedAt:new Date(),createdAt:ratingSnap.exists?(ratingSnap.data()?.createdAt||new Date()):new Date()},{merge:true});
      tx.update(productRef,{ratingSum:nextSum,ratingCount:nextCount,ratingAverage:avg});
      return {ratingAverage:avg,ratingCount:nextCount};
    });
    if(result.error)return json(res,result.status,{error:result.error});
    return json(res,200,result);
  }catch(e){
    return json(res,500,{error:e.message||'Unable to save rating right now.'});
  }
}
