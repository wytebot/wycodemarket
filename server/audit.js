import JSZip from 'jszip';
import * as esbuild from 'esbuild';
import admin from 'firebase-admin';
import {getDb,getDrive,json,method} from './_lib.js';
const clean=(v,n)=>String(v??'').trim().slice(0,n);
const skip=/^(node_modules|\.git|dist|build|\.gradle)\//i;
const loaders={'.js':'js','.mjs':'js','.cjs':'js','.jsx':'jsx','.ts':'ts','.tsx':'tsx'};
function ext(name){const i=name.lastIndexOf('.');return i>=0?name.slice(i).toLowerCase():'';}
function lineFromError(e){return {file:clean(e?.location?.file||e?.file||'',300),line:Number(e?.location?.line||e?.line||0),column:Number(e?.location?.column||e?.column||0),message:clean(e?.text||e?.message||'Syntax error',700)};}
async function downloadZip(fileId){const d=getDrive(),r=await d.files.get({fileId,alt:'media'},{responseType:'arraybuffer'});return Buffer.from(r.data);}
export async function auditProduct(productId,{notify=false}={}){
 const db=getDb(),ref=db.collection('products').doc(productId),snap=await ref.get();if(!snap.exists)throw Object.assign(new Error('Product not found.'),{status:404});const p=snap.data()||{},fileId=clean(p.sourceDriveId,200);if(!fileId)throw new Error('Source Drive file ID is missing.');
 await ref.set({codeAudit:{status:'running',startedAt:admin.firestore.FieldValue.serverTimestamp()},updatedAt:admin.firestore.FieldValue.serverTimestamp()},{merge:true});
 let zip;try{zip=await downloadZip(fileId);}catch(e){const report={status:'unavailable',summary:'The source archive could not be read from the seller Drive. Make sure the file is shared with the configured audit service account.',errors:[],checkedFiles:0,updatedAt:new Date().toISOString()};await ref.set({codeAudit:report,updatedAt:admin.firestore.FieldValue.serverTimestamp()},{merge:true});return report;}
 if(zip.length>50*1024*1024)throw new Error('Source archive is larger than the 50 MB audit limit.');
 let archive;try{archive=await JSZip.loadAsync(zip,{checkCRC32:true})}catch(e){const report={status:'attention',summary:'The uploaded source archive is not a valid ZIP archive.',errors:[{file:'archive',line:0,column:0,message:String(e.message||'Invalid ZIP')}],checkedFiles:0,updatedAt:new Date().toISOString()};await ref.set({codeAudit:report},{merge:true});return report;}
 const errors=[],files=Object.values(archive.files).filter(f=>!f.dir&&!skip.test(f.name)).slice(0,500);let checked=0;
 for(const f of files){const x=ext(f.name);if(!loaders[x]&&x!=='.json')continue;let text;try{text=await f.async('string');}catch(e){errors.push({file:f.name,line:0,column:0,message:'Could not decode source file.'});continue;}checked++;if(x==='.json'){try{JSON.parse(text)}catch(e){errors.push({file:f.name,line:0,column:0,message:String(e.message||'Invalid JSON')})};continue;}try{await esbuild.transform(text,{loader:loaders[x],format:'esm',logLevel:'silent',sourcefile:f.name});}catch(e){errors.push(lineFromError(e));}if(errors.length>=30)break;}
 const report={status:errors.length?'attention':'passed',summary:errors.length?`${errors.length} syntax issue${errors.length===1?'':'s'} found.`:`No syntax errors found in the checked JavaScript/TypeScript/JSON files.`,errors,checkedFiles:checked,updatedAt:new Date().toISOString()};await ref.set({codeAudit:report,updatedAt:admin.firestore.FieldValue.serverTimestamp()},{merge:true});
 if(notify&&errors.length){try{const tokens=(await db.collection('notificationSubscribers').where('uid','==',p.sellerUid).limit(500).get()).docs.map(d=>String(d.data()?.token||'')).filter(Boolean);if(tokens.length)await admin.messaging().sendEachForMulticast({tokens,data:{title:'Product needs attention',body:`${p.name||'Your product'} might need attention: the code audit found ${errors.length} syntax issue${errors.length===1?'':'s'}.`,url:`/?product=${encodeURIComponent(productId)}&studio=audit`}})}catch{}}
 return report;
}
async function auth(req){
 const t=String(req.headers.authorization||'').replace(/^Bearer\s+/i,'').trim();
 if(!t)throw Object.assign(new Error('Authentication is required.'),{status:401});
 const db=getDb();let u;try{u=await admin.auth().verifyIdToken(t)}catch{throw Object.assign(new Error('Your session expired.'),{status:401})}
 const adminIds=String(process.env.ADMIN_UIDS||'').split(',').map(x=>x.trim()).filter(Boolean);
 if(adminIds.includes(u.uid))return {uid:u.uid,admin:true};
 return {uid:u.uid,admin:false};
}
export default async function handler(req,res){if(!method(req,res,['POST']))return;try{const u=await auth(req),b=req.body&&typeof req.body==='object'?req.body:{},id=clean(b.productId,120);if(!id)return json(res,400,{error:'Product is required.'});const snap=await getDb().collection('products').doc(id).get();if(!snap.exists)return json(res,404,{error:'Product not found.'});if(!u.admin&&String(snap.data()?.sellerUid)!==String(u.uid))return json(res,403,{error:'You can only audit your own product.'});const r=await auditProduct(id,{notify:Boolean(b.notify)});return json(res,200,{ok:true,audit:r});}catch(e){json(res,e.status&&e.status<500?e.status:500,{error:e.message||'Audit failed.'});}}
