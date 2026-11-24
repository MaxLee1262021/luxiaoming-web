"use strict";

const { createLogger } = require("./observability.cjs");

function createPhysicalWorker(source, options = {}) {
  const env = options.env || process.env;
  const logger = options.logger || createLogger({ service: "physical-worker" });
  const intervalMs = Math.max(1000, Math.min(Number(env.PHYSICAL_WORKER_INTERVAL_MS) || 30000, 300000));
  let timer = null, pending = null, stopping = false;
  // Lazy resolution means construction never migrates or touches the database.
  const service = () => options.service || require("./physicalCommerce.cjs").serviceFor(source, options);
  async function runOnce() {
    if (stopping) return { skipped: true };
    if (pending) return pending;
    pending = Promise.resolve().then(async () => {
      // Parent payment facts are durable; repair an interrupted child-order
      // update before processing shipments and provider retry tasks.
      if (typeof source.list === 'function') {
        try {
          const result = await require('./packageFulfillment.cjs').reconcile(source);
          for (const failure of result.failures || []) logger.error('physical.package.recovery.failed', failure);
        } catch (error) {
          logger.error('physical.package.recovery.failed', { code: error.code || 'PACKAGE_FULFILLMENT_RECOVERY_FAILED' });
        }
      }
      return service().processPendingTasks();
    });
    try { return await pending; } finally { pending = null; }
  }
  function start() {
    if (timer || text(env.PHYSICAL_WORKER_ENABLED).toLowerCase() === "false") return;
    stopping = false;
    const tick = () => { runOnce().catch(error => logger.error("physical.worker.failed", { errorCode: error.code || "PHYSICAL_WORKER_ERROR" })); };
    timer = setInterval(tick, intervalMs); if (timer.unref) timer.unref(); tick();
  }
  async function stop() {
    stopping = true;
    if (timer) { clearInterval(timer); timer = null; }
    if (pending) await pending.catch(() => {});
  }
  return { start, stop, runOnce };
}
function text(value) { return String(value == null ? "" : value).trim(); }

module.exports = { createPhysicalWorker };
