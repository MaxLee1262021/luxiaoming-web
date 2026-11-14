"use strict";
const {gzip,constants}=require("node:zlib");

function acceptsGzip(value) {
  return String(value || "").split(",").some(part=>{
    const [name,...parameters]=part.trim().toLowerCase().split(";");
    if(name!=="gzip")return false;
    const quality=parameters.find(p=>p.trim().startsWith("q="));
    return quality===undefined || Number(quality.trim().slice(2))>0;
  });
}
function sendJson(res,status,value){
  res.statusCode=status;res.setHeader("Content-Type","application/json; charset=utf-8");
  const body=JSON.stringify(value),req=res.req;
  // Compress large GET responses only when explicitly supported. The payload,
  // role filtering and cache policy remain identical to the ordinary response.
  if(status!==200 || req?.method!=="GET" || Buffer.byteLength(body)<16384 || !acceptsGzip(req.headers?.["accept-encoding"]))return res.end(body);
  const vary=String(res.getHeader("Vary") || "").split(",").map(v=>v.trim()).filter(Boolean);
  if(!vary.some(v=>v.toLowerCase()==="accept-encoding"))vary.push("Accept-Encoding");
  res.setHeader("Vary",vary.join(", "));
  return new Promise(resolve=>gzip(body,{level:constants.Z_BEST_SPEED},(error,compressed)=>{
    if(res.writableEnded || res.destroyed){resolve();return;}
    if(error){res.end(body);resolve();return;}
    res.setHeader("Content-Encoding","gzip");res.end(compressed);resolve();
  }));
}
module.exports={sendJson,acceptsGzip};
