import crypto from 'node:crypto';
import {google} from 'googleapis';
import {getDb,json,method,verifyDownloadToken} from './_lib.js';

function serviceAccount(){
  const raw=process.env.GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON;
  if(!raw)throw new Error('Google Drive is not configured.');
  try{return JSON.parse(raw)}catch{throw new Error('Invalid GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON.')} 
}
let drive;
function getWriteDrive(){
  if(drive)return drive;
  const sa=serviceAccount();
  const auth=new google.auth.GoogleAuth({credentials:sa,scopes:['https://www.googleapis.com/auth/drive']});
  drive=google.drive({version:'v3',auth});
  return drive;
}
async function reviewsFolderId(){
  const d=getWriteDrive();
  const configured=String(process.env.GOOGLE_DRIVE_REVIEWS_FOLDER_ID||'').trim();
  if(configured)return configured;
  const parent=String(process.env.GOOGLE_DRIVE_FOLDER_ID||'').trim();
  if(!parent)throw new Error('GOOGLE_DRIVE_FOLDER_ID is required for review storage.');
  const q=`'${parent.replace(/'/g,"\\'")}' in parents and name = 'WyCode Reviews' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
  const found=await d.files.list({q,fields:'files(id,name)',pageSize:1});
  if(found.data.files?.[0]?.id)return found.data.files[0].id;
  const created=await d.files.create({requestBody:{name:'WyCode Reviews',mimeType:'application/vnd.google-apps.folder',parents:[parent]},fields:'id'});
  if(!created.data.id)throw new Error('Could not create the reviews folder in Google Drive.');
  return created.data.id;
}
function clean(v,max){return String(v??'').trim().slice(0,max)}
function safeFilePart(v){return clean(v,80).replace(/[^a-zA-Z0-9_-]/g,'_')||'unknown'}
async function driveJson(d,fileId){const r=await d.files.get({fileId,alt:'media'},{responseType:'stream'});const chunks=[];for await(const chunk of r.data)chunks.push(Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk));return JSON.parse(Buffer.concat(chunks).toString('utf8'));}
async function readReviews(productId){
  const d=getWriteDrive(), folder=await reviewsFolderId();
  const prefix=`review-${safeFilePart(productId)}-`;
  const q=`'${folder}' in parents and trashed = false and name contains '${prefix.replace(/'/g,"\\'")}'`;
  const out=[];let pageToken;
  do{
    const list=await d.files.list({q,orderBy:'createdTime desc',fields:'nextPageToken,files(id,name,createdTime)',pageSize:100,pageToken});
    for(const f of (list.data.files||[])){
      try{const data=await driveJson(d,f.id);if(data?.productId===productId)out.push(data)}catch{}
    }
    pageToken=list.data.nextPageToken||undefined;
  }while(pageToken);
  return out.sort((a,b)=>String(b.createdAt||'').localeCompare(String(a.createdAt||'')));
}
export default async function handler(req,res){
  if(!method(req,res,['GET','POST']))return;
  try{
    if(req.method==='GET'){
      const productId=clean(req.query?.productId,120);
      if(!productId)return json(res,400,{error:'Product is required.'});
      const reviews=await readReviews(productId);
      return json(res,200,{reviews:reviews.map(r=>({id:r.id,productId:r.productId,rating:r.rating,comment:r.comment,createdAt:r.createdAt,anonymous:true}))});
    }
    const b=await (req.body&&typeof req.body==='object'?req.body:(async()=>{const chunks=[];for await(const c of req)chunks.push(Buffer.isBuffer(c)?c:Buffer.from(c));return JSON.parse(Buffer.concat(chunks).toString()||'{}')})());
    const productId=clean(b.productId,120),orderId=clean(b.orderId,160),token=clean(b.token,2000),comment=clean(b.comment,1200);const rating=Number(b.rating);
    if(!productId||!orderId||!token)return json(res,400,{error:'Product, purchase and review authorization are required.'});
    if(!Number.isInteger(rating)||rating<1||rating>5)return json(res,400,{error:'Rating must be a whole number from 1 to 5.'});
    if(comment.length<3)return json(res,400,{error:'Please write a short review (at least 3 characters).'});
    let tokenPayload;try{tokenPayload=verifyDownloadToken(token)}catch(e){return json(res,401,{error:e.message==='Expired token'?'Your purchase session has expired. Download the purchase again to review it.':'Invalid purchase token.'})}
    if(String(tokenPayload.oid)!==orderId)return json(res,403,{error:'Purchase token does not match this order.'});
    const db=getDb(),orderRef=db.collection('orders').doc(orderId),productRef=db.collection('products').doc(productId),orderSnap=await orderRef.get(),productSnap=await productRef.get();
    if(!orderSnap.exists)return json(res,404,{error:'Purchase not found.'});
    const order=orderSnap.data()||{},product=productSnap.exists?productSnap.data()||{}:{};
    if(order.status!=='paid')return json(res,403,{error:'Only completed purchases can be reviewed.'});
    if(String(order.productId)!==productId)return json(res,403,{error:'This purchase does not belong to this product.'});
    if(!productSnap.exists)return json(res,404,{error:'Product not found.'});
    if(product.status!=='active'&&product.status!=='published')return json(res,409,{error:'This product is not currently published.'});
    const folder=await reviewsFolderId(),d=getWriteDrive();
    const bearer=String(req.headers.authorization||'').replace(/^Bearer\s+/i,'').trim();
    if(!bearer)return json(res,401,{error:'Anonymous review authentication is required.'});
    let decoded;
    try{decoded=await (await import('firebase-admin')).default.auth().verifyIdToken(bearer)}catch{return json(res,401,{error:'Your anonymous review session is invalid or expired. Please try again.'})}
    const uid=clean(decoded.uid,200);
    if(!uid)return json(res,401,{error:'Anonymous review identity is missing.'});
    const existing=await readReviews(productId);
    const same=existing.find(x=>String(x.orderId)===orderId);
    if(same)return json(res,409,{error:'You already reviewed this purchase.'});
    const reviewId=crypto.createHash('sha256').update(`${productId}:${orderId}`).digest('hex').slice(0,32);
    const data={id:reviewId,productId,orderId,rating,comment,anonymous:true,reviewerUid:uid,createdAt:new Date().toISOString()};
    try{
      await d.files.create({requestBody:{name:`review-${safeFilePart(productId)}-${reviewId}.json`,parents:[folder],mimeType:'application/json'},media:{mimeType:'application/json',body:JSON.stringify(data)}});
    }catch(e){
      const after=await readReviews(productId);
      if(after.some(x=>String(x.orderId)===orderId))return json(res,409,{error:'You already reviewed this purchase.'});
      throw e;
    }
    const oldCount=Math.max(0,Number(product.ratingCount)||0),storedSum=Number(product.ratingSum),oldSum=Number.isFinite(storedSum)?storedSum:(oldCount>0?Number(product.ratingAverage||product.rating||0)*oldCount:0);const nextCount=oldCount+1,nextSum=oldSum+rating,avg=Math.round((nextSum/nextCount)*10)/10;
    await productRef.set({ratingSum:nextSum,ratingCount:nextCount,ratingAverage:avg,updatedAt:new Date()},{merge:true});
    return json(res,200,{review:{...data},ratingAverage:avg,ratingCount:nextCount});
  }catch(e){return json(res,500,{error:e.message||'Unable to save reviews right now.'});}
}
