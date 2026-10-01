import crypto from 'node:crypto';
import {google} from 'googleapis';
import admin from 'firebase-admin';
import {getDb,json,method} from './_lib.js';
const clean=(v,n)=>String(v??'').trim().slice(0,n);
const reviewId=(productId,uid)=>crypto.createHash('sha256').update(`${productId}:${uid}`).digest('hex').slice(0,40);
const PRIMARY_REVIEWS_FOLDER='15J2hZALRWNrNEj27cbPcTeuKzhkc9XkY';
const FALLBACK_REVIEWS_FOLDER='1sywZa56KKtJE0HMoKuCzBdloD_7b-1e-';
function drive(){const raw=process.env.GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON;if(!raw)throw new Error('Google Drive review storage is not configured.');let sa;try{sa=JSON.parse(raw)}catch{throw new Error('Invalid Google Drive service account.')}const auth=new google.auth.GoogleAuth({credentials:sa,scopes:['https://www.googleapis.com/auth/drive']});return google.drive({version:'v3',auth});}
async function buyer(req){getDb();const t=String(req.headers.authorization||'').replace(/^Bearer\s+/i,'').trim();if(!t)throw Object.assign(new Error('A verified buyer account is required.'),{status:401});try{const u=await admin.auth().verifyIdToken(t);if(u.firebase?.sign_in_provider!=='google.com')throw new Error('A Google buyer account is required.');return u}catch(e){throw Object.assign(new Error(e.message==='A Google buyer account is required.'?e.message:'Buyer session expired.'),{status:401});}}
async function paidPurchase(db,productId,uid){const q=await db.collection('orders').where('buyerUid','==',uid).limit(100).get();return q.docs.map(d=>({id:d.id,...d.data()})).find(o=>o.productId===productId&&o.status==='paid')||null;}
function storageFull(e){const text=String(e?.message||'').toLowerCase();const reason=(e?.errors||[]).map(x=>String(x.reason||'')).join(' ').toLowerCase();return /storage.?quota|quota.?exceeded|insufficient.?storage|storagefull|limit.?exceeded/.test(`${text} ${reason}`);}
async function saveDriveReview(review){const d=drive(),name=`review-${clean(review.productId,80)}-${review.id}.json`,body=JSON.stringify(review);let last=null;for(const folder of [PRIMARY_REVIEWS_FOLDER,FALLBACK_REVIEWS_FOLDER]){try{const q=`'${folder}' in parents and name = '${name}' and trashed = false`,found=await d.files.list({q,fields:'files(id)',pageSize:1});if(found.data.files?.[0]?.id)await d.files.update({fileId:found.data.files[0].id,media:{mimeType:'application/json',body}});else await d.files.create({requestBody:{name,parents:[folder],mimeType:'application/json'},media:{mimeType:'application/json',body}});return {folder,usedFallback:folder===FALLBACK_REVIEWS_FOLDER};}catch(e){last=e;if(!storageFull(e)&&folder===PRIMARY_REVIEWS_FOLDER)break;}}
throw last||new Error('Unable to store review.');}
export default async function handler(req,res){
  if(!method(req,res,['GET','POST']))return;
  try{
    const db=getDb();
    if(req.method==='GET'){
      const productId=clean(req.query?.productId,120);
      if(!productId)return json(res,400,{error:'Product is required.'});
      const snap=await db.collection('reviewClaims').where('productId','==',productId).where('status','==','complete').limit(500).get();
      const reviews=snap.docs.map(d=>{const x=d.data()||{};return{id:d.id,rating:Number(x.rating||0),comment:String(x.comment||''),createdAt:x.createdAtISO||'',updatedAt:x.updatedAtISO||'',verifiedBuyer:true,anonymous:true};}).filter(x=>x.rating>=1&&x.rating<=5).sort((a,b)=>String(b.updatedAt||b.createdAt).localeCompare(String(a.updatedAt||a.createdAt)));
      let eligible=false,myReview=null;
      if(req.headers.authorization){
        try{
          const u=await buyer(req),order=await paidPurchase(db,productId,u.uid);
          if(order){
            eligible=true;
            const id=reviewId(productId,u.uid),r=await db.collection('reviewClaims').doc(id).get();
            if(r.exists&&r.data()?.status==='complete'){
              const x=r.data();
              myReview={id,rating:Number(x.rating),comment:String(x.comment||''),createdAt:x.createdAtISO||'',updatedAt:x.updatedAtISO||''};
            }
          }
        }catch{}
      }
      return json(res,200,{reviews,eligible,myReview});
    }

    const u=await buyer(req),b=req.body&&typeof req.body==='object'?req.body:JSON.parse((await(async()=>{const c=[];for await(const x of req)c.push(Buffer.isBuffer(x)?x:Buffer.from(x));return Buffer.concat(c).toString()}))()||'{}');
    const productId=clean(b.productId,120),rating=Number(b.rating),comment=clean(b.comment,1200);
    if(!productId||!Number.isInteger(rating)||rating<1||rating>5||comment.length<3)return json(res,400,{error:'Product, 1–5 rating and a meaningful review are required.'});
    const productRef=db.collection('products').doc(productId),productSnap=await productRef.get();
    if(!productSnap.exists)return json(res,404,{error:'Product not found.'});
    const product=productSnap.data()||{};
    if(!['published','active'].includes(product.status))return json(res,409,{error:'This product is not currently available for review.'});
    const orderSnap=await paidPurchase(db,productId,u.uid);
    if(!orderSnap)return json(res,403,{error:'Only verified buyers can review this product.'});

    const id=reviewId(productId,u.uid),claimRef=db.collection('reviewClaims').doc(id);
    const sellerUid=String(product.sellerUid||'');
    if(!sellerUid)return json(res,409,{error:'This product has no valid seller account.'});
    const sellerRef=db.collection('sellers').doc(sellerUid);
    let result,editing=false;

    await db.runTransaction(async tx=>{
      const [claim,prod,seller]=await Promise.all([tx.get(claimRef),tx.get(productRef),tx.get(sellerRef)]);
      if(!seller.exists)throw Object.assign(new Error('Seller account not found.'),{status:404});
      const p=prod.data()||{},s=seller.data()||{},old=claim.exists?claim.data()||{}:null;
      const sellerCount=Math.max(0,Number(s.ratingCount||0));
      const sellerSum=Number.isFinite(Number(s.ratingSum))?Number(s.ratingSum):sellerCount*Number(s.ratingAverage||0);

      if(old?.status==='complete'){
        editing=true;
        const oldRating=Number(old.rating||0);
        if(oldRating<1||oldRating>5)throw Object.assign(new Error('Existing review is invalid.'),{status:409});
        const nextSum=Math.max(0,sellerSum-oldRating+rating);
        const nextAvg=sellerCount?Math.round((nextSum/sellerCount)*10)/10:0;
        const nowISO=new Date().toISOString();
        tx.set(claimRef,{rating,comment,updatedAtISO:nowISO,updatedAt:admin.firestore.FieldValue.serverTimestamp()},{merge:true});
        tx.set(sellerRef,{ratingSum:nextSum,ratingCount:sellerCount,ratingAverage:nextAvg,updatedAt:admin.firestore.FieldValue.serverTimestamp()},{merge:true});
        tx.set(productRef,{sellerRatingAverage:nextAvg,sellerRatingCount:sellerCount,ratingAverage:nextAvg,updatedAt:admin.firestore.FieldValue.serverTimestamp()},{merge:true});
        result={ratingAverage:nextAvg,ratingCount:Math.max(0,Number(p.ratingCount||0))};
        return;
      }

      const productReviewCount=Math.max(0,Number(p.ratingCount||0));
      const nextSellerCount=sellerCount+1;
      const nextSellerSum=sellerSum+rating;
      const nextAvg=Math.round((nextSellerSum/nextSellerCount)*10)/10;
      const nowISO=new Date().toISOString();
      tx.create(claimRef,{reviewId:id,productId,reviewerUid:u.uid,orderId:orderSnap.id,rating,comment,status:'complete',createdAtISO:nowISO,updatedAtISO:nowISO,createdAt:admin.firestore.FieldValue.serverTimestamp()});
      tx.set(sellerRef,{ratingSum:nextSellerSum,ratingCount:nextSellerCount,ratingAverage:nextAvg,updatedAt:admin.firestore.FieldValue.serverTimestamp()},{merge:true});
      tx.update(productRef,{sellerRatingAverage:nextAvg,sellerRatingCount:nextSellerCount,ratingAverage:nextAvg,ratingCount:productReviewCount+1,updatedAt:admin.firestore.FieldValue.serverTimestamp()});
      result={ratingAverage:nextAvg,ratingCount:productReviewCount+1};
    });

    try{
      await saveDriveReview({id,productId,sellerUid,rating,comment,reviewer:'anonymous verified buyer',edited:editing,updatedAt:new Date().toISOString()});
    }catch(e){
      await claimRef.set({driveSyncError:String(e.message||'Drive sync failed').slice(0,500)},{merge:true});
    }
    return json(res,200,{ok:true,edited:editing,...result});
  }catch(e){
    json(res,e.status&&e.status<500?e.status:500,{error:e.message||'Unable to save review.'});
  }
}
