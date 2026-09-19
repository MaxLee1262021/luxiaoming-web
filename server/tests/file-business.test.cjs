"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const createApi = require("../lib/api.cjs");

const clone = (value) => value == null ? value : structuredClone(value);
async function fixture(t) {
  const collections = { staff: {}, orders: {}, afterSales: {}, logs: {}, mediaFiles: {}, userProfiles: {}, samples: {}, homeConfig: {}, adjustmentRecords: {} };
  let sequence = 0;
  for (const role of ["super", "service", "photo", "finance", "content"]) collections.staff[role] = { id: role, account: role, role, status: "启用" };
  const readyOrder = { status: "final_pending", totalAmount: 100, depositDue: 30, depositPaid: 30, depositFinanceStatus: "已审", finalDue: 70, finalPaid: 0,
    shootingCompletedAt: "2026-09-16T09:00:00.000Z", shootingStartedAt: "2026-09-16T08:00:00.000Z", selectionStatus: "confirmed", selectionConfirmedAt: "2026-09-16T10:00:00.000Z" };
  collections.orders.own = { ...readyOrder, id: "own", orderNo: "TEST-OWN", openid: "customer", photographerId: "photo" };
  collections.orders.other = { ...readyOrder, id: "other", orderNo: "TEST-OTHER", openid: "other-customer", photographerId: "other-photo" };
  const source = {
    async list(key) { return clone(Object.values(collections[key] || {})); },
    async get(key, id) { return clone(collections[key] && collections[key][id]) || null; },
    async create(key, body) {
      const id = String(body.id || body._id || `record-${++sequence}`);
      collections[key] ||= {};
      if (collections[key][id]) throw Object.assign(new Error("duplicate"), { code: "DUPLICATE_RECORD" });
      collections[key][id] = { ...clone(body), id }; return clone(collections[key][id]);
    },
    async update(key, id, body) { if (!collections[key]?.[id]) return null; Object.assign(collections[key][id], clone(body)); return clone(collections[key][id]); },
    async upsert(key, id, body) { return collections[key]?.[id] ? this.update(key, id, body) : this.create(key, { ...body, id }); },
    async remove(key, id) { const exists = !!collections[key]?.[id]; if (exists) delete collections[key][id]; return exists; },
  };
  const sessions = Object.fromEntries(Object.keys(collections.staff).map((role) => [role, { kind: "admin", subjectId: role, role, account: role }]));
  sessions.customer = { kind: "public", openid: "customer" };
  sessions.stranger = { kind: "public", openid: "other-customer" };
  const auth = { async init() {}, async getSession(token) { return clone(sessions[token]); }, async revokeSession() {} };
  const reads = [];
  const adapter = {
    allocation(id, extension) { return { bucket: "fixture-private", objectKey: `fixture/${id}.${extension}` }; },
    async signUpload(asset) { return { uploadUrl: "https://fixture.invalid", fields: { key: asset.objectKey }, expiresAt: new Date(Date.now() + 60000).toISOString() }; },
    async inspect(asset) { return { size: asset.size, mimeType: asset.mimeType, fileId: asset.id, acl: "private", etag: "fixture", bytes: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]) }; },
    async signRead(asset, options) { reads.push({ id: asset.id, options }); return { url: `https://fixture.invalid/${asset.id}?temporary=yes`, expiresAt: new Date(Date.now() + 60000).toISOString() }; },
    async remove() {},
  };
  const handler = createApi(source, "json", { auth, fileAdapter: adapter });
  const server = http.createServer((req, res) => handler(req, res, (req.url || "").split("?")[0]));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  async function request(token, route, body, method = body === undefined ? "GET" : "POST") {
    const response = await fetch(base + route, { method, redirect: "manual", headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const raw = await response.text();
    return { status: response.status, body: raw ? JSON.parse(raw) : null, headers: response.headers };
  }
  async function upload(token, scope) {
    const intent = await request(token, "/api/files/upload-intent", { fileName: "photo.png", mimeType: "image/png", size: 8, ...scope });
    assert.equal(intent.status, 200, JSON.stringify(intent.body));
    const id = intent.body.data.fileId;
    const complete = await request(token, `/api/files/${id}/complete`, {});
    assert.equal(complete.status, 200, JSON.stringify(complete.body));
    return id;
  }
  return { collections, source, sessions, reads, request, upload };
}

test("file intents enforce verified session, order ownership and live account status", async (t) => {
  const f = await fixture(t);
  const input = { purpose: "order-delivery", orderId: "own", fileName: "photo.png", mimeType: "image/png", size: 8, kind: "admin", ownerId: "super" };
  assert.equal((await f.request(null, "/api/files/upload-intent", input)).status, 401);
  assert.equal((await f.request("customer", "/api/files/upload-intent", input)).status, 403);
  assert.equal((await f.request("photo", "/api/files/upload-intent", { ...input, orderId: "other" })).status, 403);
  const id = await f.upload("photo", input);
  assert.equal(f.collections.mediaFiles[id].ownerId, "photo");
  f.collections.staff.photo.status = "停用";
  assert.equal((await f.request("photo", `/api/files/${id}/access`, {})).status, 401);
});

test("photographer saves drafts but only customer service publishes; owner downloads before final payment", async (t) => {
  const f = await fixture(t);
  const id = await f.upload("photo", { purpose: "order-delivery", orderId: "own" });
  let response = await f.request("photo", "/api/orders/own/action", { action: "deliverydraft", fileIds: [id] });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.body.data.deliveryDraftFiles[0].fileId, id);
  const unpublished = await f.request("customer", "/api/rpc/getOrderDetail", { orderId: "own" });
  assert.deepEqual(unpublished.body.data.deliverFiles, []);
  assert.equal(unpublished.body.data.deliveryDraftFileIds, undefined);
  assert.equal((await f.request("customer", `/api/files/${id}/access`, {})).status, 403);
  const publish = { action: "deliver", fileIds: [id], deliveryMethod: "小程序成片", reason: "确认发布成片" };
  assert.equal((await f.request("photo", "/api/orders/own/action", publish)).status, 403);
  response = await f.request("service", "/api/orders/own/action", publish);
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.body.data.workflowStage, "awaiting_final_payment");
  assert.equal(response.body.data.deliverFiles[0].fileId, id);
  const detail = await f.request("customer", "/api/rpc/getOrderDetail", { orderId: "own" });
  assert.equal(detail.body.data.deliverFiles[0].fileId, id);
  assert.equal((await f.request("customer", `/api/files/${id}/access`, { download: true })).status, 200);
  assert.equal((await f.request("stranger", `/api/files/${id}/access`, {})).status, 403);
  assert.equal((await f.request("finance", `/api/files/${id}/access`, {})).status, 403);
  assert.equal((await f.request(null, `/api/media/${id}`)).status, 404);
  assert.equal((await f.request("photo", `/api/files/${id}`, undefined, "DELETE")).status, 409);
});

