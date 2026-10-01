import crypto from 'node:crypto';
import {Readable} from 'node:stream';
import admin from 'firebase-admin';
import {getDb,getDrive,json,method,rawBody,flwRequest,encryptCardField,randomNonce} from './_lib.js';
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
  return {uid:decoded.uid,email:clean(decoded.email,320).toLowerCase(),displayName:clean(decoded.name||decoded.email?.split('@')[0]||'Developer',80),tier:'free',studioAccess:true,visibility:false,listingCount:0,periodStart:now,firstPublishedAt:null,trialEndsAt:null,founderSuggested:false,banned:false,reportCount:0,balanceUSD:0,balanceNGN:0,avatarUrl:'',avatarDriveId:'',withdrawnUSD:0,withdrawnNGN:0,createdAt:now,updatedAt:now};
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
  if(p.tier===tier && p.accessUntil && (p.accessUntil.toDate?p.accessUntil.toDate():new Date(p.accessUntil)).getTime()>Date.now())return json(res,409,{error:`You already have an active ${tier==='proplus'?'Pro+':'Pro'} plan.`});
  if(p.tier==='proplus' && p.accessUntil && (p.accessUntil.toDate?p.accessUntil.toDate():new Date(p.accessUntil)).getTime()>Date.now())return json(res,409,{error:'You already have an active Pro+ plan.'});
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

