"use strict";

// Read-only diagnosis: SELECT local facts and GET the original WeChat trade.
// Never calls RPC recovery, creates/closes a trade or changes a payment record.
const path = require("node:path");
const https = require("node:https");
const { createRequire } = require("node:module");

function safeCode(value) {
  const text = String(value || "");
  return /^[A-Za-z0-9_.:-]{1,128}$/.test(text) ? text : "";
}

function parseOptions(args) {
  const result = { root: path.resolve(__dirname, ".."), phase: "final", orderNo: "" };
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (!["--root", "--phase", "--order-no"].includes(flag) || !args[index + 1]) throw Object.assign(new Error("Invalid arguments"), { code: "DIAGNOSTIC_ARGUMENTS_INVALID" });
    const value = args[++index];
    if (flag === "--root") result.root = path.resolve(value);
    if (flag === "--phase") result.phase = value;
    if (flag === "--order-no") result.orderNo = value;
  }
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(result.orderNo) || !["deposit", "final"].includes(result.phase)) throw Object.assign(new Error("Order and phase required"), { code: "DIAGNOSTIC_ARGUMENTS_INVALID" });
  return result;
}

function diagnosticTransport(record) {
  return ({ hostname, method, path: apiPath, headers, body, timeoutMs }) => new Promise((resolve, reject) => {
    if (hostname !== "api.mch.weixin.qq.com" || method !== "GET" || body
      || !/^\/v3\/pay\/transactions\/out-trade-no\/[A-Za-z0-9_-]+\?mchid=\d+$/.test(apiPath)) {
      reject(Object.assign(new Error("Only a trade query is allowed"), { code: "DIAGNOSTIC_WRITE_FORBIDDEN" }));
      return;
    }
    const request = https.request({ hostname, method, path: apiPath, headers, timeout: Math.min(Number(timeoutMs) || 10000, 15000) }, response => {
      const chunks = [];
      let size = 0;
      response.on("data", chunk => {
        size += chunk.length;
        if (size > 1024 * 1024) { request.destroy(new Error("Response too large")); return; }
        chunks.push(Buffer.from(chunk));
      });
      response.on("error", reject);
      response.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        record.httpStatus = Number(response.statusCode || 0);
        record.providerRequestId = safeCode(response.headers["request-id"] || response.headers["wechatpay-request-id"]);
        if (record.httpStatus < 200 || record.httpStatus >= 300) {
          try { record.providerCode = safeCode(JSON.parse(raw).code); } catch (_) {}
        }
        resolve({ statusCode: record.httpStatus, headers: response.headers, body: raw });
      });
    });
    request.on("timeout", () => request.destroy(Object.assign(new Error("Query timed out"), { code: "ETIMEDOUT" })));
    request.on("error", error => { record.networkCode = safeCode(error.code); reject(error); });
    request.end();
  });
}

async function diagnose(options, dependencies) {
  const { connect, createGateway } = dependencies;
  let connection, order, payments;
  try {
    connection = await connect();
    await connection.query("SET TRANSACTION READ ONLY");
    await connection.beginTransaction();
    [order] = await connection.execute("SELECT id,status,workflowStage FROM lxm_orders WHERE orderNo=? LIMIT 1", [options.orderNo]);
    if (!order.length) return { readOnly: true, orderFound: false };
    order = order[0];
    [payments] = await connection.execute("SELECT phase,amount,status,provider,idempotency_key,out_trade_no,prepay_id,trade_state,prepay_created_at,record_created_at,record_updated_at,failure_reason FROM lxm_order_payment_records WHERE order_id=? AND phase=? ORDER BY record_no", [order.id, options.phase]);
  } finally {
    if (connection) { try { await connection.rollback(); } finally { await connection.end(); } }
  }
  const result = {
    readOnly: true, orderFound: true, phase: options.phase,
    order: { status: order.status, workflowStage: order.workflowStage },
    payments: payments.map(payment => ({
      amount: Number(payment.amount), status: payment.status, provider: payment.provider,
      hasRequestKey: !!payment.idempotency_key, hasOutTradeNo: !!payment.out_trade_no, hasPrepayId: !!payment.prepay_id,
      tradeState: payment.trade_state, createdAt: payment.record_created_at, updatedAt: payment.record_updated_at,
      prepayCreatedAt: payment.prepay_created_at, failureReason: payment.failure_reason,
    })),
  };
  const target = payments.filter(payment => payment.status === "pending" && payment.provider === "wechat_pay").slice(-1)[0];
  if (!target) return { ...result, query: { performed: false, reason: "NO_PENDING_ONLINE_PAYMENT" } };
  if (!target.out_trade_no) return { ...result, query: { performed: false, reason: "MISSING_OUT_TRADE_NO" } };
  const protocol = {};
  const gateway = createGateway(diagnosticTransport(protocol));
  if (!gateway.isConfigured()) return { ...result, query: { performed: false, reason: "PAYMENT_CONFIG_INVALID", configurationIssues: gateway.configurationErrors() } };
  try {
    const transaction = await gateway.queryTransaction(target.out_trade_no);
    result.query = { performed: true, ...protocol, verifiedResponse: true, tradeState: safeCode(transaction.tradeState) };
  } catch (error) {
    result.query = { performed: true, ...protocol, verifiedResponse: false, errorCode: safeCode(error.code) || "PAYMENT_QUERY_FAILED" };
  }
  return result;
}

async function main(args = process.argv.slice(2)) {
  const options = parseOptions(args);
  const installed = createRequire(path.join(options.root, "package.json"));
  installed("dotenv").config({ path: path.join(options.root, ".env"), quiet: true });
  const mysql = installed("mysql2/promise");
  const { createWechatPay } = installed("./server/lib/wechatPay.cjs");
  const result = await diagnose(options, {
    connect: () => mysql.createConnection({ host: process.env.DB_HOST, port: Number(process.env.DB_PORT || 3306),
      user: process.env.DB_USER, password: process.env.DB_PASSWORD || "", database: process.env.DB_NAME,
      connectTimeout: 5000, ...(process.env.DB_SSL === "true" ? { ssl: {} } : {}) }),
    createGateway: transport => createWechatPay({ transport }),
  });
  console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) main().catch(error => {
  console.log(JSON.stringify({ readOnly: true, errorCode: safeCode(error.code) || "DIAGNOSTIC_FAILED" }));
  process.exitCode = 1;
});

module.exports = { parseOptions, diagnosticTransport, diagnose };