test("cross-order and wrong-purpose references cannot be bound; legacy WeCom delivery still works", async (t) => {
  const f = await fixture(t);
  const otherId = await f.upload("service", { purpose: "order-delivery", orderId: "other" });
  const avatarId = await f.upload("customer", { purpose: "avatar" });
  for (const id of [otherId, avatarId]) assert.equal((await f.request("service", "/api/orders/own/action", { action: "deliver", fileIds: [id], reason: "确认发布", deliveryMethod: "小程序成片" })).status, 403);
  const delivered = await f.request("service", "/api/orders/own/action", { action: "deliver", deliveryMethod: "企业微信", reason: "企业微信交付完成" });
  assert.equal(delivered.status, 200);
  assert.equal(delivered.body.data.deliveryMethod, "企业微信");
});

test("avatar updates use only the caller's uploaded file and persist the durable identifier", async (t) => {
  const f = await fixture(t);
  const id = await f.upload("customer", { purpose: "avatar" });
  const foreign = await f.request("stranger", "/api/rpc/updateMyProfile", { avatarFileId: id, openid: "customer" });
  assert.equal(foreign.body.success, false);
  const saved = await f.request("customer", "/api/rpc/updateMyProfile", { avatarFileId: id, avatarUrl: "https://malicious.invalid/" });
  assert.equal(saved.body.success, true, JSON.stringify(saved.body));
  assert.equal(saved.body.data.avatarFileId, id);
  assert.match(saved.body.data.userInfo.avatarUrl, /temporary=yes/);
  assert.equal(f.collections.userProfiles.customer.avatarFileId, id);
  assert.equal(f.collections.userProfiles.customer.avatarUrl, undefined);
});