async function getBanks(country='NG'){
  const code=String(country||'NG').toUpperCase();
  const r=await flwRequest(`/banks?country=${encodeURIComponent(code)}`,{method:'GET'});
  return Array.isArray(r.data)?r.data.map(x=>({code:String(x.code||''),name:String(x.name||'')})).filter(x=>x.code&&x.name).sort((a,b)=>a.name.localeCompare(b.name)):[];
}
async function resolveBank(bankName,accountNumber,currency,country='NG',extra={}){
  const name=clean(bankName,120),number=clean(accountNumber,40),cur=String(currency||'').toUpperCase();
  if(!['USD','NGN'].includes(cur))throw Object.assign(new Error('Choose USD or NGN.'),{status:400});
  if(!name||!number)throw Object.assign(new Error('Select your bank and enter your account number.'),{status:400});
  const destCountry=String(country||'NG').toUpperCase();
  const banks=await getBanks(destCountry),bank=banks.find(x=>x.name.toLowerCase()===name.toLowerCase())||banks.find(x=>x.name.toLowerCase().includes(name.toLowerCase()));
  if(!bank)throw Object.assign(new Error('That bank is not currently available for WyCode payouts. Refresh the bank list and try again.'),{status:400});
  const payload={account:{code:bank.code,number},currency:cur,country:destCountry};
  if(extra.routingNumber)payload.account.routing_number=clean(extra.routingNumber,80);
  if(extra.swiftCode)payload.account.swift_code=clean(extra.swiftCode,80);
  if(extra.accountType)payload.account.type=clean(extra.accountType,40);
  const r=await flwRequest('/banks/account-resolve',{method:'POST',body:JSON.stringify(payload)});
  const data=r.data||{};
  if(!data.account_name)throw Object.assign(new Error('Flutterwave could not verify this account. Check the bank and account number.'),{status:400});
  return {id:crypto.createHash('sha256').update(`${cur}:${destCountry}:${bank.code}:${number}`).digest('hex').slice(0,24),bankName:bank.name,bankCode:bank.code,accountNumber:number,accountName:clean(data.account_name,120),currency:cur,country:destCountry,routingNumber:clean(extra.routingNumber,80),swiftCode:clean(extra.swiftCode,80),accountType:clean(extra.accountType,40)};
}
function payoutAccounts(p,currency){
  const cur=String(currency).toUpperCase(),field=cur==='USD'?'payoutBanksUSD':'payoutBanksNGN',legacy=cur==='USD'?p.payoutBankUSD:p.payoutBankNGN;
  let list=Array.isArray(p[field])?p[field].map(x=>({...x,currency:cur})):[];
  if(!list.length&&legacy?.bankCode&&legacy?.accountNumber)list=[{...legacy,currency:cur,id:crypto.createHash('sha256').update(`${cur}:${legacy.bankCode}:${legacy.accountNumber}`).digest('hex').slice(0,24)}];
  return list;
}
async function withdraw(db,ref,p,b,decoded){
  const currency=String(b.currency||'').toUpperCase();
  if(!['USD','NGN'].includes(currency))return {error:'Choose USD or NGN.',status:400};
  const balanceField=currency==='NGN'?'balanceNGN':'balanceUSD',available=Number(p[balanceField]||0),threshold=currency==='NGN'?60000:50;
  if(available<threshold)return {error:`Your ${currency} balance must reach ${currency==='USD'?'$50':'₦60,000'} before withdrawal.`,status:400};
  const accounts=payoutAccounts(p,currency),requestedId=clean(b.bankId,80);
  if(!requestedId)return {error:`Select the ${currency} bank account you want to withdraw to.`,status:400};
  const bank=accounts.find(x=>x.id===requestedId);
  if(!bank?.bankCode||!bank?.accountNumber||!bank?.accountName)return {error:`Save a valid ${currency} payout account first.`,status:400};
  if(p.banned)return {error:'Your seller account is permanently banned. Withdrawals are locked while the ban is active. Use the appeal button in Studio.',status:403};
  const amount=available,transferRef=`WYW${crypto.randomUUID().replaceAll('-','').slice(0,28)}`;
  await db.runTransaction(async tx=>{
    const snap=await tx.get(ref),cur=snap.data()||{},bal=Number(cur[balanceField]||0);
    if(cur.banned)throw Object.assign(new Error('Your seller account is permanently banned. Withdrawals are locked while the ban is active.'),{status:403});
    if(bal<threshold)throw Object.assign(new Error(`Your ${currency} balance is below the withdrawal threshold.`),{status:409});
    tx.update(ref,{[balanceField]:0,[currency==='NGN'?'withdrawnNGN':'withdrawnUSD']:admin.firestore.FieldValue.increment(bal),updatedAt:admin.firestore.FieldValue.serverTimestamp()});
    tx.create(db.collection('payouts').doc(transferRef),{uid:decoded.uid,amount:bal,currency,bankCode:bank.bankCode,bankName:bank.bankName,accountNumberMasked:`****${String(bank.accountNumber).slice(-4)}`,accountName:bank.accountName,country:bank.country|| (currency==='NGN'?'NG':''),routingNumber:bank.routingNumber||'',swiftCode:bank.swiftCode||'',accountType:bank.accountType||'',status:'pending',reference:transferRef,createdAt:admin.firestore.FieldValue.serverTimestamp()});
  });
  try{
    const r=await flwRequest('/direct-transfers',{method:'POST',headers:{'X-Idempotency-Key':transferRef,'X-Trace-Id':crypto.randomUUID()},body:JSON.stringify({action:'instant',type:'bank',reference:transferRef,narration:`WyCode ${currency} seller payout`,payment_instruction:{amount:{value:amount,applies_to:'destination_currency'},source_currency:currency,destination_currency:currency,recipient:{bank:{code:String(bank.bankCode),account_number:String(bank.accountNumber),country:String(bank.country||'NG'),routing_number:String(bank.routingNumber||''),swift_code:String(bank.swiftCode||''),type:String(bank.accountType||'')},currency,name:{first:String(bank.accountName).split(' ')[0]||'Seller',last:String(bank.accountName).split(' ').slice(1).join(' ')||''}}}})});
    await db.collection('payouts').doc(transferRef).set({status:r.data?.status||'submitted',providerId:r.data?.id||'',provider:r.data||{},updatedAt:admin.firestore.FieldValue.serverTimestamp()},{merge:true});
    return {ok:true,status:r.data?.status||'submitted',reference:transferRef};
  }catch(e){
    const definitive=Number(e?.status||0)>=400&&Number(e?.status||0)<500&&![401,408,409,429].includes(Number(e?.status||0));
    if(definitive){
      await db.runTransaction(async tx=>{const s=await tx.get(ref);if(s.exists)tx.update(ref,{[balanceField]:admin.firestore.FieldValue.increment(amount),[currency==='NGN'?'withdrawnNGN':'withdrawnUSD']:admin.firestore.FieldValue.increment(-amount),updatedAt:admin.firestore.FieldValue.serverTimestamp()});});
      await db.collection('payouts').doc(transferRef).set({status:'failed',error:e.message||'Transfer failed',refunded:true,updatedAt:admin.firestore.FieldValue.serverTimestamp()},{merge:true});
    }else{
      await db.collection('payouts').doc(transferRef).set({status:'pending',error:e.message||'Transfer status is being confirmed by Flutterwave. Do not submit another withdrawal yet.',needsRequery:true,updatedAt:admin.firestore.FieldValue.serverTimestamp()},{merge:true});
    }
    throw e;
  }
}

