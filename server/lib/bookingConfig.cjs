"use strict";

const { normalizeRatio } = require("./orderWorkflow.cjs");
const own = (object, field) => Object.prototype.hasOwnProperty.call(object || {}, field);
const DEPOSIT_FIELDS = ["depositRatio", "depositRate", "depositPercent", "depositPercentage"];

// An explicit canonical null means inherit/clear. Never revive an old alias.
function configuredValue(object = {}, fields = []) {
  const field = fields.find((key) => own(object, key));
  return field === undefined ? undefined : object[field];
}
function empty(value) { return value === null || value === undefined || typeof value === "string" && !value.trim(); }
function validNumber(value, maximum = Infinity) {
  return ["number", "string"].includes(typeof value) && !empty(value)
    && Number.isFinite(Number(value)) && Number(value) >= 0 && Number(value) <= maximum;
}
function prepareDepositPatch(body, patch) {
  const field = DEPOSIT_FIELDS.find((key) => own(body, key));
  if (!field) return "";
  const value = body[field];
  if (!empty(value) && !validNumber(value, 100)) return "商品定金比例必须在 0 到 100% 之间";
  patch.depositRatio = empty(value) ? null : normalizeRatio(value);
  // Patch persistence merges fields; clear historical aliases explicitly.
  for (const alias of DEPOSIT_FIELDS.slice(1)) patch[alias] = null;
  return "";
}
function noticeText(value) {
  const lines = typeof value === "string" ? value.split(/\r?\n/) : Array.isArray(value) ? value : [];
  return lines.filter((line) => typeof line === "string").map((line) => line.trim()).filter(Boolean).join("\n");
}
function prepareSiteConfigPatch(body, previous = {}) {
  if (own(body, "customPrice")) {
    if (!body.customPrice || typeof body.customPrice !== "object" || Array.isArray(body.customPrice)) return "预约价格配置无效";
    const input = body.customPrice;
    const next = { ...(previous.customPrice || {}), ...input };
    for (const fields of [["single", "singlePersonPrice"], ["extraPerPerson", "perExtraPerson"]]) {
      if (!fields.some((field) => own(input, field))) continue;
      const value = configuredValue(input, fields);
      if (!empty(value) && (!validNumber(value) || fields[0] === "single" && Number(value) <= 0 || !Number.isSafeInteger(Math.round(Number(value) * 100)))) return "约拍定制单人价格必须大于 0，增员价格不得小于 0";
      next[fields[0]] = empty(value) ? null : Math.round(Number(value) * 100) / 100;
      next[fields[1]] = next[fields[0]];
    }
    if (DEPOSIT_FIELDS.some((field) => own(input, field))) {
      const value = configuredValue(input, DEPOSIT_FIELDS);
      if (!validNumber(value, 100)) return "全局定金比例必须在 0 到 100% 之间，且不能为空";
      next.depositRatio = normalizeRatio(value);
      for (const alias of DEPOSIT_FIELDS.slice(1)) next[alias] = null;
    }
    body.customPrice = next;
  }
  const changesNotice = own(body, "bookingNotice");
  const changesVersion = own(body, "bookingNoticeVersion");
  if (changesNotice || changesVersion) {
    if (changesNotice && !(typeof body.bookingNotice === "string" || Array.isArray(body.bookingNotice) && body.bookingNotice.every((line) => typeof line === "string"))) return "预约须知格式无效";
    const notice = noticeText(changesNotice ? body.bookingNotice : previous.bookingNotice);
    const version = changesVersion ? body.bookingNoticeVersion : previous.bookingNoticeVersion ?? previous.agreementVersion;
    if (!notice || typeof version !== "string" || !version.trim() || version.trim().length > 128) return "请填写预约须知正文和版本（不超过 128 个字符）";
    const previousNotice = noticeText(previous.bookingNotice);
    const previousVersion = String(previous.bookingNoticeVersion ?? previous.agreementVersion ?? "").trim();
    if (changesNotice && previousNotice && previousNotice !== notice && previousVersion && previousVersion === version.trim()) return "修改预约须知正文时，请更新须知版本";
    if (changesNotice) body.bookingNotice = notice.split("\n");
    body.bookingNoticeVersion = version.trim();
  }
  return "";
}

module.exports = { configuredValue, DEPOSIT_FIELDS, empty, validNumber, prepareDepositPatch, prepareSiteConfigPatch };
