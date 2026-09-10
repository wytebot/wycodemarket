import crypto from 'node:crypto';
import {google} from 'googleapis';
import admin from 'firebase-admin';

function parseServiceAccount(raw) {
  if (!raw) throw new Error('Missing service account JSON');
  const text = String(raw).trim();
  try { return JSON.parse(text); } catch {}
  try { return JSON.parse(text.replace(/\\n/g, '\n')); }
  catch { throw new Error('Invalid service account JSON'); }
}

let db;
export function getDb() {
  if (db) return db;
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON || process.env.GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error('Missing FIREBASE_SERVICE_ACCOUNT_JSON or GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON');
  const sa = parseServiceAccount(raw);
  if (!admin.apps.length) admin.initializeApp({credential: admin.credential.cert(sa)});
  db = admin.firestore();
  return db;
}

let drive;
export function getDrive() {
  if (drive) return drive;
  const sa = parseServiceAccount(process.env.GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON);
  const auth = new google.auth.GoogleAuth({credentials: sa, scopes:['https://www.googleapis.com/auth/drive.readonly']});
  drive = google.drive({version:'v3', auth});
  return drive;
}

function flutterwaveEnvironment() {
  const raw=String(process.env.FLW_ENVIRONMENT||'').trim().toLowerCase();
  if(!raw) return 'production';
  if(raw==='sandbox'||raw==='test') return 'sandbox';
  if(raw==='production'||raw==='prod'||raw==='live') return 'production';
  const e=new Error(`Invalid FLW_ENVIRONMENT: ${raw}. Use sandbox or production.`);
  e.status=500;
  e.data={error:{type:'INVALID_FLW_ENVIRONMENT',code:'CONFIG',message:e.message}};
  throw e;
}

export function flwBase() {
  return flutterwaveEnvironment()==='sandbox'
    ? 'https://developersandbox-api.flutterwave.com'
    : 'https://f4bexperience.flutterwave.com';
}

function parseFlutterwaveError(text) {
  let data;
  try { data=JSON.parse(text); } catch { data={raw:text}; }
  const err=data?.error||{};
  return {
    data,
    type:String(err.type||data?.type||''),
    code:String(err.code||data?.code||''),
    message:String(err.message||data?.message||''),
    validation_errors:Array.isArray(err.validation_errors)?err.validation_errors:[]
  };
}

let tokenCache=null; // {token, expiresAt, environment} — kept in module scope so it survives across warm invocations of the same serverless function
export async function flwToken({forceRefresh=false}={}) {
  const clientId = process.env.FLW_CLIENT_ID;
  const clientSecret = process.env.FLW_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    const e=new Error('Missing Flutterwave v4 credentials.');
    e.status=500;
    e.data={error:{type:'CONFIGURATION_ERROR',code:'MISSING_CREDENTIALS',message:e.message}};
    throw e;
  }
  const environment=flutterwaveEnvironment();
  if (!forceRefresh && tokenCache && tokenCache.environment===environment && tokenCache.expiresAt>Date.now()) {
    return tokenCache.token;
  }
  const form = new URLSearchParams({client_id:clientId, client_secret:clientSecret, grant_type:'client_credentials'});
  const tokenEndpoint='https://idp.flutterwave.com/realms/flutterwave/protocol/openid-connect/token';
  const trace=crypto.randomUUID().replaceAll('-','');
  const r = await fetch(tokenEndpoint, {
    method:'POST',
    headers:{'Content-Type':'application/x-www-form-urlencoded','X-Trace-Id':trace},
    body:form
  });
  const text=await r.text();
  const parsed=parseFlutterwaveError(text);
  if (!r.ok) {
    const message=parsed.message||`Flutterwave OAuth authorization failed (${r.status}).`;
    const e=new Error(message);
    e.status=r.status;
    e.data={
      error:{
        type:parsed.type||'OAUTH_ERROR',
        code:parsed.code||String(r.status),
        message,
        validation_errors:parsed.validation_errors
      },
      diagnostic:{
        phase:'oauth',
        environment,
        api_base_url:flwBase(),
        endpoint:tokenEndpoint,
        trace_id:trace,
        environment_hint:'Flutterwave v4 credentials are environment-specific. If these credentials were created for the other environment, use the matching v4 Client ID and Client Secret.'
      }
    };
    throw e;
  }
  let j;
  try { j=JSON.parse(text); } catch { j={}; }
  if (!j.access_token) {
    const e=new Error('Flutterwave did not return an access token.');
    e.status=502;
    e.data={error:{type:'OAUTH_RESPONSE_INVALID',code:'NO_ACCESS_TOKEN',message:e.message},diagnostic:{phase:'oauth',environment,api_base_url:flwBase(),endpoint:tokenEndpoint,trace_id:trace}};
    throw e;
  }
  const ttlSeconds=Number.isFinite(Number(j.expires_in))?Number(j.expires_in):3300; // fall back to 55 min if Flutterwave omits expires_in
  tokenCache={token:j.access_token,expiresAt:Date.now()+Math.max(30,ttlSeconds-60)*1000,environment};
  return j.access_token;
}

