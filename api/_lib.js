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

export async function flwToken() {
  const clientId = process.env.FLW_CLIENT_ID;
  const clientSecret = process.env.FLW_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error('Missing Flutterwave v4 credentials');
  const form = new URLSearchParams({client_id:clientId, client_secret:clientSecret, grant_type:'client_credentials'});
  const r = await fetch('https://idp.flutterwave.com/realms/flutterwave/protocol/openid-connect/token', {
    method:'POST',
    headers:{'Content-Type':'application/x-www-form-urlencoded'},
    body:form
  });
  if (!r.ok) throw new Error(`Flutterwave auth failed (${r.status})`);
  const j = await r.json();
  if (!j.access_token) throw new Error('Flutterwave did not return an access token');
  return j.access_token;
}

export function flwBase() {
  return process.env.FLW_ENVIRONMENT === 'sandbox'
    ? 'https://developersandbox-api.flutterwave.com'
    : 'https://f4bexperience.flutterwave.com';
}

export async function flwRequest(path, options={}) {
  const token = await flwToken();
  const trace = crypto.randomUUID().replaceAll('-', '');
  const headers = {
    Authorization:`Bearer ${token}`,
    'Content-Type':'application/json',
    'X-Trace-Id':trace,
    ...(options.headers||{})
  };
  const r = await fetch(flwBase()+path,{...options,headers});
  const text = await r.text();
  let data;
  try { data = JSON.parse(text); } catch { data = {raw:text}; }
  if (!r.ok) {
    const e = new Error(data?.error?.message || data?.message || `Flutterwave request failed (${r.status})`);
    e.status=r.status;
    e.data=data;
    throw e;
  }
  return data;
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

export async function markPaid(orderId, charge) {
  const db=getDb();
  const ref=db.collection('orders').doc(orderId);
  const snap=await ref.get();
  if(!snap.exists) throw new Error('Order not found');
  const order=snap.data();
  const alreadyPaid=order.status==='paid';
  await ref.set({status:'paid',paidAt:alreadyPaid?(order.paidAt||admin.firestore.FieldValue.serverTimestamp()):admin.firestore.FieldValue.serverTimestamp(),flutterwaveChargeId:charge.id||order.flutterwaveChargeId||'',flutterwaveReference:charge.reference||order.reference,verifiedAmount:Number(charge.amount),verifiedCurrency:charge.currency,updatedAt:admin.firestore.FieldValue.serverTimestamp()},{merge:true});
  if(!alreadyPaid && order.productId){
    await db.collection('products').doc(order.productId).set({sales:admin.firestore.FieldValue.increment(1),updatedAt:admin.firestore.FieldValue.serverTimestamp()},{merge:true});
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
    await customerRef.set(customerUpdate,{merge:true});
  }
  return ref;
}