test("after-sale evidence is scoped to the owner, internal evidence stays private, repeated submissions are idempotent", async (t) => {
  const f = await fixture(t);
  const id = await f.upload("customer", { purpose: "after-sale", orderId: "own" });
  const payload = { orderId: "own", reason: "希望调整照片颜色", attachmentFileIds: [id] };
  const repeated = await Promise.all([f.request("customer", "/api/rpc/submitAfterSale", payload), f.request("customer", "/api/rpc/submitAfterSale", payload)]);
  assert.ok(repeated.every((r) => r.body.success));
  assert.equal(Object.keys(f.collections.afterSales).length, 1);
  const ticketId = repeated[0].body.data.ticketId;
  const internalId = await f.upload("service", { purpose: "after-sale", orderId: "own" });
  const follow = await f.request("service", `/api/after-sales/${ticketId}/action`, { action: "follow", reason: "内部处理说明", attachmentFileIds: [internalId] });
  assert.equal(follow.status, 200, JSON.stringify(follow.body));
  assert.equal(follow.body.data.internalAttachments[0].fileId, internalId);
  const mine = await f.request("customer", "/api/rpc/getMyAfterSales", { orderId: "own" });
  assert.deepEqual(mine.body.data[0].attachments.map((file) => file.fileId), [id]);
  assert.ok(!JSON.stringify(mine.body).includes("内部处理说明"));
  assert.ok(!JSON.stringify(mine.body).includes(internalId));
  assert.equal((await f.request("customer", `/api/files/${internalId}/access`, {})).status, 403);
  assert.equal((await f.request("stranger", "/api/rpc/getMyAfterSales", { orderId: "own" })).body.success, false);
  assert.equal((await f.request("service", "/api/orders/own/action", { action: "deliver", reason: "错误推进" })).status, 409);
});

test("public material can be reused across content pages but private file URLs cannot", async (t) => {
  const f = await fixture(t);
  const id = await f.upload("content", { purpose: "content", collection: "samples" });
  const saved = await f.request("content", "/api/collection/samples", { id: "sample-public", name: "照片", url: `/api/media/${id}` });
  assert.equal(saved.status, 201, JSON.stringify(saved.body));
  const reused = await f.request("content", "/api/doc/homeConfig/homeStats", { banners: [{ url: `/api/media/${id}` }] }, "PUT");
  assert.equal(reused.status, 200, JSON.stringify(reused.body));
  const head = await f.request(null, `/api/media/${id}`, undefined, "HEAD");
  assert.equal(head.status, 302);
  assert.equal(f.reads.at(-1).options.method, "HEAD");
  const privateId = await f.upload("customer", { purpose: "avatar" });
  assert.equal((await f.request("content", "/api/collection/samples", { name: "伪造", url: `/api/media/${privateId}` })).status, 403);
  assert.equal((await f.request("super", "/api/collection/mediaFiles")).status, 400);
});

test("finance evidence is validated and survives the normalized business contract", async (t) => {
  const f = await fixture(t);
  const id = await f.upload("finance", { purpose: "finance", collection: "adjustmentRecords", orderId: "own" });
  const saved = await f.request("finance", "/api/collection/adjustmentRecords", { orderId: "own", amount: 10, note: "冲正凭证说明", attachment: "历史文本", attachmentFileIds: [id] });
  assert.equal(saved.status, 201, JSON.stringify(saved.body));
  assert.deepEqual(saved.body.attachmentFileIds, [id]);
  assert.equal(saved.body.attachments[0].fileId, id);
  assert.equal(saved.body.attachment, "历史文本");
  assert.equal((await f.request("service", `/api/files/${id}/access`, {})).status, 403);
  assert.equal((await f.request("finance", `/api/files/${id}/access`, {})).status, 200);
});

