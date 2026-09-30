// One catch-all Vercel Function for all WyCode Market API routes.
// This keeps the public /api/* URLs and their query strings intact.
import products from '../server/products.js';
import search from '../server/search.js';
import reviews from '../server/reviews.js';
import report from '../server/report.js';
import checkout from '../server/checkout.js';
import verify from '../server/verify.js';
import authorize from '../server/authorize.js';
import download from '../server/download.js';
import seller from '../server/seller.js';
import notifications from '../server/notifications.js';
import webhook from '../server/webhook.js';
import audit from '../server/audit.js';
import health from '../server/health.js';
import flutterwaveHealth from '../server/flutterwave-health.js';

const routes = {products,search,reviews,report,checkout,verify,authorize,download,seller,notifications,webhook,audit,health,'flutterwave-health':flutterwaveHealth};

export default async function handler(req,res) {
  const q = req.query?.route ?? req.query?.path;
  const fromQuery = Array.isArray(q) ? q.join('/') : String(q || '');
  const fromUrl = String(req.url || '').split('?')[0].replace(/^\/+|\/+$/g,'').split('/').slice(1).join('/');
  const route = (fromQuery || fromUrl).replace(/^api\//,'').replace(/^\/+|\/+$/g,'').split('/')[0];
  const target = routes[route];
  if (!target) {
    res.statusCode = 404;
    res.setHeader('Content-Type','application/json; charset=utf-8');
    return res.end(JSON.stringify({error:'API route not found.'}));
  }
  return target(req,res);
}
