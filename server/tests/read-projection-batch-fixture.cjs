"use strict";

const http = require("node:http");
const { createFileService } = require("../lib/fileService.cjs");
const clone = value => value == null ? value : structuredClone(value);
const fileIds = ["a", "b", "c", "d"].map(value => `file_${value.repeat(40)}`);

function memoryFixture(orderCount = 24, { batched = true } = {}) {
  const rows = {
    staff: ["super", "service", "other-service", "content"].map(role => ({ id: role, account: role, role: role === "other-service" ? "service" : role, status: "启用" })),
    orders: [], afterSales: [],
    mediaFiles: fileIds.map((id, index) => ({ id, name: `stored-${index}.png`, mimeType: "image/png", size: 128 + index,
      status: "bound", purpose: index === 3 ? "after-sale" : "order-delivery", visibility: "private", orderId: "order-0",
      objectKey: `private/${id}`, ownerKind: "admin", ownerId: "service" })),
  };
  const ready = { status: "completed", totalAmount: 100, depositDue: 30, depositPaid: 30, depositFinanceStatus: "已审", finalDue: 70,
    finalPaid: 70, finalFinanceStatus: "已审", shootingStartedAt: "2026-11-01T08:00:00Z", shootingCompletedAt: "2026-11-01T09:00:00Z",
    selectionStatus: "confirmed", selectionConfirmedAt: "2026-11-01T10:00:00Z", deliveredAt: "2026-11-01T11:00:00Z",
    deliveryRecord: { method: "小程序成片", visibility: "customer", deliveredAt: "2026-11-01T11:00:00Z" },
    applicableSpots: [], products: [], deliveryDraftFileIds: [fileIds[2]],
    deliverFiles: [{ fileId: fileIds[0], name: "recorded-name.png", type: "image" }, { fileId: fileIds[1] }],
  };
  for (let index = 0; index < orderCount; index++) rows.orders.push({ ...clone(ready), id: `order-${index}`, orderNo: `ORDER-${index}`,
    openid: "customer", assigneeId: "service", createTime: new Date(Date.UTC(2026, 10, 1, 0, index)).toISOString() });
  rows.orders.push({ ...clone(ready), id: "foreign", orderNo: "FOREIGN", openid: "stranger", assigneeId: "other-service" });
  rows.afterSales = [
    { id: "ticket-1", orderId: "order-0", openid: "customer", type: "颜色", reason: "客户可见原因", status: "completed", attachmentFileIds: [fileIds[0], fileIds[1]], internalAttachmentFileIds: [fileIds[3]] },
    { id: "ticket-2", orderId: "order-0", openid: "customer", type: "修改", reason: "第二次反馈", status: "completed", attachmentFileIds: [fileIds[1], fileIds[0]] },
    { id: "internal-ticket", orderId: "order-0", type: "内部", reason: "内部处理原因", status: "completed", internalAttachmentFileIds: [fileIds[3]] },
    { id: "foreign-ticket", orderId: "foreign", openid: "stranger", status: "completed", attachmentFileIds: [fileIds[3]] },
  ];
  const reads = [];
  let hook;
  const find = (key, id) => (rows[key] || []).find(row => String(row.id || row._id) === String(id)) || null;
  const source = {
    async list(key) { reads.push({ method: "list", key }); const value = clone(rows[key] || []); if (hook) await hook(key, "list"); return value; },
    async get(key, id) { reads.push({ method: "get", key, ids: [String(id)] }); const value = clone(find(key, id)); if (hook) await hook(key, "get"); return value; },
  };
  if (batched) source.getMany = async (key, ids) => {
    reads.push({ method: "getMany", key, ids: ids.map(String) });
    const value = ids.map(id => clone(find(key, id)));
    if (hook) await hook(key, "getMany");
    return value;
  };
  const auth = { async init() {}, async getSession(token) {
    if (token === "customer" || token === "stranger") return { kind: "public", openid: token };
    if (["super", "service", "other-service", "content"].includes(token)) return { kind: "admin", role: token === "other-service" ? "service" : token, subjectId: token, account: token };
    return null;
  } };
  const logger = { info() {}, warn() {}, error() {}, debug() {} };
  const files = createFileService({ source, adapter: {} });
  return { rows, reads, source, auth, logger, files, fileIds, setReadHook(value) { hook = value; } };
}

async function startHttp(t, fixture, createApi = require("../lib/api.cjs"), options = {}) {
  const handler = createApi(fixture.source, "json", { auth: fixture.auth, logger: fixture.logger, fileAdapter: {}, ...options });
  const server = http.createServer((req, res) => handler(req, res, req.url.split("?")[0]));
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const close = () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });
  if (t) t.after(close);
  const request = async (route, token = "super") => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${route}`, { headers: { Authorization: `Bearer ${token}` } });
    return { status: response.status, body: await response.json() };
  };
  return { request, close };
}

module.exports = { memoryFixture, startHttp };
