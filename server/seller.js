import crypto from 'node:crypto';
import admin from 'firebase-admin';
import {getDb,json,method,body,flwRequest,encryptCardField,randomNonce} from './_lib.js';
import {auditProduct} from './audit.js';

const REPORT_REASONS=new Set(['Fake or mismatched live demo','Source code does not match listing','Product is broken or unusable','Misleading product information','Other']);
const CATEGORIES=['Developer Tools','Productivity','Business','Creative','Utilities','Other','AI','Games','Education','Finance','New Upload'];
const PLANS={
  free:{monthly:0,annual:0,maxListings:5,minPrice:10,maxPrice:30,studio:true,visibility:false},
  pro:{monthly:10,annual:99,maxListings:10,minPrice:10,maxPrice:100,studio:true,visibility:true},
  proplus:{monthly:20,annual:120,maxListings:20,minPrice:10,maxPrice:200,studio:true,visibility:true}
};
function clean(v,n=500){return String(v??'').trim().slice(0,n)}
function authHeader(req){const h=String(req.headers.authorization||'');return h.startsWith('Bearer ')?h.slice(7).trim():''}
async function user(req){
  getDb();
  const token=authHeader(req); if(!token) throw Object.assign(new Error('Sign in is required.'),{status:401});
  try{const decoded=await admin.auth().verifyIdToken(token);if(decoded.firebase?.sign_in_provider!=='google.com')throw Object.assign(new Error('Use your Google account to access Developer Studio.'),{status:403});return decoded}catch(e){if(e.status)throw e;throw Object.assign(new Error('Your sign-in session expired. Sign in again.'),{status:401})}
}
function profileDefaults(decoded){
  const now=admin.firestore.Timestamp.now();
  return {uid:decoded.uid,email:clean(decoded.email,320).toLowerCase(),displayName:clean(decoded.name||decoded.email?.split('@')[0]||'Developer',80),tier:'free',studioAccess:true,visibility:false,listingCount:0,periodStart:now,firstPublishedAt:null,trialEndsAt:null,founderSuggested:false,banned:false,reportCount:0,balanceUSD:0,balanceNGN:0,withdrawnUSD:0,withdrawnNGN:0,createdAt:now,updatedAt:now};
}
function toJSON(x){
  if(!x)return x;
  const out={...x};
  for(const k of Object.keys(out)){if(out[k]?.toDate)out[k]=out[k].toDate().toISOString();}
  return out;
}
function planFor(p){
  const tier=['proplus','pro','free'].includes(p?.tier)?p.tier:'free';
  const base=PLANS[tier];
  const now=Date.now();
  const trialOk=tier==='free' && p?.trialEndsAt && new Date(p.trialEndsAt?.toDate?p.trialEndsAt.toDate():p.trialEndsAt).getTime()>now;
  const paidOk=tier!=='free' && p?.accessUntil && new Date(p.accessUntil?.toDate?p.accessUntil.toDate():p.accessUntil).getTime()>now;
  return {...base,tier,active:trialOk||paidOk||tier==='free'&& !p?.firstPublishedAt,trialOk,paidOk};
}
async function getProfile(db,uid,decoded){
  const ref=db.collection('sellers').doc(uid),snap=await ref.get();
  if(snap.exists)return {ref,data:snap.data()||{}};
  const metaRef=db.collection('meta').doc('market');
  const now=admin.firestore.Timestamp.now();
  let d;
  await db.runTransaction(async tx=>{
    const m=await tx.get(metaRef),cur=m.exists?(m.data()||{}):{},count=Number(cur.sellerCount||0);
    d=profileDefaults(decoded);
    d.founderSuggested=count<10;
    d.sellerNumber=count+1;
    tx.set(ref,d);
    tx.set(metaRef,{sellerCount:count+1,updatedAt:now},{merge:true});
  });
  return {ref,data:d};
}
function sellerPublic(p){
  return {uid:p.uid,displayName:p.displayName||'Developer',avatarUrl:p.avatarUrl||'',bio:p.bio||'',website:p.website||'',email:p.publicEmail||'',whatsapp:p.whatsapp||'',banned:Boolean(p.banned)};
}
function normalizeSource(value){
  const raw=clean(value,2000);
  if(!raw)return {sourceUrl:'',sourceDriveId:''};
  const id=raw.match(/(?:drive\.google\.com\/file\/d\/|drive\.google\.com\/open\?id=|[?&]id=)([A-Za-z0-9_-]{10,})/i)?.[1]||(/^[A-Za-z0-9_-]{20,}$/.test(raw)?raw:'');
  if(!id)return {sourceUrl:'',sourceDriveId:''};
  return {sourceUrl:`https://drive.google.com/uc?export=download&id=${encodeURIComponent(id)}`,sourceDriveId:id};
}
function priceOk(v,min,max){const n=Number(v);return Number.isFinite(n)&&n>=min&&n<=max}
function slugify(v){return clean(v,90).toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'').slice(0,80)||crypto.randomUUID().slice(0,8)}
function periodStart(p){
  const x=p?.periodStart?.toDate?p.periodStart.toDate():new Date(p?.periodStart||0);
  return Number.isFinite(x.getTime())?x:new Date(0);
}
async function enforcePlan(db,ref,p){
  let current=p;
  if(current.banned)return planFor(current);
  const now=Date.now();
  if(current.tier!=='free' && current.cancelAt){
    const cancelAt=(current.cancelAt.toDate?current.cancelAt.toDate():new Date(current.cancelAt)).getTime();
    if(cancelAt<=now){
      current={...current,tier:'free',studioAccess:true,visibility:false,accessUntil:null,cancelAt:null,cancelRequestedAt:null};
      await ref.set({tier:'free',studioAccess:true,visibility:false,accessUntil:null,cancelAt:null,cancelRequestedAt:null,updatedAt:admin.firestore.FieldValue.serverTimestamp()},{merge:true});
    }
  }
  if(current.tier!=='free' && current.accessUntil){
    const until=(current.accessUntil.toDate?current.accessUntil.toDate():new Date(current.accessUntil)).getTime();
    if(until<=now){
      current={...current,tier:'free',studioAccess:true,visibility:false,accessUntil:null,cancelAt:null,cancelRequestedAt:null};
      await ref.set({tier:'free',studioAccess:true,visibility:false,accessUntil:null,cancelAt:null,cancelRequestedAt:null,updatedAt:admin.firestore.FieldValue.serverTimestamp()},{merge:true});
    }
  }
  return planFor(current);
}
async function cancelSubscription(db,ref,p,decoded){
  if(!['pro','proplus'].includes(p.tier))return {error:'You do not have an active Pro subscription.',status:400};
  const now=new Date();
  const existing=p.cancelAt?.toDate?p.cancelAt.toDate():(p.cancelAt?new Date(p.cancelAt):null);
  if(existing&&existing.getTime()>now.getTime())return {ok:true,status:'already_scheduled',cancelAt:existing.toISOString()};
  const cancelAt=new Date(now.getTime()+10*24*60*60*1000);
  await ref.set({cancelRequestedAt:admin.firestore.FieldValue.serverTimestamp(),cancelAt:admin.firestore.Timestamp.fromDate(cancelAt),updatedAt:admin.firestore.FieldValue.serverTimestamp()},{merge:true});
  return {ok:true,status:'scheduled',cancelAt:cancelAt.toISOString(),graceDays:10};
}
async function restoreSubscription(db,ref,p){
  if(!['pro','proplus'].includes(p.tier))return {error:'Your Pro access has already ended. Subscribe again to restore Pro.',status:400};
  const cancelAt=p.cancelAt?.toDate?p.cancelAt.toDate():(p.cancelAt?new Date(p.cancelAt):null);
  if(!cancelAt||cancelAt.getTime()<=Date.now())return {error:'The 10-day restoration period has ended. Subscribe again to Pro.',status:409};
  await ref.set({cancelAt:null,cancelRequestedAt:null,updatedAt:admin.firestore.FieldValue.serverTimestamp()},{merge:true});
  return {ok:true,status:'restored',tier:p.tier,accessUntil:p.accessUntil?.toDate?p.accessUntil.toDate().toISOString():(p.accessUntil||null)};
}
function listingLimit(plan){return plan.maxListings}
function suggestedWindow(p){return Boolean(p.founderSuggested)}
async function ensureNotBanned(p){if(p.banned)throw Object.assign(new Error('This seller account is permanently banned from publishing.'),{status:403})}
async function createPlanCharge(req,res,decoded,b){
  const db=getDb(),{ref,data:p}=await getProfile(db,decoded.uid,decoded);
  await ensureNotBanned(p);
  const tier=clean(b.plan,20),cycle=clean(b.cycle,10);
  if(!['pro','proplus'].includes(tier)||!['monthly','annual'].includes(cycle))return json(res,400,{error:'Choose a valid Pro or Pro+ plan.'});
  const amount=cycle==='annual'?PLANS[tier].annual:PLANS[tier].monthly;
  const card=b.payment_method?.card||{};
  const number=String(card.number||'').replace(/\D/g,''),cvv=String(card.cvv||'').replace(/\D/g,''),month=String(card.expiry_month||'').replace(/\D/g,''),yearRaw=String(card.expiry_year||'').replace(/\D/g,'');
  const year=yearRaw.length===2?`20${yearRaw}`:yearRaw;
  if(!/^\d{12,19}$/.test(number)||!/^\d{3,4}$/.test(cvv)||!/^(0[1-9]|1[0-2])$/.test(month)||!/^\d{4}$/.test(year))return json(res,400,{error:'Enter valid card details.'});
  const encryptionKey=process.env.FLW_ENCRYPTION_KEY;if(!encryptionKey)throw new Error('Missing FLW_ENCRYPTION_KEY');
  const orderId=crypto.randomUUID(),reference=`WYP${orderId.replaceAll('-','').slice(0,30)}`,nonce=randomNonce();
  const appUrl=String(process.env.APP_URL||'').trim().replace(/\/$/,'');if(!/^https:\/\/[^\s]+$/i.test(appUrl))return json(res,500,{error:'APP_URL must be a valid HTTPS URL.'});
  const email=clean(decoded.email||p.email,320).toLowerCase(),name=clean(decoded.name||p.displayName||'Developer',120),parts=name.split(/\s+/);
  await db.collection('sellerPlanOrders').doc(orderId).set({uid:decoded.uid,email,name,tier,cycle,amount,currency:'USD',reference,status:'pending',createdAt:admin.firestore.FieldValue.serverTimestamp()});
  const fw=await flwRequest('/orchestration/direct-charges',{
    method:'POST',
    headers:{'X-Idempotency-Key':orderId.replaceAll('-','')},
    body:JSON.stringify({
      amount,currency:'USD',reference,redirect_url:`${appUrl}/?sellerPayment=${encodeURIComponent(orderId)}`,
      customer:{email,name:{first:parts[0]||name,last:parts.slice(1).join(' ')||''}},
      payment_method:{type:'card',card:{
        encrypted_card_number:encryptCardField(number,encryptionKey,nonce),
        encrypted_expiry_month:encryptCardField(month,encryptionKey,nonce),
        encrypted_expiry_year:encryptCardField(year,encryptionKey,nonce),
        encrypted_cvv:encryptCardField(cvv,encryptionKey,nonce),nonce
      }},
      meta:{seller_uid:decoded.uid,plan:tier,cycle}
    })
  });
  await db.collection('sellerPlanOrders').doc(orderId).set({flutterwaveChargeId:fw.data?.id||'',flutterwaveStatus:fw.data?.status||'pending',nextAction:fw.data?.next_action||null,updatedAt:admin.firestore.FieldValue.serverTimestamp()},{merge:true});
  return json(res,200,{orderId,reference,status:fw.data?.status||'pending',nextAction:fw.data?.next_action||null});
}
async function notifyNewProduct(productId,name,category){
  try{
    const snap=await getDb().collection('notificationSubscribers').limit(500).get();
    const tokens=snap.docs.map(d=>String(d.data()?.token||'')).filter(Boolean);
    if(!tokens.length||!admin.messaging)return;
    const msg={tokens,data:{title:'New drop on WyCode Market 🚀',body:`${name} just landed in ${category}. Check it out before it gets buried.`,url:`/?product=${encodeURIComponent(productId)}`,tag:`wycode-product-${productId}`}};
    const r=await admin.messaging().sendEachForMulticast(msg);
    const batch=getDb().batch();let removed=0;r.responses.forEach((x,i)=>{if(!x.success&&/registration-token-not-registered|invalid-registration-token/i.test(String(x.error?.code||''))){batch.delete(getDb().collection('notificationSubscribers').doc(crypto.createHash('sha256').update(tokens[i]).digest('hex')));removed++}});if(removed)await batch.commit();
  }catch{}
}
async function publish(db,ref,p,b,decoded){
  const plan=await enforcePlan(db,ref,p);
  if(!plan.active)return {error:'Your free publishing month has ended. Choose Pro or Pro+ to publish more apps.',status:402};
  const name=clean(b.name,120),description=clean(b.description,1000),category=clean(b.category,60);
  if(!name||!description||!CATEGORIES.includes(category))return {error:'Name, description and a valid category are required.',status:400};
  const source=normalizeSource(b.sourceUrl||b.sourceDriveId);
  if(!source.sourceUrl)return {error:'Paste the source-code Drive URL or file ID. Your file stays in your Drive.',status:400};
  const demoUrl=clean(b.demoUrl,2000);
  const coverUrl=clean(b.coverUrl,2000);
  const min=plan.minPrice,max=plan.maxPrice;
  const usd=Number(b.priceUSD),ngn=Math.round(usd*1200);
  if(!priceOk(usd,min,max))return {error:`Your ${plan.tier==='free'?'free':'current'} plan requires a USD product price from $${min} to $${max}.`,status:400};
  const now=admin.firestore.Timestamp.now();
  const productId=crypto.randomUUID();
  let firstPublish=!p.firstPublishedAt;
  await db.runTransaction(async tx=>{
    const snap=await tx.get(ref),cur=snap.data()||p,activePlan=planFor(cur);
    if(cur.banned)throw Object.assign(new Error('This seller account is permanently banned.'),{status:403});
    const start=periodStart(cur),monthMs=30*24*60*60*1000;
    let count=Number(cur.listingCount||0);
    if(Date.now()-start.getTime()>=monthMs){count=0;tx.update(ref,{listingCount:0,periodStart:now});}
    if(count>=listingLimit(activePlan))throw Object.assign(new Error(`Your ${activePlan.tier} plan has reached its ${activePlan.maxListings}-listing monthly limit.`),{status:409});
    const update={listingCount:count+1,updatedAt:now};
    if(!cur.firstPublishedAt){firstPublish=true;update.firstPublishedAt=now;update.trialEndsAt=new Date(Date.now()+30*24*60*60*1000)}
    tx.set(ref,update,{merge:true});
    tx.create(db.collection('products').doc(productId),{
      sellerUid:decoded.uid,sellerName:cur.displayName||decoded.email||'Developer',name,slug:`${slugify(name)}-${productId.slice(0,6)}`,description,category,
      version:clean(b.version,30),features:clean(b.features,3000),requirements:clean(b.requirements,2000),license:clean(b.license,160)||'Single-project source license',
      priceUSD:usd,priceNGN:ngn,price:usd,currency:'USD',
      sourceUrl:source.sourceUrl,sourceDriveId:source.sourceDriveId,demoUrl,coverUrl,screenshots:Array.isArray(b.screenshots)?b.screenshots.slice(0,6).map(x=>clean(x,2000)) : [],
      contactEmail:clean(b.contactEmail,320),contactWhatsApp:clean(b.contactWhatsApp,40),status:'published',sales:0,ratingAverage:0,ratingCount:0,sellerRatingAverage:Number(cur.ratingAverage||0),sellerRatingCount:Number(cur.ratingCount||0),
      founderSuggested:Boolean(cur.founderSuggested),visibility:Boolean(activePlan.visibility||cur.founderSuggested),createdAt:now,updatedAt:now
    });
  });
  await auditProduct(productId).catch(()=>null);
  await notifyNewProduct(productId,name,category);
  return {ok:true,productId,trialStarted:firstPublish,founderSuggested:Boolean(p.founderSuggested)};
}
async function report(db,decoded,b){
  const sellerUid=clean(b.sellerUid,200),reason=clean(b.reason,120);
  if(!sellerUid||!reason)return {error:'Seller and report reason are required.',status:400};
  if(!REPORT_REASONS.has(reason))return {error:'Choose a valid report reason.',status:400};
  if(sellerUid===decoded.uid)return {error:'You cannot report your own seller account.',status:400};
  const sellerRef=db.collection('sellers').doc(sellerUid),reportRef=db.collection('sellerReports').doc(`${sellerUid}_${decoded.uid}`);
  let count=0,banned=false;
  await db.runTransaction(async tx=>{
    const [sellerSnap,existing]=await Promise.all([tx.get(sellerRef),tx.get(reportRef)]);
    if(!sellerSnap.exists)throw Object.assign(new Error('Seller account not found.'),{status:404});
    if(existing.exists)throw Object.assign(new Error('You have already reported this account.'),{status:409});
    const seller=sellerSnap.data()||{};
    count=Number(seller.reportCount||0)+1;banned=count>=50;
    tx.create(reportRef,{sellerUid,reporterUid:decoded.uid,reason,createdAt:admin.firestore.FieldValue.serverTimestamp()});
    tx.set(sellerRef,{reportCount:count,...(banned?{banned:true,bannedAt:admin.firestore.FieldValue.serverTimestamp()}:{}),updatedAt:admin.firestore.FieldValue.serverTimestamp()},{merge:true});
  });
  if(banned){
    const snap=await db.collection('products').where('sellerUid','==',sellerUid).get();
    const batch=db.batch();snap.docs.forEach(d=>{const x=d.data()||{};if(x.status!=='banned')batch.set(d.ref,{status:'banned',preBanStatus:x.status||'published',updatedAt:admin.firestore.FieldValue.serverTimestamp()},{merge:true})});if(!snap.empty)await batch.commit();
  }
  return {ok:true,count,banned};
}
async function submitAppeal(db,decoded,b){
  const ref=db.collection('sellers').doc(decoded.uid),snap=await ref.get();
  if(!snap.exists)return {error:'Seller account not found.',status:404};
  const p=snap.data()||{};if(!p.banned)return {error:'Your account is not banned.',status:400};
  const existing=await db.collection('sellerAppeals').where('uid','==',decoded.uid).limit(1).get();
  if(!existing.empty)return {error:'Your appeal has already been submitted and cannot be resubmitted.',status:409};
  const accountName=clean(b.accountName||p.displayName||decoded.email?.split('@')[0]||'Developer',120);
  const category=clean(b.category,80),description=clean(b.description,3000);
  if(!category||description.length<20)return {error:'Category and an appeal description of at least 20 characters are required.',status:400};
  const appealRef=db.collection('sellerAppeals').doc();
  await appealRef.set({uid:decoded.uid,accountName,category,description,status:'pending',email:clean(decoded.email||p.email,320).toLowerCase(),createdAt:admin.firestore.FieldValue.serverTimestamp(),updatedAt:admin.firestore.FieldValue.serverTimestamp()});
  return {ok:true,appealId:appealRef.id,status:'pending'};
}

