"use strict";
// One service instance per real data source. Feature activation is explicit;
// opening a list never replays payment attribution or creates bindings.
const services = new WeakMap();
const pending = new WeakMap();
const retryTimers = new WeakMap();
const {createLogger,errorCode} = require('./observability.cjs');
const defaultLogger = createLogger({service:'customer-service'});
const RETRY_SECONDS = [5,25,125];
const menus = [
  ['svcGeneralWorkbench','总工作台','客服工作台'],
  ['svcWorkbench','工作台','客服工作台'],['productLinks','商品小程序外链','客服工作台'],['svcIntake','订单承接','客服工作台'],['svcFollowup','跟进与完成','客服工作台'],['svcComplaints','客诉与退款','客服工作台'],
  ['svcRules','分成配置','客服分成管理'],['svcLedger','分成明细','客服分成管理'],['svcStaff','客服列表','客服分成管理'],['svcSettlements','结算管理','客服分成管理'],['svcMine','客服端','客服分成管理']
];
function enabled() { return !!process.env.SVC_ENABLE_AT && Number.isFinite(Date.parse(process.env.SVC_ENABLE_AT)); }
async function hasManualClaims(source, orderNo, options = {}) {
  let store = options.store || (source && services.get(source)?.store);
  if (!store?.hasManualClaims) {
    if (typeof source?.transaction !== "function") return false;
    store = require('./svcStore.cjs').createSvcStore(source);
  }
  try { return await store.hasManualClaims(orderNo); }
  catch (error) { if (error.code === "ER_NO_SUCH_TABLE") return false; throw error; }
}
function serviceFor(source, options = {}) {
  if (!services.has(source)) {
    const store = options.store || require('./svcStore.cjs').createSvcStore(source);
    const benefit = require('./svcCommission.cjs');
    const commission = benefit.createSvcCommission({store,...options});
    const linkProvider = async ({order,staff,id,expires_at}) => {
      const [[mapping]] = await source.transaction(conn=>conn.query("SELECT m.wecom_userid,m.staff_id FROM lxm_share_staff_map m JOIN lxm_auth_users u ON u.id=m.staff_id WHERE m.staff_id=? AND m.status='ACTIVE' AND u.status='active' LIMIT 1",[staff.account_id]));
      if (!mapping) throw require('./svcCore.cjs').fail(4014,'请先在商家分成模块配置该客服的企业微信映射');
      const link=await require('./merchantShare.cjs').serviceFor(source).store.createCsLink({linkId:id,requestId:id,staffId:mapping.staff_id,wecomUserId:mapping.wecom_userid,operatorId:staff.account_id,expiresAt:new Date(require('./svcCore.cjs').millis(expires_at)).toISOString()});
      return {path:`pages/index/index?staff_id=${encodeURIComponent(mapping.wecom_userid)}&link_id=${encodeURIComponent(link.linkId || id)}&order_no=${encodeURIComponent(order.order_no)}&product_id=${encodeURIComponent(order.product_id || '')}`};
    };
    const notifier = process.env.SVC_NOTICE_WEBHOOK_URL ? async notice => {
      const response=await fetch(process.env.SVC_NOTICE_WEBHOOK_URL,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({event:notice.event_type,recipient:notice.recipient_id,message:notice.message}),signal:AbortSignal.timeout(10000)});
      if(!response.ok)throw new Error('通知通道暂不可用');
    } : undefined;
    const workbench = require('./svcWorkbench.cjs').createSvcWorkbench({source,store,benefit,linkProvider,notifier,...options});
    services.set(source,{store,commission,workbench});
  }
  return services.get(source);
}
async function onPaid(source, order) {
  if (!enabled() || source.bookingRequestSource || !order) return {skipped:true};
  const at = order.depositPaidAt || order.paid_at || order.paidAt;
  if (!at || require('./svcCore.cjs').millis(at) < Date.parse(process.env.SVC_ENABLE_AT)) return {skipped:true};
  const result = await serviceFor(source).workbench.onPaid(order);
  await source.update('orders',String(order.id || order._id),{svcPaymentPending:false,svcPaymentRetryAt:null,svcPaymentDeadAt:null});
  return result;
}
async function alert(source,key,message,options={}) {
  const c=require('./svcCore.cjs'),at=c.stamp(options.clock?options.clock():new Date());
  try {
    const svc=serviceFor(source,options);
    await svc.store.transaction(state=>{
      if(state.notifications.some(n=>n.event_key===key))return;
      state.notifications.push({id:c.uid(),event_key:key,event_type:'technical_alert',order_no:null,recipient_id:process.env.SVC_TECH_RECIPIENT_ID||null,message,status:'pending',attempts:0,next_attempt_at:at,created_at:at});
    });
    if(options.notifier || process.env.SVC_NOTICE_WEBHOOK_URL) await svc.workbench.deliverNotifications();
  } catch(error) { (options.logger||defaultLogger).error('svc.alert.delivery.failed',{code:errorCode(error)}); }
}
async function attemptPaid(source,order,options={}) {
  const id=String(order.id || order._id),c=require('./svcCore.cjs'),at=c.stamp(options.clock?options.clock():new Date());
  if (!pending.has(source)) pending.set(source,new Map());
  const jobs=pending.get(source);if(jobs.has(id))return {queued:true};
  const run=(async()=>{
    const current=await source.get('orders',id);
    if(!current || !current.svcPaymentPending || current.svcPaymentDeadAt)return {skipped:true};
    if(current.svcPaymentRetryAt && c.millis(current.svcPaymentRetryAt)>c.millis(at))return {queued:true};
    try { return await onPaid(source,current); }
    catch(error) {
      const attempts=Number(current.svcPaymentAttempts||0)+1,dead=attempts>RETRY_SECONDS.length;
      const retryAt=dead?null:c.add(at,RETRY_SECONDS[attempts-1],1000);
      await source.update('orders',id,{svcPaymentPending:!dead,svcPaymentAttempts:attempts,svcPaymentRetryAt:retryAt,svcPaymentDeadAt:dead?at:null,svcPaymentFailureCode:errorCode(error)});
      (options.logger||defaultLogger).error(dead?'svc.payment.dead_letter':'svc.payment.retry.scheduled',{orderId:id,code:errorCode(error),attempts,nextAttemptAt:retryAt});
      if(dead)await alert(source,`payment-dead:${id}:${at}`,`支付复购判定重试耗尽，请人工核验订单 ${current.orderNo||id}`,options);
      else if(options.schedule!==false) {
        if(!retryTimers.has(source))retryTimers.set(source,new Set());
        const timers=retryTimers.get(source);
        const timer=setTimeout(()=>{timers.delete(timer);attemptPaid(source,current,options).catch(e=>(options.logger||defaultLogger).error('svc.payment.retry.failed',{orderId:id,code:errorCode(e)}));},RETRY_SECONDS[attempts-1]*1000);
        timers.add(timer);timer.unref?.();
      }
      return {pending:!dead,dead,attempts,next_attempt_at:retryAt};
    }
  })().finally(()=>jobs.delete(id));
  jobs.set(id,run);return run;
}
async function queuePaid(source, order, options={}) {
  if (order && !source.bookingRequestSource) await require('./packageFulfillment.cjs').sync(source, order);
  if (!enabled() || source.bookingRequestSource || !order) return {skipped:true};
  const at = order.depositPaidAt || order.paid_at || order.paidAt;
  if (!at || require('./svcCore.cjs').millis(at) < Date.parse(process.env.SVC_ENABLE_AT)) return {skipped:true};
  const id = String(order.id || order._id);
  const current=await source.get('orders',id);
  // A duplicate callback cannot reset either the countdown or the retry budget.
  if(current?.svc_paid_processed || current?.svcPaymentDeadAt)return {skipped:true};
  if(!current?.svcPaymentPending)await source.update('orders',id,{svcPaymentPending:true,svcPaymentAttempts:0,svcPaymentRetryAt:null,svcPaymentDeadAt:null});
  attemptPaid(source,current||order,options).catch(error=>(options.logger||defaultLogger).error('svc.payment.enqueue.failed',{orderId:id,code:errorCode(error)}));
  return {queued:true};
}
async function onRefund(source, order) {
  if (!order) return {skipped:true};
  await require('./packageFulfillment.cjs').sync(source, order);
  const no = order.orderNo || order.order_no;
  if (!enabled() && (!no || !await hasManualClaims(source, no))) return {skipped:true};
  return serviceFor(source).workbench.onRefund({ order_no: no, customerCancelled: order.cancellationSource === "customer_self_cancel" });
}
async function onCancelled(source, order, options = {}) {
  if (!order || source.bookingRequestSource) return {skipped:true};
  await require('./packageFulfillment.cjs').sync(source, order);
  const no = order.orderNo || order.order_no;
  if (Number(order.svc_paid_processed) !== 1 && (!no || !await hasManualClaims(source,no,options))) return {skipped:true};
  return serviceFor(source,options).workbench.onCancelled(no);
}
async function onCompleted(source, order, options = {}) {
  if (!order || source.bookingRequestSource) return {skipped:true};
  await require('./packageFulfillment.cjs').sync(source, order);
  // A late duplicate receipt must not re-open a refunded/cancelled order or
  // turn a review hold into service completion.
  if (order.paymentReviewRequired === true || require('./orderWorkflow.cjs').canonicalStage(order) === 'cancelled') return {skipped:true};
  const no = order.orderNo || order.order_no;
  // Completing an already managed order must continue to work after automatic
  // intake is disabled. Ordinary historical orders never enter the workbench
  // merely because a payment result was read or retried.
  if (Number(order.svc_paid_processed) !== 1 && (!no || !await hasManualClaims(source,no,options))) return {skipped:true};
  return serviceFor(source,options).workbench.onCompleted(order);
}
function createWorker(source, options = {}) {
  let timer, stopped = false, current, lastMonth = '', failures = 0;
  async function tick() {
    if (stopped || current) return;
    current = (async()=>{
      try {
        const automatic = enabled();
        // Explicit claim is the durable admission fact for manually accepted
        // orders. It keeps their lifecycle running without turning on payment
        // attribution or discovering historical orders through a list scan.
        if (!automatic && !await hasManualClaims(source, undefined, options)) return;
        const svc = serviceFor(source,options), now = options.clock ? options.clock() : new Date();
        // Retry only durable payment events previously marked by the callback.
        // Ordinary list reads and newly discovered historical orders never enter here.
        for (const order of automatic ? (await source.list('orders')).filter(row=>row.svcPaymentPending && !row.svcPaymentDeadAt) : []) {
          try { await attemptPaid(source,order,options); } catch(error) { (options.logger||defaultLogger).error('svc.payment.retry.failed',{orderId:order.id,code:errorCode(error)}); }
        }
        const result=await svc.workbench.runTasks(now); await svc.commission.runTasks(now);
        for(const notice of result.alerts||[])await alert(source,`worker-alert:${notice.order_no}:${stampDay(now)}`,`订单 ${notice.order_no}：${notice.message}`,options);
        const stamp = require('./svcCore.cjs').stamp(now), month = stamp.slice(0,7);
        if (stamp.slice(8,10) === '01' && stamp.slice(11,16) >= '00:30' && lastMonth !== month) {
          const d = new Date(stamp.slice(0,7)+'-01T00:00:00+08:00');
          const previous = new Date(d.getTime()-86400000).toISOString().slice(0,7);
          await svc.commission.execute('POST','/api/svc/settlement/generate',{period:previous},{role:'super',subjectId:'system',account:'system'}); lastMonth = month;
        }
        failures = 0;
      } catch(error) { failures++; (options.logger||defaultLogger).error('svc.worker.failed',{code:errorCode(error),consecutiveFailures:failures});if(failures===2)await alert(source,`worker-failed:${stampDay(new Date())}`,'客服回流任务连续失败2次，请技术人员检查',options); }
    })().finally(()=>{current=null;});
    return current;
  }
  return { tick, start() { if (timer) return; stopped=false; timer=setInterval(tick,60000);timer.unref?.();tick(); }, async stop() { stopped=true;clearInterval(timer);timer=null;for(const scheduled of retryTimers.get(source)||[])clearTimeout(scheduled);retryTimers.get(source)?.clear();await current; } };
}
function stampDay(value){return require('./svcCore.cjs').stamp(value).slice(0,10);}
module.exports={menus,enabled,hasManualClaims,serviceFor,onPaid,queuePaid,onRefund,onCancelled,onCompleted,createWorker,attemptPaid};
