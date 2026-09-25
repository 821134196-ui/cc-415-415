'use strict';

/** 全系统统一使用本地时间 ISO（不带时区后缀），避免时区换算歧义 */

function pad(n) { return String(n).padStart(2, '0'); }

/** Date -> 'YYYY-MM-DDTHH:mm:ss'（本地时间） */
function iso(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** Date -> 'YYYY-MM-DD' */
function dateStr(d = new Date()) { return iso(d).slice(0, 10); }

/** 把 'HH:MM' 时段落到指定日期上，得到本地 Date */
function slotDate(date, slot) { return new Date(`${date}T${slot}:00`); }

module.exports = { pad, iso, dateStr, slotDate };
