import crypto from 'node:crypto';
import {getDb,json,method,body} from './_lib.js';

const emailRx=/^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const normEmail=v=>String(v||'').trim().toLowerCase();
const hashEmail=e=>crypto.createHash('sha256').update(e).digest('hex');
const otpHash=(email,otp)=>crypto.createHmac('sha256',String(process.env.DOWNLOAD_TOKEN_SECRET||'')).update(`${email}:${otp}`).digest('hex');
const generic={ok:true,message:'If an eligible purchase exists for this email, we sent a verification code. Check your inbox.'};
function isPro(email,customer){
  if(customer?.pro===true||customer?.plan==='pro')return true;
  const allowed=String(process.env.PRO_RECOVERY_EMAILS||'').split(',').map(normEmail).filter(Boolean);
  return allowed.includes(email);
}
async function sendEmail(to,subject,html){
  const key=String(process.env.RESEND_API_KEY||'').trim(),from=String(process.env.RECOVERY_FROM_EMAIL||'').trim();
  if(!key||!from)throw new Error('Recovery email delivery is not configured.');
  const r=await fetch('https://api.resend.com/emails',{method:'POST',headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json'},body:JSON.stringify({from,to:[to],subject,html})});
  const text=await r.text();let data={};try{data=JSON.parse(text)}catch{}
  if(!r.ok)throw new Error(data?.message||`Recovery email delivery failed (${r.status})`);
  return data;
}
export default async function handler(req,res){
  if(!method(req,res,['POST']))return;
  try{
    const b=await body(req),email=normEmail(b.email);
    if(!emailRx.test(email))return json(res,400,{error:'Enter a valid email address.'});
    const db=getDb();
    const customerSnap=await db.collection('customers').doc(Buffer.from(email).toString('base64url')).get();
    const customer=customerSnap.exists?customerSnap.data():null;
    const eligible=isPro(email,customer);
    const ordersSnap=eligible?await db.collection('orders').where('email','==',email).get():null;
    const paid=ordersSnap?ordersSnap.docs.filter(d=>d.data().status==='paid'&&d.data().driveFileId):[];
    if(!eligible||!paid.length)return json(res,200,generic);

    const rateRef=db.collection('recoveryRequests').doc(hashEmail(email));
    const rateSnap=await rateRef.get();const now=Date.now();
    if(rateSnap.exists&&now-Number(rateSnap.data().lastSentAtMs||0)<60_000)return json(res,200,generic);

    const otp=String(crypto.randomInt(0,1_000_000)).padStart(6,'0');
    await rateRef.set({email,otpHash:otpHash(email,otp),expiresAtMs:now+10*60_000,lastSentAtMs:now,attempts:0,used:false},{merge:true});
    await sendEmail(email,'WyCode purchase recovery code',`<div style="font-family:Arial,sans-serif;line-height:1.5"><h2>WyCode purchase recovery</h2><p>Use this verification code to continue:</p><p style="font-size:28px;font-weight:700;letter-spacing:6px">${otp}</p><p>This code expires in 10 minutes and can only be used once.</p><p>If you did not request purchase recovery, you can safely ignore this email.</p><p>— WyCode</p></div>`);
    return json(res,200,generic);
  }catch(e){
    console.error('recovery-request:',e);
    return json(res,200,generic);
  }
}
