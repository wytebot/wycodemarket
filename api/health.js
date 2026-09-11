import {json,method} from './_lib.js'; export default function handler(req,res){if(!method(req,res,['GET']))return; json(res,200,{ok:true,service:'WyCode Market',version:'1.2.0'});}
