// 表单校验工具。当前阶段先提供通用基础能力，后续表单迁移时复用。
function isRequired(value) {
  return value !== undefined && value !== null && String(value).trim() !== "";
}

function toNumber(value, fallback = 0) {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : fallback;
}