import admin from 'firebase-admin';
import {google} from 'googleapis';
import {getDb,json,method,body} from './_lib.js';
const clean=(v,n)=>String(v??'').trim().slice(0,n);
const REPORT_REASONS=new Set(['Fake or mismatched live demo','Source code does not match listing','Product is broken or unusable','Misleading product information','Other']);
const PRIMARY_REVIEWS_FOLDER='15J2hZALRWNrNEj27cbPcTeuKzhkc9XkY';
const FALLBACK_REVIEWS_FOLDER='1sywZa56KKtJE0HMoKuCzBdloD_7b-1e-';
function drive(){const raw=process.env.GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON;if(!raw)throw new Error('Google Drive review/report storage is not configured.');let sa;try{sa=JSON.parse(raw)}catch{throw new Error('Invalid Google Drive service account.')}const auth=new google.auth.GoogleAuth({credentials:sa,scopes:['https://www.googleapis.com/auth/drive']});return google.drive({version:'v3',auth});}
function storageFull(e){const text=String(e?.message||'').toLowerCase();const reason=(e?.errors||[]).map(x=>String(x.reason||'')).join(' ').toLowerCase();return /storage.?quota|quota.?exceeded|insufficient.?storage|storagefull|limit.?exceeded/.test(`${text} ${reason}`);}
async function saveDriveReport(report){const d=drive(),name=`report-${clean(report.sellerUid,80)}-${report.reporterUid}.json`,payload=JSON.stringify(report);let last=null;for(const folder of [PRIMARY_REVIEWS_FOLDER,FALLBACK_REVIEWS_FOLDER]){try{const q=`'${folder}' in parents and name = '${name}' and trashed = false`,found=await d.files.list({q,fields:'files(id)',pageSize:1});if(found.data.files?.[0]?.id)await d.files.update({fileId:found.data.files[0].id,media:{mimeType:'application/json',body:payload}});else await d.files.create({requestBody:{name,parents:[folder],mimeType:'application/json'},media:{mimeType:'application/json',body:payload}});return {folder,usedFallback:folder===FALLBACK_REVIEWS_FOLDER};}catch(e){last=e;if(!storageFull(e)&&folder===PRIMARY_REVIEWS_FOLDER)break;}}throw last||new Error('Unable to store report.');}
async function buyer(req){getDb();const t=String(req.headers.authorization||'').replace(/^Bearer\s+/i,'').trim();if(!t)throw Object.assign(new Error('A verified buyer account is required.'),{status:401});try{const u=await admin.auth().verifyIdToken(t);if(u.firebase?.sign_in_provider!=='google.com')throw new Error('A Google buyer account is required.');return u}catch(e){throw Object.assign(new Error(e.message==='A Google buyer account is required.'?e.message:'Buyer session expired.'),{status:401});}}
export default async function handler(req,res){
  if(!method(req,res,['POST']))return;
  try{
    const u=await buyer(req),b=await body(req),sellerUid=clean(b.sellerUid,200),productId=clean(b.productId,120),reason=clean(b.reason,120);
    if(!sellerUid||!productId||!reason)return json(res,400,{error:'Product, seller and report reason are required.'});
    if(!REPORT_REASONS.has(reason))return json(res,400,{error:'Choose a valid report reason.'});
    const db=getDb(),sellerRef=db.collection('sellers').doc(sellerUid),productRef=db.collection('products').doc(productId);
    const sellerSnap=await sellerRef.get(),productSnap=await productRef.get();
    if(!sellerSnap.exists||!productSnap.exists||String(productSnap.data()?.sellerUid)!==sellerUid)return json(res,404,{error:'Seller or product not found.'});
    const purchases=await db.collection('orders').where('buyerUid','==',u.uid).limit(100).get();
    if(!purchases.docs.some(d=>d.data()?.productId===productId&&d.data()?.status==='paid'))return json(res,403,{error:'Only verified buyers of this product can report its seller.'});
    // One report per buyer account against a seller, regardless of which seller product was reported.
    const reportRef=db.collection('sellerReports').doc(`${sellerUid}_${u.uid}`);
    let count=0,banned=false;
    await db.runTransaction(async tx=>{
      const [s,r]=await Promise.all([tx.get(sellerRef),tx.get(reportRef)]);
      if(r.exists)throw Object.assign(new Error('You have already reported this seller account.'),{status:409});
      const seller=s.data()||{};
      count=Number(seller.reportCount||0)+1;banned=count>=50;
      tx.create(reportRef,{sellerUid,reporterUid:u.uid,productId,reason,createdAt:admin.firestore.FieldValue.serverTimestamp()});
      tx.set(sellerRef,{reportCount:count,...(banned?{banned:true,bannedAt:admin.firestore.FieldValue.serverTimestamp()}:{}),updatedAt:admin.firestore.FieldValue.serverTimestamp()},{merge:true});
    });
    if(banned){
      const snap=await db.collection('products').where('sellerUid','==',sellerUid).get(),batch=db.batch();
      snap.docs.forEach(d=>{const p=d.data()||{};if(p.status!=='banned')batch.set(d.ref,{status:'banned',preBanStatus:p.status||'published',updatedAt:admin.firestore.FieldValue.serverTimestamp()},{merge:true})});
      if(!snap.empty)await batch.commit();
    }
    try{await saveDriveReport({id:`${sellerUid}_${u.uid}`,sellerUid,productId,reason,reporterUid:u.uid,count,bannedAtThreshold:banned,createdAt:new Date().toISOString()});}
    catch(e){await reportRef.set({driveSyncError:String(e.message||'Drive sync failed').slice(0,500)},{merge:true});}
    return json(res,200,{ok:true,count,banned});
  }catch(e){json(res,e.status&&e.status<500?e.status:500,{error:e.message||'Report failed.'});}
}
