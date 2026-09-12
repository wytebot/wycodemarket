import {getDb,json,method} from './_lib.js';
function imageUrl(value){
 const u=String(value||'').trim();
 if(!u)return '';
 const m=u.match(/drive\.google\.com\/(?:uc\?[^#]*?id=|file\/d\/)([A-Za-z0-9_-]+)/i);
 return m?`https://drive.google.com/thumbnail?id=${encodeURIComponent(m[1])}&sz=w1200`:u;
}
function toISO(value){try{if(!value)return '';if(typeof value.toDate==='function')return value.toDate().toISOString();if(typeof value==='number')return new Date(value).toISOString();const d=new Date(value);return Number.isFinite(d.getTime())?d.toISOString():''}catch{return ''}}
export default async function handler(req,res){if(!method(req,res,['GET']))return;try{const snap=await getDb().collection('products').get();const products=snap.docs.map(d=>({id:d.id,...d.data()})).filter(p=>(p.status==='active'||p.status==='published')&&String(p.driveFileId||'').trim()).map(p=>({id:p.id,name:p.name||'',slug:p.slug||p.id,description:p.description||'',category:p.category||'Other',version:p.version||'',price:Number(p.price||0),currency:p.currency||'USD',priceUSD:Number(p.priceUSD||0),priceNGN:Number(p.priceNGN||0),demoUrl:p.demoUrl||'',coverUrl:imageUrl(p.coverUrl),screenshots:Array.isArray(p.screenshots)?p.screenshots:[],features:p.features||'',requirements:p.requirements||'',license:p.license||'Single-project source license',saleType:p.saleType==='special'?'special':'normal',bannerUrl:imageUrl(p.bannerUrl),sales:Number(p.sales||0),ratingAverage:Number(p.ratingAverage||p.rating||0),ratingCount:Number(p.ratingCount||0),uploadedAtISO:toISO(p.createdAt||p.uploadedAt||p.publishedAt)}));json(res,200,{products});}catch(e){json(res,500,{error:'Unable to load products right now. Please try again.'});}}
