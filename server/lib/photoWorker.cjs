"use strict";

// China business days are computed by the service. Repeated scans are safe:
// statement period/person and notification event keys are unique in MySQL.
function createPhotoWorker(source,options={}) {
  if (!source || typeof source.transaction !== "function") return null;
  const logger=options.logger || {info(){},error(){}};
  let timer, running, stopped=false;
  let service;
  const notifications=options.notifications || require("./photoNotifications.cjs").createPhotoNotifications(source,options.notificationOptions);
  async function tick() {
    if (stopped || running) return running;
    running=(async()=>{
      service ||= options.service || require("./photoShare.cjs").createPhotoShareService({source,...options.serviceOptions});
      try {
        const result=await service.runTasks(options.clock ? options.clock() : new Date());
        if(result.alerts?.length) logger.error("photo.accounting.alerts",{alerts:result.alerts});
        const delivery=await notifications.drain();
        if(delivery.failed) logger.error("photo.notifications.failed",{count:delivery.failed});
        return {...result,delivery};
      }
      catch(error) { logger.error("photo.tasks.failed",{errorCode:String(error.code || "PHOTO_TASK_FAILED"),action:"检查摄影师分成迁移和定时任务；可手动补跑"}); return {failed:true}; }
    })().finally(()=>{running=null;});
    return running;
  }
  return {tick,start(){if(timer)return;stopped=false;timer=setInterval(tick,60000);timer.unref?.();tick();},async stop(){stopped=true;clearInterval(timer);timer=null;if(running)await running;}};
}
module.exports={createPhotoWorker};