test("migrated private markers become authorized file descriptors, never loadable URLs", async (t) => {
  const f = await fixture(t);
  const avatarId = await f.upload("customer", { purpose: "avatar" });
  f.collections.userProfiles.customer = { id: "customer", openid: "customer", phone: "123", avatarUrl: `oss-file:${avatarId}` };
  const profile = await f.request("customer", "/api/rpc/getMyProfile", {});
  assert.equal(profile.body.data.avatarFileId, avatarId);
  assert.match(profile.body.data.avatarUrl, /temporary=yes/);
  assert.ok(!JSON.stringify(profile.body).includes("oss-file:"));

  const deliveryId = await f.upload("photo", { purpose: "order-delivery", orderId: "own" });
  const order = f.collections.orders.own;
  order.deliveredAt = "2026-09-17T00:00:00.000Z";
  order.deliveryRecord = { method: "企业微信" };
  order.photos = [`oss-file:${deliveryId}`, { url: `oss-file:${deliveryId}`, name: "精修照片" }];
  f.collections.mediaFiles[deliveryId].status = "bound";
  const detail = await f.request("customer", "/api/rpc/getOrderDetail", { orderId: "own" });
  assert.equal(detail.body.data.deliverFiles.length, 2);
  assert.equal(detail.body.data.deliverFiles[0].fileId, deliveryId);
  assert.equal(detail.body.data.deliverFiles[0].type, "image");
  assert.equal(detail.body.data.deliverFiles[1].name, "精修照片");
  assert.ok(detail.body.data.deliverFiles.every((file) => file.url === undefined));
  assert.ok(!JSON.stringify(detail.body).includes("oss-file:"));
  assert.equal((await f.request("customer", `/api/files/${deliveryId}/access`, {})).status, 200);
  assert.equal((await f.request("stranger", `/api/files/${deliveryId}/access`, {})).status, 403);
  const adminOrder = await f.request("service", "/api/collection/orders/own");
  assert.equal(adminOrder.body.deliverFiles[0].fileId, deliveryId);
  assert.ok(!JSON.stringify(adminOrder.body).includes("oss-file:"));

  const evidenceId = await f.upload("customer", { purpose: "after-sale", orderId: "own" });
  Object.assign(f.collections.mediaFiles[evidenceId], { ownerKind: "admin", ownerId: "media-migration", status: "bound" });
  const internalId = await f.upload("service", { purpose: "after-sale", orderId: "own" });
  Object.assign(f.collections.mediaFiles[internalId], { ownerKind: "admin", ownerId: "media-migration", status: "bound" });
  f.collections.afterSales.legacy = { id: "legacy", orderId: "own", openid: "customer", status: "completed", reason: "历史客户凭证", attachments: [{ url: `oss-file:${evidenceId}` }], internalAttachmentFileIds: [internalId] };
  const tickets = await f.request("customer", "/api/rpc/getMyAfterSales", { orderId: "own" });
  assert.deepEqual(tickets.body.data[0].attachments.map((file) => file.fileId), [evidenceId]);
  assert.ok(!JSON.stringify(tickets.body).includes("oss-file:"));
  assert.equal((await f.request("customer", `/api/files/${evidenceId}/access`, {})).status, 200);
  assert.equal((await f.request("customer", `/api/files/${internalId}/access`, {})).status, 403);
  const adminTicket = await f.request("service", "/api/collection/afterSales/legacy");
  assert.deepEqual(adminTicket.body.attachmentFileIds, [evidenceId]);
  assert.deepEqual(adminTicket.body.internalAttachmentFileIds, [internalId]);

  const financeId = await f.upload("finance", { purpose: "finance", collection: "adjustmentRecords", orderId: "own" });
  f.collections.adjustmentRecords.legacy = { id: "legacy", orderId: "own", attachment: `oss-file:${financeId}` };
  const finance = await f.request("finance", "/api/collection/adjustmentRecords/legacy");
  assert.deepEqual(finance.body.attachmentFileIds, [financeId]);
  assert.equal(finance.body.attachments[0].fileId, financeId);
  assert.ok(!JSON.stringify(finance.body).includes("oss-file:"));
});

test("ready files cannot be deleted while a business binding is in flight", async (t) => {
  const f = await fixture(t);
  const id = await f.upload("photo", { purpose: "order-delivery", orderId: "own" });
  const originalUpdate = f.source.update.bind(f.source);
  let entered;
  let release;
  const arrived = new Promise((resolve) => { entered = resolve; });
  const resume = new Promise((resolve) => { release = resolve; });
  f.source.update = async (key, recordId, patch) => {
    if (key === "orders" && patch.deliveryDraftFileIds?.includes(id)) { entered(); await resume; }
    return originalUpdate(key, recordId, patch);
  };
  const binding = f.request("photo", "/api/orders/own/action", { action: "deliverydraft", fileIds: [id] });
  await arrived;
  let deletion;
  try { deletion = await f.request("photo", `/api/files/${id}`, undefined, "DELETE"); }
  finally { release(); }
  const bound = await binding;
  assert.equal(deletion.status, 409, "a verified object must survive the assertFiles-to-markBound interval");
  assert.equal(bound.status, 200);
  assert.equal(f.collections.mediaFiles[id].status, "bound");
  assert.deepEqual(f.collections.orders.own.deliveryDraftFileIds, [id]);
});

test("missing avatar ownership never grants private access to every logged-in customer", async (t) => {
  const f = await fixture(t);
  const id = await f.upload("customer", { purpose: "avatar" });
  delete f.collections.mediaFiles[id].ownerId;
  assert.equal((await f.request("stranger", `/api/files/${id}/access`, {})).status, 403);
});