export async function flwRequest(path, options={}, _retried=false) {
  const token = await flwToken();
  const environment=flutterwaveEnvironment();
  const base=flwBase();
  const trace = crypto.randomUUID().replaceAll('-', '');
  const headers = {
    Authorization:`Bearer ${token}`,
    'Content-Type':'application/json',
    'X-Trace-Id':trace,
    ...(options.headers||{})
  };
  const r = await fetch(base+path,{...options,headers});
  if (r.status===401 && !_retried) {
    // Cached token was rejected (expired/revoked) — refresh once and retry rather than failing the whole payment
    await flwToken({forceRefresh:true});
    return flwRequest(path, options, true);
  }
  const text = await r.text();
  const parsed=parseFlutterwaveError(text);
  if (!r.ok) {
    const message=parsed.message||`Flutterwave request failed (${r.status}).`;
    const e = new Error(message);
    e.status=r.status;
    e.data={
      error:{
        type:parsed.type||'FLUTTERWAVE_ERROR',
        code:parsed.code||String(r.status),
        message,
        validation_errors:parsed.validation_errors
      },
      diagnostic:{
        phase:'api',
        environment,
        api_base_url:base,
        endpoint:base+path,
        trace_id:trace,
        environment_hint:r.status===403?'A 403 means the authenticated Flutterwave client/token is not permitted to use this resource. Verify that FLW_CLIENT_ID, FLW_CLIENT_SECRET and FLW_ENCRYPTION_KEY are from the same v4 environment selected above, and that the Flutterwave account has access to this payment capability.':r.status===401?'A 401 usually means the Flutterwave credentials/token are invalid or expired. Use matching v4 credentials for the selected environment.':''
      }
    };
    throw e;
  }
  try { return JSON.parse(text); } catch { return {raw:text}; }
}

export function json(res,status,payload) {
  res.status(status).setHeader('Content-Type','application/json; charset=utf-8');
  res.end(JSON.stringify(payload));
}

export function method(req,res,allowed) {
  if (!allowed.includes(req.method)) {
    res.setHeader('Allow',allowed.join(', '));
    json(res,405,{error:'Method not allowed'});
    return false;
  }
  return true;
}

export async function body(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  const raw = await rawBody(req);
  try { return JSON.parse(raw || '{}'); } catch { throw new Error('Invalid JSON body'); }
}

