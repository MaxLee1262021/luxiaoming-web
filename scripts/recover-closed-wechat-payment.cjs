"use strict";

// Synchronize a provider-verified closed transaction through the existing
// payment confirmation path. No new transaction or direct payment write exists
// here. This file can be copied to /tmp and pointed at the installed project.
const path = require("node:path");
const { createRequire } = require("node:module");
const terminalStates = new Set(["CLOSED", "PAYERROR", "REVOKED"]);
const localStates = new Set(["pending", "failed", "confirmed", "not_created"]);

function fail(code) { return Object.assign(new Error(code), { code }); }

function parseArgs(argv) {
  const options = { root: "", orderNo: "", apply: false };
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (flag === "--apply") options.apply = true;
    else if (flag === "--help" || flag === "-h") options.help = true;
    else if (["--root", "--order-no"].includes(flag) && argv[index + 1] && !argv[index + 1].startsWith("--")) {
      const value = argv[++index];
      if (flag === "--root") options.root = path.resolve(value);
      else options.orderNo = value;
    } else throw fail("PAYMENT_RECOVERY_ARGUMENTS_INVALID");
  }
  if (!options.help && (!options.root || !options.orderNo || options.orderNo.length > 128)) throw fail("PAYMENT_RECOVERY_ARGUMENTS_INVALID");
  return options;
}

function safeError(error) {
  const result = {};
  const code = String(error && error.code || "");
  result.code = /^[A-Z][A-Z0-9_]{1,95}$/.test(code) ? code : "PAYMENT_RECOVERY_FAILED";
  const providerCode = String(error && error.providerCode || "");
  const providerRequestId = String(error && error.providerRequestId || "");
  if (/^[A-Z0-9_]{1,64}$/.test(providerCode)) result.providerCode = providerCode;
  if (/^[A-Za-z0-9_.:-]{1,128}$/.test(providerRequestId)) result.providerRequestId = providerRequestId;
  if (Number.isInteger(error && error.httpStatus) && error.httpStatus >= 100 && error.httpStatus <= 599) result.httpStatus = error.httpStatus;
  return result;
}

async function loadRuntime(options) {
  const installed = createRequire(path.join(options.root, "package.json"));
  installed("dotenv").config({ path: path.join(options.root, ".env"), quiet: true });
  process.env.DB_AUTO_MIGRATE = "false";
  // Relative certificate paths must resolve as they do under systemd.
  process.chdir(options.root);
  const { source } = installed("./server/lib/selectSource.cjs")();
  try {
    const gateway = installed("./server/lib/wechatPay.cjs").createWechatPay();
    return { source, gateway };
  } catch (error) {
    try { await source.close?.(); } catch (_) {}
    throw error;
  }
}

async function runRecovery(options, dependencies = {}) {
  let source = dependencies.source, gateway = dependencies.gateway, orderId = "", outTradeNo = "";
  const report = { ok: false, dryRun: options.apply !== true, applied: false };
  const readStatus = async () => {
    if (!source || !orderId || !outTradeNo) return;
    const current = await source.get("orders", orderId);
    const records = (current && Array.isArray(current.paymentRecords) ? current.paymentRecords : [])
      .filter(payment => payment.outTradeNo === outTradeNo);
    report.localStatus = records.length === 1 && localStates.has(String(records[0].status)) ? records[0].status : "unknown";
  };
  try {
    if (!options.root || !options.orderNo) throw fail("PAYMENT_RECOVERY_ARGUMENTS_INVALID");
    if (!source || !gateway) ({ source, gateway } = await (dependencies.loadRuntime || loadRuntime)(options));
    if (!gateway.isConfigured()) throw fail("WECHAT_PAY_CONFIG_INVALID");
    const matches = (await source.list("orders") || []).filter(order => order.orderNo === options.orderNo);
    if (matches.length !== 1) throw fail(matches.length ? "PAYMENT_RECOVERY_ORDER_AMBIGUOUS" : "PAYMENT_RECOVERY_ORDER_NOT_FOUND");
    const order = matches[0];
    orderId = String(order.id || order._id || "");
    const intents = (Array.isArray(order.paymentRecords) ? order.paymentRecords : []).filter(payment =>
      payment.phase === "final" && payment.provider === "wechat_pay" && payment.status === "pending");
    if (intents.length !== 1) throw fail(intents.length ? "PAYMENT_RECOVERY_INTENT_AMBIGUOUS" : "PAYMENT_RECOVERY_INTENT_NOT_FOUND");
    outTradeNo = String(intents[0].outTradeNo || "");
    if (!orderId || !/^[A-Za-z0-9_-]{6,32}$/.test(outTradeNo)) throw fail("WECHAT_PAY_OUT_TRADE_NO_INVALID");
    report.localStatus = "pending";
    const transaction = await gateway.queryTransaction(outTradeNo);
    if (!transaction || transaction.outTradeNo !== outTradeNo) throw fail("WECHAT_PAY_TRANSACTION_MISMATCH");
    const state = String(transaction.tradeState || "");
    report.tradeState = terminalStates.has(state) || ["SUCCESS", "NOTPAY", "USERPAYING"].includes(state) ? state : "UNKNOWN";
    if (!terminalStates.has(state)) {
      report.code = "PAYMENT_RECOVERY_EXISTING_FLOW_REQUIRED";
      return report;
    }
    if (options.apply === true) {
      // This retains merchant identity validation, order lookup, the order
      // mutex and CAS checks. Never bypass them with source.update or SQL.
      await gateway.confirmTransaction(source, transaction);
      await readStatus();
      if (report.localStatus !== "failed") throw fail("PAYMENT_RECOVERY_LOCAL_STATE_NOT_SYNCED");
      report.applied = true;
    }
    report.ok = true;
    return report;
  } catch (error) {
    Object.assign(report, safeError(error));
    try { await readStatus(); } catch (_) {}
    return report;
  } finally {
    if (source && typeof source.close === "function") {
      try { await source.close(); }
      catch (error) { report.ok = false; report.closeError = safeError(error); }
    }
  }
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write("Usage: node recover-closed-wechat-payment.cjs --root /opt/luxiaoming-admin --order-no ORDER_NO [--apply]\nDefault: query only. --apply synchronizes only a verified CLOSED/PAYERROR/REVOKED final payment.\n");
    return;
  }
  const report = await runRecovery(options);
  process.stdout.write(JSON.stringify(report) + "\n");
  if (!report.ok) process.exitCode = 1;
}

if (require.main === module) main().catch(error => {
  process.stdout.write(JSON.stringify({ ok: false, ...safeError(error) }) + "\n");
  process.exitCode = 1;
});

module.exports = { parseArgs, runRecovery, safeError };