async function findProfileDriveFolder(db,uid){
  const configured=String(process.env.GOOGLE_DRIVE_PROFILE_FOLDER_ID||process.env.GOOGLE_DRIVE_FOLDER_ID||'').trim();
  if(configured)return configured;
  const products=await db.collection('products').where('sellerUid','==',uid).limit(10).get();
  for(const doc of products.docs){
    const id=clean(doc.data()?.sourceDriveId,200);if(!id)continue;
    try{const f=await getDrive().files.get({fileId:id,fields:'id,parents'});if(f.data?.parents?.[0])return f.data.parents[0];}catch{}
  }
  return '';
}
async function uploadProfilePicture(db,uid,dataUrl){
  const raw=String(dataUrl||'').trim();
  const m=raw.match(/^data:(image\/(?:png|jpe?g|webp));base64,([A-Za-z0-9+/=]+)$/i);
  if(!m)throw Object.assign(new Error('Choose a PNG, JPG or WebP profile picture.'),{status:400});
  const mime=m[1].toLowerCase().replace('jpg','jpeg');
  const bytes=Buffer.from(m[2],'base64');
  if(!bytes.length||bytes.length>3*1024*1024)throw Object.assign(new Error('Profile picture must be 3 MB or smaller.'),{status:400});
  const folder=await findProfileDriveFolder(db,uid);
  if(!folder)throw Object.assign(new Error('No Google Drive media folder is configured. Add GOOGLE_DRIVE_PROFILE_FOLDER_ID or GOOGLE_DRIVE_FOLDER_ID in Vercel, or publish one source ZIP first.'),{status:503});
  const ext=mime==='image/png'?'png':mime==='image/webp'?'webp':'jpg';
  const drive=getDrive();
  const created=await drive.files.create({requestBody:{name:`wycode-profile-${uid}-${crypto.randomUUID().slice(0,8)}.${ext}`,mimeType:mime,parents:[folder]},media:{mimeType:mime,body:Readable.from(bytes)},fields:'id,webViewLink,webContentLink'});
  const id=String(created.data?.id||'');if(!id)throw new Error('Google Drive did not return the profile picture ID.');
  try{await drive.permissions.create({fileId:id,requestBody:{type:'anyone',role:'reader'}})}catch(e){try{await drive.files.delete({fileId:id})}catch{};throw Object.assign(new Error('Google Drive could not make the profile picture public. Check the configured Drive folder permissions.'),{status:503});}
  return {avatarDriveId:id,avatarUrl:`https://drive.google.com/thumbnail?id=${encodeURIComponent(id)}&sz=w600`};
}
export default async function handler(req,res){
  if(!method(req,res,['GET','POST']))return;
  try{
    const decoded=await user(req),db=getDb(),{ref,data}=await getProfile(db,decoded.uid,decoded);
    let p=data;
    if(req.method==='GET'){
      const action=clean(req.query?.action||'dashboard',40),plan=await enforcePlan(db,ref,p);
      if(plan.tier==='free' && p.tier!=='free'){p=(await ref.get()).data()||p;}
      if(action==='banks'){
        const country=clean(req.query?.country||'NG',2).toUpperCase();
        if(!/^[A-Z]{2}$/.test(country))return json(res,400,{error:'Use a valid two-letter destination country code.'});
        const banks=await getBanks(country);
        return json(res,200,{country,banks});
      }
      if(action==='dashboard'){
        const products=(await db.collection('products').where('sellerUid','==',decoded.uid).limit(100).get()).docs.map(d=>({id:d.id,...d.data()}));
        const sales=(await db.collection('orders').where('sellerUid','==',decoded.uid).limit(500).get()).docs.map(d=>d.data()).filter(x=>x.status==='paid');
        const payouts=(await db.collection('payouts').where('uid','==',decoded.uid).limit(50).get()).docs.map(d=>d.data());
        const appealSnap=await db.collection('sellerAppeals').where('uid','==',decoded.uid).limit(1).get();
        const appeal=appealSnap.empty?null:toJSON({id:appealSnap.docs[0].id,...appealSnap.docs[0].data()});
        const banksNG=await getBanks('NG').catch(()=>[]);
        const banksByCurrency={NGN:banksNG,USD:[]};
        const safeBanks=cur=>payoutAccounts(p,cur).map(x=>({...x,accountNumber:`****${String(x.accountNumber||'').slice(-4)}`}));
        const normalizedProfile={...p,uid:decoded.uid,payoutBanksNGN:safeBanks('NGN'),payoutBanksUSD:safeBanks('USD'),payoutBankNGN:p.payoutBankNGN?{...p.payoutBankNGN,accountNumber:`****${String(p.payoutBankNGN.accountNumber||'').slice(-4)}`}:null,payoutBankUSD:p.payoutBankUSD?{...p.payoutBankUSD,accountNumber:`****${String(p.payoutBankUSD.accountNumber||'').slice(-4)}`}:null};
        return json(res,200,{profile:toJSON(normalizedProfile),plan,products:products.map(toJSON),sales:sales.map(toJSON),payouts:payouts.map(toJSON),appeal,banks:banksNG,banksByCurrency});
      }
      if(action==='profile')return json(res,200,{profile:toJSON({...p,uid:decoded.uid}),plan});
      return json(res,400,{error:'Unknown dashboard action.'});
    }
    let b={};
    if(req.body && typeof req.body==='object') b=req.body;
    else { const raw=await rawBody(req); try { b=JSON.parse(raw||'{}'); } catch { throw Object.assign(new Error('Invalid JSON body.'),{status:400}); } }
    const action=clean(b.action,40);
    if(action==='save-profile'){
      const patch={displayName:clean(b.displayName,80),bio:clean(b.bio,600),website:clean(b.website,500),publicEmail:clean(b.publicEmail,320),whatsapp:clean(b.whatsapp,40),updatedAt:admin.firestore.FieldValue.serverTimestamp()};
      if(b.avatarDataUrl){
        const avatar=await uploadProfilePicture(db,decoded.uid,b.avatarDataUrl);
        patch.avatarUrl=avatar.avatarUrl;patch.avatarDriveId=avatar.avatarDriveId;
        if(p.avatarDriveId&&String(p.avatarDriveId)!==String(avatar.avatarDriveId)){try{await getDrive().files.delete({fileId:String(p.avatarDriveId)})}catch{}}
      }
      await ref.set(patch,{merge:true});return json(res,200,{ok:true,avatarUrl:patch.avatarUrl||p.avatarUrl||'',profile:toJSON({...p,...patch,uid:decoded.uid})});
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
    if(action==='payout-status'){
      const payoutId=clean(b.payoutId||b.reference,100),payoutRef=db.collection('payouts').doc(payoutId),ps=await payoutRef.get();
      if(!ps.exists||String(ps.data()?.uid)!==String(decoded.uid))return json(res,404,{error:'Payout not found.'});
      const payout=ps.data()||{};
      if(!payout.providerId)return json(res,200,{status:payout.status||'pending',reference:payout.reference||payoutId});
      const transfer=(await flwRequest(`/transfers/${encodeURIComponent(payout.providerId)}`,{method:'GET'})).data||{};
      const status=String(transfer.status||'').toUpperCase();
      if(status==='SUCCESSFUL'){await payoutRef.set({status:'successful',provider:transfer,updatedAt:admin.firestore.FieldValue.serverTimestamp()},{merge:true});}
      else if(status==='FAILED'||status==='CANCELLED'){
        const currency=String(payout.currency||'').toUpperCase(),balanceField=currency==='NGN'?'balanceNGN':'balanceUSD',withdrawnField=currency==='NGN'?'withdrawnNGN':'withdrawnUSD',amount=Number(payout.amount||0);
        await db.runTransaction(async tx=>{const [freshPayout,sellerSnap]=await Promise.all([tx.get(payoutRef),tx.get(ref)]);const fp=freshPayout.data()||{};if(['successful','failed','cancelled'].includes(String(fp.status||'').toLowerCase()))return;tx.update(ref,{[balanceField]:admin.firestore.FieldValue.increment(amount),[withdrawnField]:admin.firestore.FieldValue.increment(-amount),updatedAt:admin.firestore.FieldValue.serverTimestamp()});tx.set(payoutRef,{status:'failed',provider:transfer,refunded:true,updatedAt:admin.firestore.FieldValue.serverTimestamp()},{merge:true});});
      }
      return json(res,200,{status:status||payout.status||'pending',reference:payout.reference||payoutId,providerId:payout.providerId});
    }
    if(action==='withdraw'){const r=await withdraw(db,ref,p,b,decoded);return json(res,200,r);}
    if(action==='start-plan')return createPlanCharge(req,res,decoded,b);
    if(action==='verify-plan'){
      const orderId=clean(b.orderId,100),orderRef=db.collection('sellerPlanOrders').doc(orderId),snap=await orderRef.get();
      if(!snap.exists||snap.data()?.uid!==decoded.uid)return json(res,404,{error:'Plan payment not found.'});
      const o=snap.data()||{};
      if(o.status==='paid'){const current=await ref.get();const cp=current.data()||{};return json(res,200,{status:'paid',tier:cp.tier||o.tier,accessUntil:cp.accessUntil?.toDate?cp.accessUntil.toDate().toISOString():(cp.accessUntil||null)});}
      let charge={};
      if(o.flutterwaveChargeId)charge=(await flwRequest(`/charges/${encodeURIComponent(o.flutterwaveChargeId)}`,{method:'GET'})).data||{};
      const valid=['succeeded','successful'].includes(String(charge.status||'').toLowerCase())&&Number(charge.amount)===Number(o.amount)&&String(charge.currency||'').toUpperCase()==='USD'&&String(charge.reference||'')===String(o.reference||'');
      if(!valid){if(['failed','voided'].includes(String(charge.status||'').toLowerCase()))await orderRef.set({status:'failed',flutterwaveStatus:charge.status,updatedAt:admin.firestore.FieldValue.serverTimestamp()},{merge:true});return json(res,200,{status:charge.status||'pending',nextAction:charge.next_action||null});}
      const days=o.cycle==='annual'?365:30,until=new Date(Date.now()+days*24*60*60*1000);
      await db.runTransaction(async tx=>{
        const [freshOrder,freshSeller]=await Promise.all([tx.get(orderRef),tx.get(ref)]);
        const fo=freshOrder.data()||{},fs=freshSeller.data()||{};
        if(fo.status==='paid')return;
        tx.set(ref,{tier:o.tier,accessUntil:admin.firestore.Timestamp.fromDate(until),studioAccess:true,visibility:true,planPaidAt:admin.firestore.FieldValue.serverTimestamp(),cancelAt:null,cancelRequestedAt:null,updatedAt:admin.firestore.FieldValue.serverTimestamp()},{merge:true});
        tx.set(orderRef,{status:'paid',paidAt:admin.firestore.FieldValue.serverTimestamp(),verifiedAmount:Number(charge.amount),verifiedCurrency:charge.currency,flutterwaveStatus:charge.status,updatedAt:admin.firestore.FieldValue.serverTimestamp()},{merge:true});
      });
      return json(res,200,{status:'paid',tier:o.tier,accessUntil:until.toISOString()});
    }
    if(action==='resolve-bank'){const currency=String(b.currency||'').toUpperCase();if(!['USD','NGN'].includes(currency))return json(res,400,{error:'Choose USD or NGN payout currency.'});const country=currency==='NGN'?'NG':String(b.country||'').toUpperCase();if(currency==='USD'&&!country)return json(res,400,{error:'Choose a USD destination country.'});const account=await resolveBank(b.bankName,b.accountNumber,currency,country,{routingNumber:b.routingNumber,swiftCode:b.swiftCode,accountType:b.accountType});return json(res,200,{ok:true,accountName:account.accountName,bankName:account.bankName});}
    if(action==='remove-bank'){const currency=String(b.currency||'').toUpperCase();if(!['USD','NGN'].includes(currency))return json(res,400,{error:'Choose USD or NGN payout currency.'});const id=clean(b.bankId,80);if(!id)return json(res,400,{error:'Choose the payout account to remove.'});const field=currency==='USD'?'payoutBanksUSD':'payoutBanksNGN',legacyField=currency==='USD'?'payoutBankUSD':'payoutBankNGN';const existing=payoutAccounts(p,currency),next=existing.filter(x=>x.id!==id);if(next.length===existing.length)return json(res,404,{error:'Payout account not found.'});await ref.set({[field]:next,[legacyField]:next.length?next[next.length-1]:admin.firestore.FieldValue.delete(),updatedAt:admin.firestore.FieldValue.serverTimestamp()},{merge:true});return json(res,200,{ok:true});}
    if(action==='save-bank'){const currency=String(b.currency||'').toUpperCase();if(!['USD','NGN'].includes(currency))return json(res,400,{error:'Choose USD or NGN payout currency.'});const country=currency==='NGN'?'NG':String(b.country||'').toUpperCase();if(currency==='USD'&&!country)return json(res,400,{error:'Choose a USD destination country.'});const account=await resolveBank(b.bankName,b.accountNumber,currency,country,{routingNumber:b.routingNumber,swiftCode:b.swiftCode,accountType:b.accountType});account.country=country;const field=currency==='USD'?'payoutBanksUSD':'payoutBanksNGN';const existing=payoutAccounts(p,currency),next=[...existing.filter(x=>!(String(x.bankCode)===String(account.bankCode)&&String(x.accountNumber)===String(account.accountNumber)&&String(x.country||'')===String(account.country||''))),account].slice(-20);const legacyField=currency==='USD'?'payoutBankUSD':'payoutBankNGN';await ref.set({[field]:next,[legacyField]:account,updatedAt:admin.firestore.FieldValue.serverTimestamp()},{merge:true});return json(res,200,{ok:true,currency,account:{id:account.id,bankName:account.bankName,accountNumber:`****${account.accountNumber.slice(-4)}`,accountName:account.accountName,country:account.country||country}});}
    return json(res,400,{error:'Unknown seller action.'});
  }catch(e){json(res,e.status&&e.status<500?e.status:500,{error:e.message||'Seller request failed.'});}
}
