import crypto from 'node:crypto';
import {google} from 'googleapis';
import admin from 'firebase-admin';
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
function reviewIdFor(productId,orderId){return crypto.createHash('sha256').update(`${productId}:${orderId}`).digest('hex').slice(0,32)}
async function driveJson(d,fileId){const r=await d.files.get({fileId,alt:'media'},{responseType:'stream'});const chunks=[];for await(const chunk of r.data)chunks.push(Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk));return JSON.parse(Buffer.concat(chunks).toString('utf8'))}
async function findReviewFile(d,folder,name){const escaped=name.replace(/'/g,"\\'");const r=await d.files.list({q:`'${folder}' in parents and trashed = false and name = '${escaped}'`,fields:'files(id,name,createdTime)',pageSize:10});return r.data.files?.[0]||null}
async function writeReviewFile(d,folder,data){const name=`review-${safeFilePart(data.productId)}-${data.id}.json`;const existing=await findReviewFile(d,folder,name);if(existing?.id)return existing;return (await d.files.create({requestBody:{name,parents:[folder],mimeType:'application/json'},media:{mimeType:'application/json',body:JSON.stringify(data)}})).data}
async function updateReviewFile(d,fileId,data){await d.files.update({fileId,media:{mimeType:'application/json',body:JSON.stringify(data)}})}
async function readReviews(productId){
  const d=getWriteDrive(),folder=await reviewsFolderId(),prefix=`review-${safeFilePart(productId)}-`,out=[];let pageToken;
  do{
    const list=await d.files.list({q:`'${folder}' in parents and trashed = false and name contains '${prefix.replace(/'/g,"\\'")}'`,orderBy:'createdTime desc',fields:'nextPageToken,files(id,name,createdTime)',pageSize:100,pageToken});
    for(const f of list.data.files||[]){try{const data=await driveJson(d,f.id);if(data?.productId===productId)out.push(data)}catch{}}
    pageToken=list.data.nextPageToken||undefined;
  }while(pageToken);
  return out.sort((a,b)=>String(b.updatedAt||b.createdAt||'').localeCompare(String(a.updatedAt||a.createdAt||'')));
}
async function verifyBearer(req){
  const bearer=String(req.headers.authorization||'').replace(/^Bearer\s+/i,'').trim();
  if(!bearer)throw Object.assign(new Error('Anonymous review authentication is required.'),{status:401});
  try{return await admin.auth().verifyIdToken(bearer)}catch{throw Object.assign(new Error('Your anonymous review session is invalid or expired. Please try again.'),{status:401})}
}
async function getPaidOrder(db,productId,orderId){
  const orderRef=db.collection('orders').doc(orderId),orderSnap=await orderRef.get();
  if(!orderSnap.exists)throw Object.assign(new Error('Purchase not found.'),{status:404});
  const order=orderSnap.data()||{};
  if(order.status!=='paid')throw Object.assign(new Error('Only completed purchases can be reviewed.'),{status:403});
  if(String(order.productId)!==productId)throw Object.assign(new Error('This purchase does not belong to this product.'),{status:403});
  const productRef=db.collection('products').doc(productId),productSnap=await productRef.get();
  if(!productSnap.exists)throw Object.assign(new Error('Product not found.'),{status:404});
  const product=productSnap.data()||{};
  if(product.status!=='active'&&product.status!=='published')throw Object.assign(new Error('This product is not currently published.'),{status:409});
  return {orderRef,productRef,order,product};
}
async function authorizeEntitlement(db,productId,orderId,token,uid){
  let payload;try{payload=verifyDownloadToken(token)}catch(e){throw Object.assign(new Error(e.message==='Expired token'?'Your purchase session has expired.':'Invalid purchase token.'),{status:401})}
  if(String(payload.oid)!==orderId)throw Object.assign(new Error('Purchase token does not match this order.'),{status:403});
  await getPaidOrder(db,productId,orderId);
  await db.collection('reviewEntitlements').doc(reviewIdFor(productId,orderId)).set({productId,orderId,reviewerUid:uid||'',createdAt:admin.firestore.FieldValue.serverTimestamp()},{merge:true});
}
function aggregateFromProduct(product){const count=Math.max(0,Number(product.ratingCount)||0),raw=Number(product.ratingSum);return {count,sum:Number.isFinite(raw)?raw:count*Number(product.ratingAverage||0)}}

export default async function handler(req,res){
  if(!method(req,res,['GET','POST']))return;
  try{
    if(req.method==='GET'){
      const productId=clean(req.query?.productId,120);
      if(!productId)return json(res,400,{error:'Product is required.'});
      const reviews=await readReviews(productId);
      let myReview=null,eligibleOrders=[];
      const orderId=clean(req.query?.orderId,160),bearer=String(req.headers.authorization||'').replace(/^Bearer\s+/i,'').trim();
      if(bearer){try{const decoded=await admin.auth().verifyIdToken(bearer),uid=clean(decoded.uid,200),db=getDb();const ent=await db.collection('reviewEntitlements').where('reviewerUid','==',uid).limit(100).get();eligibleOrders=ent.docs.map(x=>x.data()).filter(x=>x.productId===productId).map(x=>String(x.orderId));if(orderId&&eligibleOrders.includes(orderId)){const claim=await db.collection('reviewClaims').doc(reviewIdFor(productId,orderId)).get();if(claim.exists&&claim.data()?.reviewerUid===uid&&claim.data()?.status==='complete'){const file=await findReviewFile(getWriteDrive(),await reviewsFolderId(),`review-${safeFilePart(productId)}-${reviewIdFor(productId,orderId)}.json`);if(file?.id)myReview=await driveJson(getWriteDrive(),file.id)}}}catch{}}
      return json(res,200,{reviews:reviews.map(r=>({id:r.id,productId:r.productId,rating:r.rating,comment:r.comment,createdAt:r.createdAt,updatedAt:r.updatedAt,anonymous:true,verifiedBuyer:true})),myReview:myReview?{id:myReview.id,rating:myReview.rating,comment:myReview.comment,createdAt:myReview.createdAt,updatedAt:myReview.updatedAt}:null,eligibleOrders});
    }
    const b=await (req.body&&typeof req.body==='object'?req.body:(async()=>{const chunks=[];for await(const c of req)chunks.push(Buffer.isBuffer(c)?c:Buffer.from(c));return JSON.parse(Buffer.concat(chunks).toString()||'{}')})());
    const action=String(b.action||'submit').toLowerCase(),productId=clean(b.productId,120),orderId=clean(b.orderId,160),token=clean(b.token,2000),comment=clean(b.comment,1200),rating=Number(b.rating);
    if(!productId||!orderId)return json(res,400,{error:'Product and purchase are required.'});
    const decoded=await verifyBearer(req),uid=clean(decoded.uid,200);if(!uid)return json(res,401,{error:'Anonymous review identity is missing.'});
    const db=getDb();
    if(action==='entitle'){
      if(!token)return json(res,400,{error:'Purchase authorization is required.'});
      await authorizeEntitlement(db,productId,orderId,token,uid);
      return json(res,200,{eligible:true});
    }
    if(!Number.isInteger(rating)||rating<1||rating>5)return json(res,400,{error:'Rating must be a whole number from 1 to 5.'});
    if(comment.length<3)return json(res,400,{error:'Please write a short review (at least 3 characters).'});
    const {productRef}=await getPaidOrder(db,productId,orderId);
    const reviewId=reviewIdFor(productId,orderId),claimRef=db.collection('reviewClaims').doc(reviewId),entitlementRef=db.collection('reviewEntitlements').doc(reviewId);
    let claimSnap=await claimRef.get();
    if(!claimSnap.exists){
      if(token)await authorizeEntitlement(db,productId,orderId,token,uid);
      else if(!(await entitlementRef.get()).exists)return json(res,403,{error:'This purchase is not yet linked to your anonymous review profile. Open the completed purchase again to enable reviews.'});
    }
    const d=getWriteDrive(),folder=await reviewsFolderId(),fileName=`review-${safeFilePart(productId)}-${reviewId}.json`;
    if(claimSnap.exists){
      let claim=claimSnap.data()||{};
      if(claim.reviewerUid&&claim.reviewerUid!==uid)return json(res,403,{error:'This purchase is already linked to another anonymous review profile.'});
      if(claim.status!=='complete'||claim.aggregateApplied!==true){
        const now=new Date().toISOString(),review={id:reviewId,productId,orderId,rating,comment,anonymous:true,reviewerUid:uid,createdAt:claim.createdAtISO||now};
        const file=await findReviewFile(d,folder,fileName);if(!file?.id)await writeReviewFile(d,folder,review);else await updateReviewFile(d,file.id,review);
        let result;
        await db.runTransaction(async tx=>{
          const c=await tx.get(claimRef);const p=await tx.get(productRef);if(!c.exists)throw new Error('Review state changed. Please try again.');
          const current=c.data()||{};if(current.reviewerUid&&current.reviewerUid!==uid)throw Object.assign(new Error('This purchase is already linked to another anonymous review profile.'),{code:'REVIEW_OWNER'});
          if(current.aggregateApplied===true){const x=aggregateFromProduct(p.data()||{});result={ratingAverage:Number((p.data()||{}).ratingAverage||0),ratingCount:x.count};return;}
          const x=aggregateFromProduct(p.data()||{}),nextCount=x.count+1,nextSum=x.sum+rating,avg=Math.round((nextSum/nextCount)*10)/10;
          tx.set(productRef,{ratingSum:nextSum,ratingCount:nextCount,ratingAverage:avg,updatedAt:admin.firestore.FieldValue.serverTimestamp()},{merge:true});
          tx.set(claimRef,{reviewId,productId,orderId,reviewerUid:uid,rating,comment,createdAtISO:current.createdAtISO||review.createdAt,status:'complete',aggregateApplied:true,updatedAt:admin.firestore.FieldValue.serverTimestamp()},{merge:true});
          result={ratingAverage:avg,ratingCount:nextCount};
        });
        return json(res,200,{review,...result,repaired:true});
      }
      const oldRating=Number(claim.rating||0),now=new Date().toISOString(),review={id:reviewId,productId,orderId,rating,comment,anonymous:true,reviewerUid:uid,createdAt:claim.createdAtISO||now,updatedAt:now};
      const file=await findReviewFile(d,folder,fileName);if(!file?.id)await writeReviewFile(d,folder,review);else await updateReviewFile(d,file.id,review);
      let result;
      await db.runTransaction(async tx=>{
        const c=await tx.get(claimRef);const p=await tx.get(productRef);if(!c.exists)throw new Error('Review state changed. Please try again.');
        const current=c.data()||{};if(current.reviewerUid&&current.reviewerUid!==uid)throw Object.assign(new Error('This purchase is already linked to another anonymous review profile.'),{code:'REVIEW_OWNER'});
        const x=aggregateFromProduct(p.data()||{}),nextSum=x.sum-oldRating+rating,avg=x.count>0?Math.round((nextSum/x.count)*10)/10:rating;
        tx.set(productRef,{ratingSum:nextSum,ratingCount:x.count,ratingAverage:avg,updatedAt:admin.firestore.FieldValue.serverTimestamp()},{merge:true});
        tx.set(claimRef,{rating,comment,updatedAt:admin.firestore.FieldValue.serverTimestamp(),status:'complete',aggregateApplied:true},{merge:true});
        result={ratingAverage:avg,ratingCount:x.count};
      });
      return json(res,200,{review,...result,updated:true});
    }
    await db.runTransaction(async tx=>{
      const c=await tx.get(claimRef);if(c.exists)throw Object.assign(new Error('You already reviewed this purchase.'),{code:'ALREADY_REVIEWED'});
      tx.create(claimRef,{reviewId,productId,orderId,reviewerUid:uid,rating,comment,createdAtISO:new Date().toISOString(),status:'pending',aggregateApplied:false,createdAt:admin.firestore.FieldValue.serverTimestamp()});
    });
    const review={id:reviewId,productId,orderId,rating,comment,anonymous:true,reviewerUid:uid,createdAt:new Date().toISOString()};
    try{await writeReviewFile(d,folder,review)}catch(e){try{await claimRef.delete()}catch{}throw e}
    let result;
    await db.runTransaction(async tx=>{
      const c=await tx.get(claimRef);const p=await tx.get(productRef);if(!c.exists)throw new Error('Review reservation was lost. Please try again.');
      const current=c.data()||{};if(current.aggregateApplied===true){const x=aggregateFromProduct(p.data()||{});result={ratingAverage:Number((p.data()||{}).ratingAverage||0),ratingCount:x.count};return;}
      const x=aggregateFromProduct(p.data()||{}),nextCount=x.count+1,nextSum=x.sum+rating,avg=Math.round((nextSum/nextCount)*10)/10;
      tx.set(productRef,{ratingSum:nextSum,ratingCount:nextCount,ratingAverage:avg,updatedAt:admin.firestore.FieldValue.serverTimestamp()},{merge:true});
      tx.set(claimRef,{status:'complete',aggregateApplied:true},{merge:true});result={ratingAverage:avg,ratingCount:nextCount};
    });
    return json(res,200,{review,...result});
  }catch(e){const status=Number(e?.status)||(e?.code==='ALREADY_REVIEWED'?409:500);return json(res,status,{error:e.message||'Unable to save reviews right now.'})}
}
