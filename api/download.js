import {getDb,getDrive,json,method,verifyDownloadToken} from './_lib.js';

async function isInsideFolder(drive,fileId,folderId){
  let current=fileId;
  const seen=new Set();
  for(let i=0;i<20 && current;i++){
    if(current===folderId)return true;
    if(seen.has(current))return false;
    seen.add(current);
    const r=await drive.files.get({fileId:current,fields:'id,parents',supportsAllDrives:true});
    current=(r.data.parents||[])[0]||'';
  }
  return false;
}

export default async function handler(req,res){
  if(!method(req,res,['GET']))return;
  try{
    const {token}=req.query||{};
    const p=verifyDownloadToken(token);
    const snap=await getDb().collection('orders').doc(p.oid).get();
    if(!snap.exists)return json(res,404,{error:'Order not found'});
    const o=snap.data();
    if(o.status!=='paid')return json(res,403,{error:'Payment not verified'});
    if(!o.driveFileId)return json(res,404,{error:'Source file is not configured'});
    const drive=getDrive();
    const meta=(await drive.files.get({fileId:o.driveFileId,fields:'id,name,mimeType,size,capabilities(canDownload)',supportsAllDrives:true})).data;
    const folder=String(process.env.GOOGLE_DRIVE_FOLDER_ID||'').trim();
    if(folder && !(await isInsideFolder(drive,o.driveFileId,folder)))return json(res,403,{error:'Source file is outside the configured private folder'});
    if(meta.capabilities && meta.capabilities.canDownload===false)return json(res,403,{error:'File is not downloadable'});
    const stream=await drive.files.get({fileId:o.driveFileId,alt:'media',supportsAllDrives:true},{responseType:'stream'});
    res.statusCode=200;
    res.setHeader('Cache-Control','private, no-store');
    res.setHeader('Content-Type',meta.mimeType||'application/zip');
    res.setHeader('Content-Disposition',`attachment; filename="${String(meta.name||'source-code.zip').replace(/[\r\n"]/g,'_')}"`);
    if(meta.size)res.setHeader('Content-Length',meta.size);
    stream.data.on('error',()=>{try{res.end()}catch{}});
    stream.data.pipe(res);
  }catch(e){json(res,e.message==='Expired token'||e.message==='Invalid token'?401:(e.status||500),{error:e.message||'Download failed'});}
}
