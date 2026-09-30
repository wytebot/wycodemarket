import crypto from 'node:crypto';
import admin from 'firebase-admin';
import {getDb} from './_lib.js';

function json(res,status,payload){
  res.status(status).setHeader('Content-Type','application/json; charset=utf-8');
  res.end(JSON.stringify(payload));
}
async function body(req){
  if(req.body&&typeof req.body==='object') return req.body;
  const chunks=[];for await(const c of req)chunks.push(Buffer.isBuffer(c)?c:Buffer.from(c));
  try{return JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}')}catch{return {}}
}
async function authUser(req){
  const h=String(req.headers.authorization||'');
  const token=h.startsWith('Bearer ')?h.slice(7).trim():'';
  if(!token) return null;
  try{
    getDb(); // ensures the Admin SDK is initialized with the configured service account
    return await admin.auth().verifyIdToken(token);
  }catch{return null}
}
function tokenId(token){return crypto.createHash('sha256').update(token).digest('hex');}

export default async function handler(req,res){
  if(!['POST','DELETE'].includes(req.method)){
    res.setHeader('Allow','POST, DELETE');
    return json(res,405,{error:'Method not allowed'});
  }
  try{
    const user=await authUser(req);
    if(!user)return json(res,401,{error:'A valid Firebase sign-in token is required.'});
    const b=await body(req);
    const token=String(b.token||'').trim();
    if(!token||token.length>4096)return json(res,400,{error:'A valid FCM registration token is required.'});
    const db=getDb();
    const ref=db.collection('notificationSubscribers').doc(tokenId(token));
    if(req.method==='DELETE'){
      await ref.delete().catch(()=>{});
      return json(res,200,{subscribed:false});
    }
    await ref.set({
      token,
      uid:String(user.uid||''),
      enabled:true,
      updatedAt:admin.firestore.FieldValue.serverTimestamp(),
      userAgent:String(req.headers['user-agent']||'').slice(0,500)
    },{merge:true});
    return json(res,200,{subscribed:true});
  }catch(e){
    return json(res,500,{error:e?.message||'Notification subscription failed.'});
  }
}
