import crypto from 'node:crypto';
import {getDb,json,method,body,signDownloadToken} from './_lib.js';
const emailRx=/^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const normEmail=v=>String(v||'').trim().toLowerCase();
const hashEmail=e=>crypto.createHash('sha256').update(e).digest('hex');
const otpHash=(email,otp)=>crypto.createHmac('sha256',String(process.env.DOWNLOAD_TOKEN_SECRET||'')).update(`${email}:${otp}`).digest('hex');
async function sendEmail(to,subject,html){
 const key=String(process.env.RESEND_API_KEY||'').trim(),from=String(process.env.RECOVERY_FROM_EMAIL||'').trim();
 if(!key||!from)throw new Error('Recovery email delivery is not configured.');
 const r=await fetch('https://api.resend.com/emails',{method:'POST',headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json'},body:JSON.stringify({from,to:[to],subject,html})});
 const text=await r.text();let data={};try{data=JSON.parse(text)}catch{}if(!r.ok)throw new Error(data?.message||`Recovery email delivery failed (${r.status})`);return data;
}
export default async function handler(req,res){
 if(!method(req,res,['POST']))return;
 try{
  const b=await body(req),email=normEmail(b.email),otp=String(b.otp||'').replace(/\D/g,'');
  if(!emailRx.test(email)||!/^[0-9]{6}$/.test(otp))return json(res,400,{error:'Enter a valid email address and 6-digit code.'});
  const db=getDb();
  const ref=db.collection('recoveryRequests').doc(hashEmail(email));
  const snap=await ref.get();
  if(!snap.exists)return json(res,401,{error:'The recovery code is invalid or expired.'});
  const r=snap.data();
  if(r.used||Number(r.expiresAtMs||0)<Date.now()||Number(r.attempts||0)>=5)return json(res,401,{error:'The recovery code is invalid or expired.'});
  const expected=otpHash(email,otp),stored=String(r.otpHash||'');
  if(expected.length!==stored.length||!crypto.timingSafeEqual(Buffer.from(expected),Buffer.from(stored))){await ref.set({attempts:Number(r.attempts||0)+1},{merge:true});return json(res,401,{error:'The recovery code is invalid or expired.'});}

  const ordersSnap=await db.collection('orders').where('email','==',email).get();
  const orders=ordersSnap.docs.map(d=>({id:d.id,...d.data()})).filter(o=>o.status==='paid'&&o.driveFileId);
  if(!orders.length)return json(res,401,{error:'The recovery code is invalid or expired.'});
  const appUrl=String(process.env.APP_URL||'').trim().replace(/\/$/,'');if(!/^https:\/\/[^\s]+$/i.test(appUrl))throw new Error('APP_URL must be a valid HTTPS URL');
  const items=orders.map(o=>({name:o.productName||'Purchased source code',url:`${appUrl}/api/download?token=${encodeURIComponent(signDownloadToken(o.id,24*60*60))}`}));
  const list=items.map(x=>`<li style="margin:10px 0"><a href="${x.url}">${x.name}</a><br><small>Secure download link — expires in 24 hours.</small></li>`).join('');
  await sendEmail(email,'Your WyCode purchase access',`<div style="font-family:Arial,sans-serif;line-height:1.5"><h2>Your WyCode purchase access</h2><p>Your purchase access has been verified.</p><p>Secure download links for your eligible purchases are below:</p><ul>${list}</ul><p>These links expire in 24 hours. You can request new links whenever needed.</p><p>Keep this email private and do not share your download links.</p><p>— WyCode</p></div>`);
  await ref.set({used:true,usedAtMs:Date.now(),attempts:Number(r.attempts||0)+1},{merge:true});
  return json(res,200,{ok:true,message:'Your secure download links have been sent to your email.'});
 }catch(e){console.error('recovery-verify:',e);return json(res,500,{error:'Could not complete purchase recovery. Please try again.'});}
}
