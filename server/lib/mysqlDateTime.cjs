"use strict";

// Business DATETIME columns store Beijing civil time. Explicitly zoned input
// and JS Date instances represent instants; unzoned form values are civil time.
const SQL_TIME_ZONE = "+08:00";
const OFFSET_MS = 8 * 60 * 60 * 1000;

function invalidDateTime() {
  return Object.assign(new Error("数据库日期时间格式无效"), { code: "DATA_DATETIME_INVALID" });
}

function normalizeDateTime(value) {
  if (value == null || typeof value === "string" && !value.trim()) return null;
  let milliseconds;
  if (value instanceof Date) milliseconds = value.getTime();
  else {
    if (typeof value !== "string") throw invalidDateTime();
    const match = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,6}))?)?)?(Z|[+-]\d{2}:\d{2})?$/i.exec(value.trim());
    if (!match) throw invalidDateTime();
    const [, year, month, day, hour = "00", minute = "00", second = "00", fraction = "", zone] = match;
    if (Number(year) < 1000 || Number(month) < 1 || Number(month) > 12 || Number(day) < 1
      || Number(day) > new Date(Date.UTC(Number(year), Number(month), 0)).getUTCDate()
      || Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59 || zone && !match[4]) throw invalidDateTime();
    milliseconds = Date.parse(`${year}-${month}-${day}T${hour}:${minute}:${second}${fraction ? "." + fraction : ""}${zone || SQL_TIME_ZONE}`);
  }
  if (!Number.isFinite(milliseconds)) throw invalidDateTime();
  const shifted = new Date(milliseconds + OFFSET_MS);
  if (!Number.isFinite(shifted.getTime())) throw invalidDateTime();
  const civil = shifted.toISOString().slice(0, 19).replace("T", " ");
  if (!/^[1-9]\d{3}-/.test(civil)) throw invalidDateTime();
  // The current business DATETIME columns have second precision.
  return civil;
}

module.exports = { SQL_TIME_ZONE, normalizeDateTime };