async function getBanks(){
  const r=await flwRequest('/banks?country=NG',{method:'GET'});
  return Array.isArray(r.data)?r.data.map(x=>({code:String(x.code||''),name:String(x.name||'')})).filter(x=>x.code&&x.name):[];
}
async function resolveBank(bankName,accountNumber,currency){
  const name=clean(bankName,120),number=clean(accountNumber,40);
  if(!name||!number)throw Object.assign(new Error('Select your bank and enter your account number.'),{status:400});
  const banks=await getBanks(),bank=banks.find(x=>x.name.toLowerCase()===name.toLowerCase())||banks.find(x=>x.name.toLowerCase().includes(name.toLowerCase()));
  if(!bank)throw Object.assign(new Error('That bank could not be found in Flutterwave. Refresh the bank list and try again.'),{status:400});
  const r=await flwRequest('/banks/account-resolve',{method:'POST',body:JSON.stringify({account:{code:bank.code,number},currency:String(currency).toUpperCase()})});
  const data=r.data||{};
  return {bankName:bank.name,bankCode:bank.code,accountNumber:number,accountName:clean(data.account_name,120)};
}
async function withdraw(db,ref,p,b,decoded){
  const currency=String(b.currency||'').toUpperCase();
  if(!['USD','NGN'].includes(currency))return {error:'Choose USD or NGN.',status:400};
  const balanceField=currency==='NGN'?'balanceNGN':'balanceUSD',available=Number(p[balanceField]||0),threshold=currency==='NGN'?60000:50;
  if(available<threshold)return {error:`Your ${currency} balance must reach ${currency==='USD'?'$50':'₦60,000'} before withdrawal.`,status:400};
  const bank=p[currency==='USD'?'payoutBankUSD':'payoutBankNGN'];
  if(!bank?.bankCode||!bank?.accountNumber||!bank?.accountName)return {error:`Save a valid ${currency} payout account first.`,status:400};
  if(p.banned)return {error:'Your seller account is permanently banned. Withdrawals are locked while the ban is active. Use the appeal button in Studio.',status:403};
  const amount=available,transferRef=`WYW${crypto.randomUUID().replaceAll('-','').slice(0,28)}`;
  await db.runTransaction(async tx=>{
    const snap=await tx.get(ref),cur=snap.data()||{},bal=Number(cur[balanceField]||0);
    if(cur.banned)throw Object.assign(new Error('Your seller account is permanently banned. Withdrawals are locked while the ban is active.'),{status:403});
    if(bal<threshold)throw Object.assign(new Error(`Your ${currency} balance is below the withdrawal threshold.`),{status:409});
    tx.update(ref,{[balanceField]:0,[currency==='NGN'?'withdrawnNGN':'withdrawnUSD']:admin.firestore.FieldValue.increment(bal),updatedAt:admin.firestore.FieldValue.serverTimestamp()});
    tx.create(db.collection('payouts').doc(transferRef),{uid:decoded.uid,amount:bal,currency,bankCode:bank.bankCode,bankName:bank.bankName,accountNumberMasked:`****${String(bank.accountNumber).slice(-4)}`,accountName:bank.accountName,status:'pending',reference:transferRef,createdAt:admin.firestore.FieldValue.serverTimestamp()});
  });
  try{
    const r=await flwRequest('/direct-transfers',{method:'POST',headers:{'X-Idempotency-Key':transferRef,'X-Trace-Id':crypto.randomUUID()},body:JSON.stringify({action:'instant',type:'bank',reference:transferRef,narration:`WyCode ${currency} seller payout`,payment_instruction:{amount:{value:amount,applies_to:'destination_currency'},source_currency:currency,destination_currency:currency,recipient:{bank:{code:String(bank.bankCode),account_number:String(bank.accountNumber)},currency,name:{first:String(bank.accountName).split(' ')[0]||'Seller',last:String(bank.accountName).split(' ').slice(1).join(' ')||''}}}})});
    await db.collection('payouts').doc(transferRef).set({status:r.data?.status||'submitted',providerId:r.data?.id||'',provider:r.data||{},updatedAt:admin.firestore.FieldValue.serverTimestamp()},{merge:true});
    return {ok:true,status:r.data?.status||'submitted',reference:transferRef};
  }catch(e){
    await db.runTransaction(async tx=>{const s=await tx.get(ref);if(s.exists)tx.update(ref,{[balanceField]:admin.firestore.FieldValue.increment(amount),[currency==='NGN'?'withdrawnNGN':'withdrawnUSD']:admin.firestore.FieldValue.increment(-amount),updatedAt:admin.firestore.FieldValue.serverTimestamp()});});
    await db.collection('payouts').doc(transferRef).set({status:'failed',error:e.message||'Transfer failed',updatedAt:admin.firestore.FieldValue.serverTimestamp()},{merge:true});
    throw e;
  }
}
export default async function handler(req,res){
  if(!method(req,res,['GET','POST']))return;
  try{
    const decoded=await user(req),db=getDb(),{ref,data}=await getProfile(db,decoded.uid,decoded);
    let p=data;
    if(req.method==='GET'){
      const action=clean(req.query?.action||'dashboard',40),plan=await enforcePlan(db,ref,p);
      if(plan.tier==='free' && p.tier!=='free'){p=(await ref.get()).data()||p;}
      if(action==='dashboard'){
        const products=(await db.collection('products').where('sellerUid','==',decoded.uid).limit(100).get()).docs.map(d=>({id:d.id,...d.data()}));
        const sales=(await db.collection('orders').where('sellerUid','==',decoded.uid).limit(500).get()).docs.map(d=>d.data()).filter(x=>x.status==='paid');
        const payouts=(await db.collection('payouts').where('uid','==',decoded.uid).limit(50).get()).docs.map(d=>d.data());
        const appealSnap=await db.collection('sellerAppeals').where('uid','==',decoded.uid).limit(1).get();
        const appeal=appealSnap.empty?null:toJSON({id:appealSnap.docs[0].id,...appealSnap.docs[0].data()});
        const banks=await getBanks().catch(()=>[]);
        return json(res,200,{profile:toJSON({...p,uid:decoded.uid}),plan,products:products.map(toJSON),sales:sales.map(toJSON),payouts:payouts.map(toJSON),appeal,banks});
      }
      if(action==='profile')return json(res,200,{profile:toJSON({...p,uid:decoded.uid}),plan});
      return json(res,400,{error:'Unknown dashboard action.'});
    }
    const b=await body(req),action=clean(b.action,40);
    if(action==='save-profile'){
      const patch={displayName:clean(b.displayName,80),bio:clean(b.bio,600),website:clean(b.website,500),publicEmail:clean(b.publicEmail,320),whatsapp:clean(b.whatsapp,40),updatedAt:admin.firestore.FieldValue.serverTimestamp()};
      await ref.set(patch,{merge:true});return json(res,200,{ok:true,profile:toJSON({...p,...patch,uid:decoded.uid})});
    }
    if(action==='publish'){const r=await publish(db,ref,p,b,decoded);if(r.error)return json(res,r.status,{error:r.error});return json(res,200,r);}
    if(action==='set-status'){
      const id=clean(b.productId,100),status=clean(b.status,30);
      if(!id||!['published','hidden'].includes(status))return json(res,400,{error:'Invalid listing status.'});
      const productRef=db.collection('products').doc(id),snap=await productRef.get();
      if(!snap.exists||snap.data()?.sellerUid!==decoded.uid)return json(res,404,{error:'Listing not found.'});
      if(p.banned)return json(res,403,{error:'Your seller account is banned and publishing changes are locked.'});
      await productRef.set({status,updatedAt:admin.firestore.FieldValue.serverTimestamp()},{merge:true});
      return json(res,200,{ok:true,status});
    }
    if(action==='report')return json(res,403,{error:'Seller accounts cannot submit marketplace reports. Only verified buyers can report a seller.'});
    if(action==='submit-appeal'){const r=await submitAppeal(db,decoded,b);if(r.error)return json(res,r.status,{error:r.error});return json(res,200,r);}
    if(action==='cancel-subscription'){const r=await cancelSubscription(db,ref,p,decoded);if(r.error)return json(res,r.status,{error:r.error});return json(res,200,r);}
    if(action==='restore-subscription'){const r=await restoreSubscription(db,ref,p);if(r.error)return json(res,r.status,{error:r.error});return json(res,200,r);}
    if(action==='withdraw'){const r=await withdraw(db,ref,p,b,decoded);return json(res,200,r);}
    if(action==='start-plan')return createPlanCharge(req,res,decoded,b);
    if(action==='verify-plan'){
      const orderId=clean(b.orderId,100),orderRef=db.collection('sellerPlanOrders').doc(orderId),snap=await orderRef.get();
      if(!snap.exists||snap.data()?.uid!==decoded.uid)return json(res,404,{error:'Plan payment not found.'});
      const o=snap.data();let charge={};
      if(o.flutterwaveChargeId){const fw=await flwRequest(`/charges/${encodeURIComponent(o.flutterwaveChargeId)}`,{method:'GET'});charge=fw.data||{};}
      const valid=(charge.status==='succeeded'||charge.status==='successful')&&Number(charge.amount)===Number(o.amount)&&String(charge.currency||'').toUpperCase()==='USD';
      if(!valid)return json(res,200,{status:charge.status||'pending',nextAction:charge.next_action||null});
      const days=o.cycle==='annual'?365:30,until=new Date(Date.now()+days*24*60*60*1000);
      await ref.set({tier:o.tier,accessUntil:until,studioAccess:true,visibility:true,planPaidAt:admin.firestore.FieldValue.serverTimestamp(),updatedAt:admin.firestore.FieldValue.serverTimestamp()},{merge:true});
      await orderRef.set({status:'paid',paidAt:admin.firestore.FieldValue.serverTimestamp(),verifiedAmount:Number(charge.amount),verifiedCurrency:charge.currency,updatedAt:admin.firestore.FieldValue.serverTimestamp()},{merge:true});
      return json(res,200,{status:'paid',tier:o.tier,accessUntil:until.toISOString()});
    }
    if(action==='save-bank'){const currency=String(b.currency||'').toUpperCase();if(!['USD','NGN'].includes(currency))return json(res,400,{error:'Choose USD or NGN payout currency.'});const account=await resolveBank(b.bankName,b.accountNumber,currency);if(!account.accountName)return json(res,400,{error:'Flutterwave could not verify the account name. Check the bank and account number.'});const field=currency==='USD'?'payoutBankUSD':'payoutBankNGN';await ref.set({[field]:account,updatedAt:admin.firestore.FieldValue.serverTimestamp()},{merge:true});return json(res,200,{ok:true,currency,account:{bankName:account.bankName,accountNumber:account.accountNumberMasked||`****${account.accountNumber.slice(-4)}`,accountName:account.accountName}});}
    return json(res,400,{error:'Unknown seller action.'});
  }catch(e){json(res,e.status&&e.status<500?e.status:500,{error:e.message||'Seller request failed.'});}
}
