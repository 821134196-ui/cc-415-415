'use strict';
/**
 * 进程内调度器：周期性
 *  1. 为生效计划生成今/明日投喂任务（幂等）
 *  2. 超宽限期待执行任务 → 漏投 + 异常
 *  3. 过期饲料批次 → expired + 异常
 *  4. 刷新到期提醒（投喂/处置/临期饲料）
 */
const { dateStr } = require('./util');
const D = require('./domain');

function tick(db, now = new Date()) {
  const today = dateStr(now);
  const tomorrow = dateStr(new Date(now.getTime() + 86400000));
  D.generateTasksForDate(db, today);
  D.generateTasksForDate(db, tomorrow);
  D.markMissedTasks(db, now);
  D.markExpiredFeeds(db, today, now);
  D.refreshReminders(db, now);
}

function start(db, { intervalMs = 15000 } = {}) {
  tick(db);
  const timer = setInterval(() => {
    try { tick(db); } catch (e) { console.error('[scheduler] tick 失败:', e); }
  }, intervalMs);
  timer.unref();
  return { stop: () => clearInterval(timer), tick: (now) => tick(db, now) };
}

module.exports = { start, tick };
