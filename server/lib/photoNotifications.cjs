"use strict";
const {localTime,timestamp}=require("./svcBenefit.cjs");

function createPhotoNotifications(source,options={}) {
  const endpoint=options.endpoint ?? process.env.PHOTO_NOTIFICATION_WEBHOOK_URL;
  const token=options.token ?? process.env.PHOTO_NOTIFICATION_WEBHOOK_TOKEN;
  const transport=options.transport || globalThis.fetch;
  const now=()=>options.clock?options.clock():new Date();
  const stamp=()=>localTime(now());
  async function drain() {
    if (!endpoint) return {configured:false,sent:0};
    if (!/^https:\/\//i.test(endpoint)) throw Object.assign(new Error("摄影师通知地址必须使用HTTPS"),{code:"PHOTO_NOTIFICATION_CONFIG"});
    let sent=0,failed=0;
    for(let count=0;count<20;count++) {
      const event=await source.transaction(async conn=>{
        const [rows]=await conn.query("SELECT * FROM svc_notification WHERE event_type IN ('photo_statement','photo_payment') AND status IN ('pending','sending') AND next_attempt_at<=? ORDER BY created_at,id LIMIT 1 FOR UPDATE",[stamp()]);
        if (!rows.length) return null;
        const event=rows[0];
        // Lease survives process restart; an idempotency key handles the remote
        // accepted/local commit interrupted case without duplicate messages.
        await conn.query("UPDATE svc_notification SET status='sending',attempts=attempts+1,next_attempt_at=? WHERE id=?",[localTime(timestamp(now())+300000),event.id]);
        return event;
      });
      if(!event)break;
      try {
        const response=await transport(endpoint,{method:"POST",headers:{"Content-Type":"application/json","Idempotency-Key":event.event_key,...(token?{Authorization:"Bearer "+token}:{})},
          body:JSON.stringify({event_id:event.id,event_key:event.event_key,event_type:event.event_type,photo_id:event.recipient_id,message:event.message}),signal:AbortSignal.timeout(10000)});
        if(!response.ok)throw new Error("DELIVERY_REJECTED");
        await source.transaction(conn=>conn.query("UPDATE svc_notification SET status='sent',sent_at=?,failure_note=NULL WHERE id=? AND status='sending'",[stamp(),event.id]));
        sent++;
      } catch(error) {
        const attempts=Number(event.attempts || 0)+1;
        const delay=Math.min(3600000,60000*2**Math.min(attempts,6));
        await source.transaction(conn=>conn.query("UPDATE svc_notification SET status='pending',next_attempt_at=?,failure_note=? WHERE id=?",[localTime(timestamp(now())+delay),"摄影师通知投递失败，将重试；请核对通知渠道配置",event.id]));
        failed++;
      }
    }
    return {configured:true,sent,failed};
  }
  return {drain};
}
module.exports={createPhotoNotifications};
