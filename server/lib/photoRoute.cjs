"use strict";

const MENUS = Object.freeze({photoRules:"分成配置",photoLedger:"分成明细",photoParty:"摄影师列表",photoSettlement:"结算管理",photoMine:"摄影端"});
function canPhoto(session, menu, write = false) {
  if (!session || session.kind !== "admin") return false;
  const role = String(session.role || "").toLowerCase();
  if (role === "super" || role === "admin") return true;
  if (menu === "photoNew") return false;
  if (role === "photo" || role === "photographer") return menu === "photoMine" && !write;
  if (["merchant", "distributor", "agent", "content"].includes(role)) return false;
  const keys = session.menuKeys || [];
  return keys.includes(menu) && (!write || ["finance", "service"].includes(role) || (session.photoPermissions || []).includes("photo:manage"));
}
function createPhotoRoute({service, json, readBody}) {
  return async function photoRoute(req, res, parts, parsed, session) {
    const verb = req.method, resource = parts[1];
    const sub = parts[2], action = parts[3];
    const menu = resource === "rule" ? "photoRules" : resource === "ledger" ? "photoLedger" : resource === "party" ? (verb === "POST" && !sub ? "photoNew" : "photoParty") : resource === "settlement" ? "photoSettlement" : "photoMine";
    const own = resource === "me" || resource === "ledger" && sub === "export" && (["photo","photographer"].includes(session.role) || session.role === "super" && session.kind !== "public" && String(parsed.query.mine) === "1");
    const dispatch = resource === "party" && verb === "GET" && parsed.query.scope === "dispatch" && ["super","service"].includes(session.role) && (session.role === "super" || (session.menuKeys || []).includes("orders"));
    if (!dispatch && !canPhoto(session, own ? "photoMine" : menu, verb !== "GET")) return json(res,403,{code:403,msg:"当前账号无权执行此摄影师分成操作"});
    const send = data => json(res,200,{code:0,msg:"ok",data});
    const body = verb === "POST" ? await readBody(req) : {};
    if (verb === "POST" && (!body || typeof body !== "object" || Array.isArray(body))) return json(res,400,{code:400,msg:"请求参数须为对象"});
    try {
      if (resource === "rule" && !sub && verb === "GET") return send(await service.getRules(parsed.query,session));
      if (resource === "rule" && sub === "preview" && verb === "POST") return send(await service.previewRule(body,session));
      if (resource === "rule" && !sub && verb === "POST") return send(await service.saveRule(body,session));
      if (resource === "ledger" && !sub && verb === "GET") return send(await service.listLedger(parsed.query,session));
      if (resource === "ledger" && sub === "export" && verb === "GET") {
        const csv = await service.exportCsv(parsed.query,session,{mine:own});
        res.statusCode=200; res.setHeader("Content-Type","text/csv; charset=utf-8");
        res.setHeader("Content-Disposition",'attachment; filename="photographer-share.csv"'); return res.end(csv);
      }
      if (resource === "ledger" && sub === "batch-settle" && verb === "POST") return send(await service.batchSettle(body,session));
      if (resource === "party" && !sub && verb === "GET") {
        const result=await service.listParties(parsed.query,session);
        if(dispatch) return send({...result,rows:(result.rows || result.list || []).map(({id,name,status})=>({id,name,status}))});
        return send(result);
      }
      if (resource === "party" && !sub && verb === "POST") {
        res.setHeader("Cache-Control","no-store");
        res.setHeader("Pragma","no-cache");
        return send(await service.createParty(body,session));
      }
      if (resource === "party" && sub && action === "rate" && verb === "POST") return send(await service.savePartyRate(decodeURIComponent(sub),body,session));
      if (resource === "party" && sub && action === "status" && verb === "POST") return send(await service.setPartyStatus(decodeURIComponent(sub),body,session));
      if (resource === "settlement" && !sub && verb === "GET") return send(await service.listSettlements(parsed.query,session));
      if (resource === "settlement" && verb === "POST") return send(await service.settlementAction(sub ? decodeURIComponent(sub) : body.settle_id,action || body.action || "generate",body,session));
      if (resource === "me" && !sub && verb === "GET") return send(await service.mine(parsed.query,session));
      return json(res,404,{code:404,msg:"摄影师分成接口不存在"});
    } catch (error) {
      const business = Number.isInteger(Number(error.code)) && Number(error.code)>=4300 && Number(error.code)<4400;
      return json(res,business?200:(error.statusCode || error.status || 503),{code:error.code || "PHOTO_UNAVAILABLE",msg:business || (error.statusCode || error.status)<500 ? error.message : "摄影师分成服务暂不可用，请核对数据库迁移与配置",...(error.data ? {data:error.data}: {})});
    }
  };
}
module.exports = {MENUS,canPhoto,createPhotoRoute};