export async function rawBody(req) {
  if (Buffer.isBuffer(req.rawBody)) return req.rawBody;
  if (typeof req.rawBody === 'string') return Buffer.from(req.rawBody);
  const chunks=[];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function secret() {
  const s=process.env.DOWNLOAD_TOKEN_SECRET;
  if(!s || s.length<32) throw new Error('DOWNLOAD_TOKEN_SECRET must be at least 32 characters');
  return s;
}

export function signDownloadToken(orderId, ttlSeconds=900) {
  const payload=Buffer.from(JSON.stringify({oid:orderId,exp:Math.floor(Date.now()/1000)+ttlSeconds})).toString('base64url');
  const sig=crypto.createHmac('sha256',secret()).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

export function verifyDownloadToken(token) {
  const parts=String(token||'').split('.');
  if(parts.length!==2) throw new Error('Invalid token');
  const [payload,sig]=parts;
  const expected=crypto.createHmac('sha256',secret()).update(payload).digest('base64url');
  const a=Buffer.from(sig), b=Buffer.from(expected);
  if(a.length!==b.length || !crypto.timingSafeEqual(a,b)) throw new Error('Invalid token');
  let p;
  try { p=JSON.parse(Buffer.from(payload,'base64url').toString('utf8')); } catch { throw new Error('Invalid token'); }
  if(!p.oid || !Number.isInteger(p.exp) || p.exp < Math.floor(Date.now()/1000)) throw new Error('Expired token');
  return p;
}

export function encryptCardField(value,keyBase64,nonce) {
  if (!value) throw new Error('Missing card field');
  if (!nonce || nonce.length !== 12) throw new Error('Card encryption nonce must be 12 characters');
  const key=Buffer.from(keyBase64,'base64');
  if(key.length!==32) throw new Error('FLW_ENCRYPTION_KEY must decode to exactly 32 bytes');
  const cipher=crypto.createCipheriv('aes-256-gcm',key,Buffer.from(nonce,'utf8'));
  const encrypted=Buffer.concat([cipher.update(String(value),'utf8'),cipher.final(),cipher.getAuthTag()]);
  return encrypted.toString('base64');
}

export function randomNonce() {
  const chars='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const bytes=crypto.randomBytes(12);
  return Array.from(bytes,b=>chars[b%chars.length]).join('');
}

export async function sendPurchaseReceipt({to,name,productName,orderId,amount,currency,reference}) {
  const key=String(process.env.RESEND_API_KEY||'').trim();
  const from=String(process.env.RECOVERY_FROM_EMAIL||'').trim();
  if(!key||!from) throw new Error('Receipt email delivery is not configured. Set RESEND_API_KEY and RECOVERY_FROM_EMAIL.');
  const appUrl=String(process.env.APP_URL||'').trim().replace(/\/$/,'');
  if(!/^https:\/\/[^\s]+$/i.test(appUrl)) throw new Error('APP_URL must be a valid HTTPS URL');
  const token=signDownloadToken(orderId,24*60*60);
  const downloadUrl=`${appUrl}/api/download?token=${encodeURIComponent(token)}`;
  const safeName=String(name||'Customer').replace(/[<>]/g,'');
  const safeProduct=String(productName||'Source code').replace(/[<>]/g,'');
  const safeRef=String(reference||'').replace(/[<>]/g,'');
  const safeAmount=Number(amount).toLocaleString('en-NG',{minimumFractionDigits:2,maximumFractionDigits:2});
  const safeCurrency=String(currency||'').toUpperCase();
  const html=`<div style=\"font-family:Arial,sans-serif;line-height:1.6;color:#111827\"><h2>Payment successful — WyCode Market</h2><p>Hi ${safeName},</p><p>Your payment for <b>${safeProduct}</b> was successfully verified.</p><p><b>Amount:</b> ${safeCurrency} ${safeAmount}<br><b>Reference:</b> ${safeRef}</p><p><a href=\"${downloadUrl}\" style=\"display:inline-block;padding:12px 18px;background:#111827;color:#fff;text-decoration:none;border-radius:8px\">Download source code</a></p><p>This secure download link expires in 24 hours. You can use the free purchase recovery flow later if you need a fresh link.</p><p>— WyCode Market</p></div>`;
  const r=await fetch('https://api.resend.com/emails',{method:'POST',headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json'},body:JSON.stringify({from,to:[String(to).trim().toLowerCase()],subject:`Payment receipt — ${safeProduct}`,html})});
  const text=await r.text(); let data={}; try{data=JSON.parse(text)}catch{}
  if(!r.ok) throw new Error(data?.message||`Receipt email delivery failed (${r.status})`);
  return data;
}

export async function markPaid(orderId, charge, options={}) {
  const sendReceipt=options.sendReceipt===true;
  const db=getDb();
  const ref=db.collection('orders').doc(orderId);
  const snap=await ref.get();
  if(!snap.exists) throw new Error('Order not found');
  const order=snap.data();
  const alreadyPaid=order.status==='paid';
  await ref.set({status:'paid',paidAt:alreadyPaid?(order.paidAt||admin.firestore.FieldValue.serverTimestamp()):admin.firestore.FieldValue.serverTimestamp(),flutterwaveChargeId:charge.id||order.flutterwaveChargeId||'',flutterwaveReference:charge.reference||order.reference,flutterwaveStatus:charge.status||order.flutterwaveStatus||'',verifiedAmount:Number(charge.amount),verifiedCurrency:charge.currency,updatedAt:admin.firestore.FieldValue.serverTimestamp()},{merge:true});
  let receiptStatus=order.receiptStatus||'';
  const tasks=[];
  if(!alreadyPaid && order.productId){
    tasks.push(db.collection('products').doc(order.productId).set({sales:admin.firestore.FieldValue.increment(1),updatedAt:admin.firestore.FieldValue.serverTimestamp()},{merge:true}));
  }
  if(order.email && !alreadyPaid){
    const email=String(order.email).trim().toLowerCase();
    const customerRef=db.collection('customers').doc(Buffer.from(email).toString('base64url'));
    const customerUpdate={email,name:order.name||'',orders:admin.firestore.FieldValue.increment(1),lastOrderId:orderId,lastOrderAt:admin.firestore.FieldValue.serverTimestamp(),updatedAt:admin.firestore.FieldValue.serverTimestamp()};
    if(order.kind==='pro'){
      customerUpdate.pro=true;
      customerUpdate.plan='pro';
      customerUpdate.proOrderId=orderId;
      customerUpdate.proAmount=Number(order.amount);
      customerUpdate.proCurrency=String(order.currency||'');
      customerUpdate.proPaidAt=admin.firestore.FieldValue.serverTimestamp();
    }else{
      customerUpdate.lastProductId=order.productId||'';
      customerUpdate.lastProductName=order.productName||'';
    }
    tasks.push(customerRef.set(customerUpdate,{merge:true}));
    if(order.kind!=='pro' && sendReceipt && receiptStatus!=='sent') {
      receiptStatus='sending';
      tasks.push(
        sendPurchaseReceipt({to:email,name:order.name,productName:order.productName,orderId,amount:order.amount,currency:order.currency,reference:order.reference})
          .then(()=>{receiptStatus='sent';return ref.set({receiptStatus:'sent',receiptSentAt:admin.firestore.FieldValue.serverTimestamp(),receiptError:admin.firestore.FieldValue.delete()},{merge:true});})
          .catch(receiptError=>{
            receiptStatus='failed';
            console.error('purchase-receipt:',receiptError?.message||receiptError);
            return ref.set({receiptStatus:'failed',receiptError:String(receiptError?.message||receiptError).slice(0,500)},{merge:true});
          })
      );
    }
  }
  // Payment confirmation must not wait on email delivery. Receipt delivery is handled by the
  // dedicated receipt endpoint after the success UI is shown, while the webhook can request it
  // server-side as a fallback. This keeps the payment confirmation path fast and reliable.
  await Promise.all(tasks);
  return {ref,receiptStatus};
}
