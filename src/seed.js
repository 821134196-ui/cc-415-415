'use strict';
/**
 * 演示数据（生物编号与读数均为演示数据）：
 *  - 投喂样例：4 个水槽的生效计划 + 今明两日投喂任务，昨日已完成/漏投记录
 *  - 停机样例：T-02 过滤器点检未通过 → 停机并冻结关联投喂计划
 *  - 复核样例：T-03 补录读数水温越界 → 复核处置任务；T-04 拒食观察；过期饲料
 */
const { iso, dateStr, slotDate } = require('./util');
const D = require('./domain');

/** 1x1 演示用点检照片（本地文件存储） */
const DEMO_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

function seedIfEmpty(db, now = new Date()) {
  const c = Number(db.prepare('SELECT COUNT(*) AS c FROM tanks').get().c);
  if (c > 0) return false;
  seed(db, now);
  return true;
}

function seed(db, now = new Date()) {
  const today = dateStr(now);
  const day = (n) => dateStr(new Date(now.getTime() + n * 86400000));
  const hoursAgo = (h) => iso(new Date(now.getTime() - h * 3600000));

  const ins = (sql, ...args) => Number(db.prepare(sql).run(...args).lastInsertRowid);

  // ---- 水槽 ----
  const t1 = ins(`INSERT INTO tanks (code, name, species, bio_count, feed_type, temp_min, temp_max)
                  VALUES ('T-01','珊瑚礁展示缸','小丑鱼 / 蓝吊',120,'磷虾颗粒',24,27)`);
  const t2 = ins(`INSERT INTO tanks (code, name, species, bio_count, feed_type, temp_min, temp_max)
                  VALUES ('T-02','海葵共生缸','奶嘴海葵 / 雀鲷',60,'丰年虾',25,28)`);
  const t3 = ins(`INSERT INTO tanks (code, name, species, bio_count, feed_type, temp_min, temp_max)
                  VALUES ('T-03','幼鱼培育缸','小丑鱼幼鱼',300,'藻片',25,28)`);
  const t4 = ins(`INSERT INTO tanks (code, name, species, bio_count, feed_type, temp_min, temp_max)
                  VALUES ('T-04','检疫隔离缸','新到蓝吊',25,'磷虾颗粒',24,27)`);

  // ---- 生物批次（演示编号） ----
  const bio = (code, tankId, species, count, introduced) => ins(
    `INSERT INTO bio_batches (batch_code, tank_id, species, count, introduced_at) VALUES (?,?,?,?,?)`,
    code, tankId, species, count, introduced);
  bio('BIO-2026-018', t1, '眼斑双锯鱼（小丑鱼）', 80, '2026-06-12T09:00:00');
  bio('BIO-2026-019', t1, '副刺尾鱼（蓝吊）', 40, '2026-06-20T09:00:00');
  bio('BIO-2026-022', t2, '奶嘴海葵', 20, '2026-07-02T10:00:00');
  bio('BIO-2026-023', t2, '青魔雀鲷', 40, '2026-07-02T10:00:00');
  bio('BIO-2026-025', t3, '小丑鱼幼鱼（自繁）', 300, '2026-08-15T08:30:00');
  bio('BIO-2026-028', t4, '副刺尾鱼（蓝吊，新到）', 25, '2026-09-20T14:00:00');

  // ---- 饲料批次 ----
  const fbKrillOld = ins(`INSERT INTO feed_batches (batch_code, feed_type, expiry_date, initial_qty_g, remaining_qty_g, status)
                          VALUES ('FEED-KRILL-2606','磷虾颗粒',?,4000,1600,'active')`, day(12));
  const fbKrillNew = ins(`INSERT INTO feed_batches (batch_code, feed_type, expiry_date, initial_qty_g, remaining_qty_g, status)
                          VALUES ('FEED-KRILL-2609','磷虾颗粒',?,5000,5000,'active')`, day(45));
  ins(`INSERT INTO feed_batches (batch_code, feed_type, expiry_date, initial_qty_g, remaining_qty_g, status)
       VALUES ('FEED-ART-2604','丰年虾',?,2000,450,'active')`, day(5)); // 临期 → 提醒
  const fbArt = ins(`INSERT INTO feed_batches (batch_code, feed_type, expiry_date, initial_qty_g, remaining_qty_g, status)
                     VALUES ('FEED-ART-2609','丰年虾',?,3000,3000,'active')`, day(50));
  ins(`INSERT INTO feed_batches (batch_code, feed_type, expiry_date, initial_qty_g, remaining_qty_g, status)
       VALUES ('FEED-ALG-2508','藻片',?,1500,300,'active')`, day(-1)); // 已过期 → 调度器生成异常
  const fbAlg = ins(`INSERT INTO feed_batches (batch_code, feed_type, expiry_date, initial_qty_g, remaining_qty_g, status)
                     VALUES ('FEED-ALG-2609','藻片',?,3000,3000,'active')`, day(60));

  // ---- 过滤/维生设备（平面图坐标为百分比） ----
  const eq = (tankId, code, kind, x, y) => ins(
    `INSERT INTO equipment (tank_id, device_code, kind, pos_x, pos_y, status) VALUES (?,?,?,?,?, 'running')`,
    tankId, code, kind, x, y);
  const flt1 = eq(t1, 'FLT-T01-1', 'filter', 16, 68);
  eq(t1, 'PMP-T01-1', 'pump', 84, 26);
  eq(t1, 'HTR-T01-1', 'heater', 50, 86);
  const flt2 = eq(t2, 'FLT-T02-1', 'filter', 18, 70);
  eq(t2, 'PMP-T02-1', 'pump', 82, 28);
  const flt3 = eq(t3, 'FLT-T03-1', 'filter', 20, 70);
  const flt4 = eq(t4, 'FLT-T04-1', 'filter', 50, 72);

  // ---- 投喂计划（T-02 演示版本变更：v1 已被 v2 取代） ----
  const p1 = D.createPlan(db, { tankId: t1, feedBatchId: fbKrillOld, doseG: 120, slots: ['08:30', '12:30', '17:30'], operator: '王芳' }, now);
  D.createPlan(db, { tankId: t2, feedBatchId: fbArt, doseG: 45, slots: ['09:00', '15:00'], operator: '王芳' }, now);
  const p2 = D.createPlan(db, { tankId: t2, feedBatchId: fbArt, doseG: 60, slots: ['09:00', '15:00'], operator: '李工' }, now);
  const p3 = D.createPlan(db, { tankId: t3, feedBatchId: fbAlg, doseG: 200, slots: ['08:00', '13:00', '18:00'], operator: '陈晨' }, now);
  D.createPlan(db, { tankId: t4, feedBatchId: fbKrillNew, doseG: 30, slots: ['10:00', '16:00'], operator: '陈晨' }, now);

  // ---- 生成昨日/今日/明日任务 ----
  const yesterday = day(-1);
  D.generateTasksForDate(db, yesterday);
  D.generateTasksForDate(db, today);
  D.generateTasksForDate(db, day(1));

  // ---- 投喂样例：昨日 T-01 两次完成（扣减饲料）、一次漏投 ----
  const doneAt = (date, slot) => new Date(slotDate(date, slot).getTime() + 6 * 60000);
  for (const slot of ['08:30', '12:30']) {
    const task = db.prepare(
      `SELECT * FROM feeding_tasks WHERE plan_id = ? AND scheduled_date = ? AND slot = ?`).get(p1.id, yesterday, slot);
    D.completeTaskByToken(db, task.scan_token, '王芳', doneAt(yesterday, slot));
  }
  const missedTask = db.prepare(
    `SELECT * FROM feeding_tasks WHERE plan_id = ? AND scheduled_date = ? AND slot = '17:30'`).get(p1.id, yesterday);
  D.markTaskMissed(db, missedTask, new Date(slotDate(yesterday, '17:30').getTime() + 45 * 60000));

  // ---- 停机样例：T-02 过滤器点检未通过 → 停机 + 冻结计划 ----
  D.recordInspection(db, {
    equipmentId: flt2, result: 'fail', inspector: '李工',
    notes: '轴承异响明显，立即停机检修', inspectedAt: hoursAgo(1),
  }, now);

  // ---- 其他设备近期点检通过（含一张演示照片） ----
  const fs = require('node:fs');
  const path = require('node:path');
  const uploadDir = path.join(__dirname, '..', 'uploads');
  fs.mkdirSync(uploadDir, { recursive: true });
  const photoName = 'demo-inspection-flt-t01.png';
  fs.writeFileSync(path.join(uploadDir, photoName), Buffer.from(DEMO_PNG_B64, 'base64'));
  for (const [eqId, inspector, note] of [
    [flt1, '王芳', '运行平稳，滤材正常'],
    [flt3, '陈晨', '流量正常'],
    [flt4, '陈晨', '新装设备，运行良好'],
  ]) {
    D.recordInspection(db, {
      equipmentId: eqId, result: 'pass', inspector, notes: note,
      photoPath: eqId === flt1 ? `/uploads/${photoName}` : null, inspectedAt: hoursAgo(3),
    }, now);
  }

  // ---- 复核样例：T-03 补录读数水温越界 → 复核处置任务 ----
  D.recordReading(db, {
    tankId: t3, deviceId: 'PROBE-T03-2', tempC: 29.4, ph: 8.1, doMgL: 6.2,
    collectedAt: hoursAgo(2), source: 'backfill', operator: '陈晨',
  }, now);

  // ---- 常规实时读数（演示数据） ----
  const readings = [
    [t1, 'PROBE-T01-1', 25.8, 8.2, 7.1], [t2, 'PROBE-T02-1', 26.4, 8.1, 6.8],
    [t3, 'PROBE-T03-1', 26.9, 8.0, 6.5], [t4, 'PROBE-T04-1', 25.2, 8.2, 7.4],
  ];
  for (const [tankId, dev, temp, ph, doo] of readings) {
    D.recordReading(db, {
      tankId, deviceId: dev, tempC: temp, ph, doMgL: doo,
      collectedAt: hoursAgo(0.5), source: 'live', operator: '在线监测',
    }, now);
  }

  // ---- 复核样例：T-04 拒食观察 ----
  D.recordRefusal(db, { tankId: t4, note: '晨投时蓝吊群明显拒食，残饵约八成，疑似运输应激', operator: '王芳' }, now);

  // ---- 过期饲料（FEED-ALG-2508） ----
  D.markExpiredFeeds(db, today, now);

  // ---- 交接样例 ----
  D.createHandover(db, {
    shift: '早班 → 中班', fromUser: '王芳', toUser: '李工',
    summary: 'T-02 过滤器检修中，关联投喂计划已冻结；T-03 水温偏高待复核；T-04 新到蓝吊晨投拒食，继续观察。',
  }, now);

  return { plans: { p1, p2, p3 } };
}

module.exports = { seed, seedIfEmpty };
