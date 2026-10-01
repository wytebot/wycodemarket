import {getDb,json,method} from './_lib.js';
function imageUrl(value){const u=String(value||'').trim();if(!u)return '';const m=u.match(/drive\.google\.com\/(?:uc\?[^#]*?id=|file\/d\/)([A-Za-z0-9_-]+)/i);return m?`https://drive.google.com/thumbnail?id=${encodeURIComponent(m[1])}&sz=w1200`:u;}
function toISO(v){try{if(!v)return '';if(typeof v.toDate==='function')return v.toDate().toISOString();const d=new Date(v);return Number.isFinite(d.getTime())?d.toISOString():''}catch{return '';}}
function rank(p){const sales=Math.max(0,Number(p.sales)||0),rating=Math.max(0,Math.min(5,Number(p.sellerRatingAverage??p.ratingAverage)||0)),reviews=Math.max(0,Number(p.ratingCount)||0),age=Date.now()-(new Date(p.createdAt?.toDate?p.createdAt.toDate():p.createdAt||Date.now()).getTime()||Date.now()),fresh=Math.max(0,1-Math.min(age,1000*60*60*24*90)/(1000*60*60*24*90));return Math.round((Math.log1p(sales)*12+rating*7+Math.min(reviews,100)*0.15+(p.special?18:0)+(p.visibility?4:0)+fresh*5)*100)/100;}
export default async function handler(req,res){
  if(!method(req,res,['GET']))return;
  try{
    const db=getDb(),snap=await db.collection('products').where('status','in',['active','published']).get();
    const refs=[...new Map(snap.docs.map(d=>[String(d.data()?.sellerUid||''),d.data()?.sellerUid?db.collection('sellers').doc(String(d.data().sellerUid)):null]).filter(x=>x[1])).values()];
    const sellerSnaps=refs.length?await db.getAll(...refs):[];
    const sellerMap=new Map(sellerSnaps.map(d=>[d.id,d.exists?d.data()||{}:{}]));
    const products=snap.docs.map(d=>{
      const p=d.data()||{},seller=sellerMap.get(String(p.sellerUid||''))||{};
      const sellerRatingAverage=Number(seller.ratingAverage??p.sellerRatingAverage??p.ratingAverage??0),sellerRatingCount=Number(seller.ratingCount??p.sellerRatingCount??0);
      const productReviewCount=Number(p.ratingCount||0);
      return {id:d.id,name:p.name||'',slug:p.slug||d.id,description:p.description||'',category:p.category||'Other',version:p.version||'',price:Number(p.price||p.priceUSD||0),currency:'USD',priceUSD:Number(p.priceUSD||p.price||0),priceNGN:Number(p.priceNGN||Math.round(Number(p.priceUSD||p.price||0)*1200)),demoUrl:p.demoUrl||'',coverUrl:imageUrl(p.coverUrl),screenshots:Array.isArray(p.screenshots)?p.screenshots:[],sellerUid:p.sellerUid||'',sellerName:p.sellerName||seller.displayName||'Developer',sellerAvatarUrl:p.sellerAvatarUrl||seller.avatarUrl||'',sellerRatingAverage,sellerRatingCount,contactEmail:p.contactEmail||'',contactWhatsApp:p.contactWhatsApp||'',visibility:Boolean(p.visibility),suggested:Boolean((p.suggested===true&&p.codeAudit?.status==='passed')||p.founderSuggested===true),special:Boolean(p.special||p.saleType==='special'),features:p.features||'',requirements:p.requirements||'',license:p.license||'Single-project source license',sales:Number(p.sales||0),ratingAverage:sellerRatingAverage,ratingCount:productReviewCount,rankScore:rank({...p,sellerRatingAverage,ratingCount:productReviewCount}),uploadedAtISO:toISO(p.createdAt||p.uploadedAt||p.publishedAt)};
    }).filter(p=>p.name);
    products.sort((a,b)=>b.rankScore-a.rankScore||b.sales-a.sales||b.sellerRatingAverage-a.sellerRatingAverage);
    return json(res,200,{products});
  }catch(e){return json(res,500,{error:'Unable to load products right now.'});}
}
