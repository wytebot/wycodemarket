import crypto from 'node:crypto';
import {json,method,flutterwaveEnvironment,flwBase,flwToken} from './_lib.js';

function fingerprint(value){
  return crypto.createHash('sha256').update(String(value||'')).digest('hex').slice(0,12);
}

export default async function handler(req,res){
  if(!method(req,res,['GET']))return;
  res.setHeader('Cache-Control','no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0');
  const environment=flutterwaveEnvironment();
  const clientId=String(process.env.FLW_CLIENT_ID||'').trim();
  const clientSecret=String(process.env.FLW_CLIENT_SECRET||'').trim();
  const result={
    ok:false,
    service:'flutterwave-v4',
    environment,
    apiBaseUrl:flwBase(),
    credentials:{
      clientIdConfigured:Boolean(clientId),
      clientSecretConfigured:Boolean(clientSecret),
      clientIdLength:clientId.length,
      clientSecretLength:clientSecret.length,
      clientIdFingerprint:clientId?fingerprint(clientId):'',
      credentialPairFingerprint:clientId&&clientSecret?fingerprint(clientId+'\0'+clientSecret):''
    }
  };
  try{
    await flwToken({forceRefresh:true});
    result.ok=true;
    result.oauth='authorized';
    return json(res,200,result);
  }catch(e){
    result.oauth='failed';
    result.error={
      type:e?.data?.error?.type||'OAUTH_ERROR',
      code:e?.data?.error?.code||String(e?.status||500),
      message:e?.data?.error?.message||e?.message||'Flutterwave OAuth failed',
      traceId:e?.data?.diagnostic?.trace_id||''
    };
    return json(res,e?.status&&e.status<500?e.status:502,result);
  }
}
