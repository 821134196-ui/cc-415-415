'use strict';
/**
 * 核心规则测试（node --test）：
 *  剂量边界 / 饲料扣减 / 计划版本 / 重复扫码 / 异常冻结
 *  另覆盖：漏投、饲料过期、补录读数校验、拒食异常
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { open } = require('../src/db');
const D = require('../src/domain');
const { iso, dateStr, slotDate } = require('../src/util');

const NOW = new Date('2026-09-25T12:00:00');
const TODAY = dateStr(NOW);

/** 每个用例一套全新的内存库 + 基础夹具：100 尾水槽（剂量上限 200g）+ 1000g 饲料批次 */
function fixtures() {
  const db = open(':memory:');
  const tankId = Number(db.prepare(
    `INSERT INTO tanks (code, name, species, bio_count, feed_type, temp_min, temp_max)
     VALUES ('T-01','测试缸','小丑鱼',100,'磷虾颗粒',24,28)`).run().lastInsertRowid);
  const feedId = Number(db.prepare(
    `INSERT INTO feed_batches (batch_code, feed_type, expiry_date, initial_qty_g, remaining_qty_g, status)
     VALUES ('FB-1','磷虾颗粒','2099-01-01',1000,1000,'active')`).run().lastInsertRowid);
  const eqId = Number(db.prepare(
    `INSERT INTO equipment (tank_id, device_code, kind, pos_x, pos_y, status)
     VALUES (?, 'FLT-T01-1', 'filter', 50, 50, 'running')`).run(tankId).lastInsertRowid);
  return { db, tankId, feedId, eqId };
}

function makePlan(db, tankId, feedId, doseG = 100, slots = ['08:30', '17:30']) {
  return D.createPlan(db, { tankId, feedBatchId: feedId, doseG, slots, operator: '测试' }, NOW);
}

function firstTask(db, planId, date = TODAY, slot = '08:30') {
  return db.prepare('SELECT * FROM feeding_tasks WHERE plan_id = ? AND scheduled_date = ? AND slot = ?')
    .get(planId, date, slot);
}

function feedRemaining(db, feedId) {
  return db.prepare('SELECT remaining_qty_g FROM feed_batches WHERE id = ?').get(feedId).remaining_qty_g;
}

// ---------- 剂量边界 ----------

test('剂量边界：0、负数、低于下限、超上限、非数字均被拒绝', () => {
  const { db, tankId, feedId } = fixtures();
  const cases = [
    [0, 'DOSE_TOO_SMALL'],
    [-5, 'DOSE_TOO_SMALL'],
    [0.49, 'DOSE_TOO_SMALL'],
    [200.01, 'DOSE_TOO_LARGE'],   // 上限 = 100 尾 × 2g = 200g
    [5000.01, 'DOSE_TOO_LARGE'],
    [NaN, 'DOSE_INVALID'],
    ['50', 'DOSE_INVALID'],
  ];
  for (const [dose, code] of cases) {
    assert.throws(
      () => D.createPlan(db, { tankId, feedBatchId: feedId, doseG: dose, slots: ['08:30'] }, NOW),
      (e) => e.name === 'DomainError' && e.code === code,
      `dose=${dose} 应抛出 ${code}`);
  }
});

test('剂量边界：下限 0.5g 与上限 200g 恰可通过', () => {
  const { db, tankId, feedId } = fixtures();
  const p1 = makePlan(db, tankId, feedId, 0.5);
  assert.equal(p1.dose_g, 0.5);
  const p2 = D.createPlan(db, { tankId, feedBatchId: feedId, doseG: 200, slots: ['08:30'], operator: '测试' }, NOW);
  assert.equal(p2.dose_g, 200);
  assert.equal(p2.version, 2);
});

test('剂量边界：时段为空、格式错误、超过 6 个被拒绝', () => {
  const { db, tankId, feedId } = fixtures();
  assert.throws(() => makePlan(db, tankId, feedId, 100, []), /至少配置一个投喂时段/);
  assert.throws(() => makePlan(db, tankId, feedId, 100, ['8点半']), /HH:MM/);
  assert.throws(() => makePlan(db, tankId, feedId, 100, ['25:00']), /HH:MM/);
  assert.throws(() => makePlan(db, tankId, feedId, 100, ['01:00','02:00','03:00','04:00','05:00','06:00','07:00']), /最多 6 个/);
});

// ---------- 饲料扣减 ----------

test('饲料扣减：仅在任务完成时扣减，生成任务与漏投均不扣减', () => {
  const { db, tankId, feedId } = fixtures();
  const plan = makePlan(db, tankId, feedId, 100);
  D.generateTasksForDate(db, TODAY);
  assert.equal(feedRemaining(db, feedId), 1000, '生成任务不应扣减');

  const t1 = firstTask(db, plan.id);
  D.completeTaskByToken(db, t1.scan_token, '测试员', NOW);
  assert.equal(feedRemaining(db, feedId), 900, '完成后扣减 100g');

  // 让 17:30 任务漏投
  D.markMissedTasks(db, new Date('2026-09-25T18:30:00'));
  assert.equal(feedRemaining(db, feedId), 900, '漏投不应扣减');
});

test('饲料扣减：余量不足拒绝完成且不扣减；余量恰好相等可完成并置为用尽', () => {
  const { db, tankId, feedId } = fixtures();
  db.prepare(`UPDATE feed_batches SET remaining_qty_g = 150 WHERE id = ?`).run(feedId);
  const plan = makePlan(db, tankId, feedId, 100);
  D.generateTasksForDate(db, TODAY);

  const t1 = firstTask(db, plan.id);
  D.completeTaskByToken(db, t1.scan_token, '甲', NOW);
  assert.equal(feedRemaining(db, feedId), 50);

  const t2 = firstTask(db, plan.id, TODAY, '17:30');
  assert.throws(() => D.completeTaskByToken(db, t2.scan_token, '乙', NOW),
    (e) => e.code === 'FEED_INSUFFICIENT');
  assert.equal(feedRemaining(db, feedId), 50, '失败不得扣减');
  assert.equal(firstTask(db, plan.id, TODAY, '17:30').status, 'pending', '任务保持待执行');

  // 补足到恰好 100g
  db.prepare(`UPDATE feed_batches SET remaining_qty_g = 100 WHERE id = ?`).run(feedId);
  D.completeTaskByToken(db, t2.scan_token, '乙', NOW);
  assert.equal(feedRemaining(db, feedId), 0);
  assert.equal(db.prepare('SELECT status FROM feed_batches WHERE id = ?').get(feedId).status, 'depleted');
});

// ---------- 计划版本 ----------

test('计划版本：变更保留历史版本，已执行任务按快照结算不重算', () => {
  const { db, tankId, feedId } = fixtures();
  const v1 = makePlan(db, tankId, feedId, 100);
  D.generateTasksForDate(db, TODAY);
  const done = firstTask(db, v1.id);
  D.completeTaskByToken(db, done.scan_token, '甲', NOW);   // v1 已执行任务
  assert.equal(feedRemaining(db, feedId), 900);

  // 变更计划 → v2
  const v2 = D.createPlan(db, { tankId, feedBatchId: feedId, doseG: 150, slots: ['09:00'], operator: '乙' }, NOW);
  assert.equal(v2.version, 2);
  assert.equal(db.prepare('SELECT status FROM feeding_plans WHERE id = ?').get(v1.id).status, 'superseded');
  assert.equal(db.prepare('SELECT status FROM feeding_plans WHERE id = ?').get(v2.id).status, 'active');

  // 已执行任务快照不变（剂量、版本、批次），不重算
  const doneAfter = db.prepare('SELECT * FROM feeding_tasks WHERE id = ?').get(done.id);
  assert.equal(doneAfter.status, 'completed');
  assert.equal(doneAfter.dose_g, 100);
  assert.equal(doneAfter.plan_version, 1);
  assert.equal(feedRemaining(db, feedId), 900, '历史扣减不因计划变更重算');

  // v1 未执行任务被取消；新任务来自 v2
  assert.equal(firstTask(db, v1.id, TODAY, '17:30').status, 'cancelled');
  D.generateTasksForDate(db, TODAY);
  const nt = db.prepare('SELECT * FROM feeding_tasks WHERE plan_id = ? AND scheduled_date = ?').get(v2.id, TODAY);
  assert.equal(nt.dose_g, 150);
  assert.equal(nt.plan_version, 2);
});

// ---------- 重复扫码 ----------

test('重复扫码：同一令牌不重复完成、不重复扣减；未知令牌 404', () => {
  const { db, tankId, feedId } = fixtures();
  const plan = makePlan(db, tankId, feedId, 100);
  D.generateTasksForDate(db, TODAY);
  const task = firstTask(db, plan.id);

  const r1 = D.completeTaskByToken(db, task.scan_token, '甲', NOW);
  assert.equal(r1.idempotent, false);
  assert.equal(feedRemaining(db, feedId), 900);

  const r2 = D.completeTaskByToken(db, task.scan_token, '乙', new Date('2026-09-25T12:05:00'));
  assert.equal(r2.idempotent, true, '第二次扫码返回幂等结果');
  assert.equal(r2.task.completed_by, '甲', '完成人不被覆盖');
  assert.equal(feedRemaining(db, feedId), 900, '饲料只扣减一次');

  const completed = db.prepare(`SELECT COUNT(*) c FROM feeding_tasks WHERE status = 'completed'`).get().c;
  assert.equal(Number(completed), 1, '不会重复生成完成记录');

  assert.throws(() => D.completeTaskByToken(db, 'SCAN-NOPE-1', '甲', NOW), (e) => e.status === 404);
});

// ---------- 异常冻结 ----------

test('异常冻结：点检未通过冻结关联计划与待执行任务，复检通过解冻', () => {
  const { db, tankId, feedId, eqId } = fixtures();
  const plan = makePlan(db, tankId, feedId, 100);
  const tomorrow = dateStr(new Date(NOW.getTime() + 86400000));
  D.generateTasksForDate(db, tomorrow);

  // 未通过 → 停机 + 冻结
  D.recordInspection(db, { equipmentId: eqId, result: 'fail', inspector: '李工', notes: '轴承异响' }, NOW);
  assert.equal(db.prepare('SELECT status FROM equipment WHERE id = ?').get(eqId).status, 'stopped');
  assert.equal(db.prepare('SELECT status FROM feeding_plans WHERE id = ?').get(plan.id).status, 'frozen');
  const frozen = db.prepare(`SELECT COUNT(*) c FROM feeding_tasks WHERE plan_id = ? AND status = 'frozen'`).get(plan.id).c;
  assert.equal(Number(frozen), 2, '两个时段的待执行任务均被冻结');

  const an = db.prepare(`SELECT * FROM anomalies WHERE kind = 'filter_stop' AND status = 'open'`).get();
  assert.ok(an, '生成停机异常');
  const handling = db.prepare('SELECT * FROM handling_tasks WHERE anomaly_id = ?').get(an.id);
  assert.ok(handling, '生成处置任务');

  // 冻结任务不能扫码完成
  const task = db.prepare(`SELECT * FROM feeding_tasks WHERE plan_id = ? AND status = 'frozen' LIMIT 1`).get(plan.id);
  assert.throws(() => D.completeTaskByToken(db, task.scan_token, '甲', NOW), (e) => e.status === 409);
  assert.equal(feedRemaining(db, feedId), 1000, '冻结期间无扣减');

  // 复检通过 → 解冻（明日任务恢复待执行）
  D.recordInspection(db, { equipmentId: eqId, result: 'pass', inspector: '李工', notes: '已更换轴承' }, NOW);
  assert.equal(db.prepare('SELECT status FROM equipment WHERE id = ?').get(eqId).status, 'running');
  assert.equal(db.prepare('SELECT status FROM feeding_plans WHERE id = ?').get(plan.id).status, 'active');
  const pending = db.prepare(`SELECT COUNT(*) c FROM feeding_tasks WHERE plan_id = ? AND status = 'pending'`).get(plan.id).c;
  assert.equal(Number(pending), 2);
  assert.equal(db.prepare(`SELECT status FROM anomalies WHERE id = ?`).get(an.id).status, 'resolved', '停机异常自动解除');
});

// ---------- 漏投 / 过期 / 补录 / 拒食 ----------

test('漏投：超过宽限期记漏投并生成异常，漏投任务不能完成', () => {
  const { db, tankId, feedId } = fixtures();
  const plan = makePlan(db, tankId, feedId, 100);
  D.generateTasksForDate(db, TODAY);
  const n = D.markMissedTasks(db, new Date('2026-09-25T23:00:00'));
  assert.equal(n, 2);
  const an = db.prepare(`SELECT COUNT(*) c FROM anomalies WHERE kind = 'missed_feeding'`).get().c;
  assert.equal(Number(an), 2, '每个漏投任务各生成一条异常');
  const task = firstTask(db, plan.id);
  assert.equal(task.status, 'missed');
  assert.throws(() => D.completeTaskByToken(db, task.scan_token, '甲'), (e) => e.status === 409);
  assert.equal(feedRemaining(db, feedId), 1000);
});

test('饲料过期：批次置为过期并生成异常，过期批次禁止投喂', () => {
  const { db, tankId, feedId } = fixtures();
  db.prepare(`UPDATE feed_batches SET expiry_date = '2026-09-24' WHERE id = ?`).run(feedId);
  const plan = makePlan(db, tankId, feedId, 100);
  D.generateTasksForDate(db, TODAY);
  const marked = D.markExpiredFeeds(db, TODAY, NOW);
  assert.equal(marked, 1);
  assert.equal(db.prepare('SELECT status FROM feed_batches WHERE id = ?').get(feedId).status, 'expired');
  assert.ok(db.prepare(`SELECT * FROM anomalies WHERE kind = 'feed_expired'`).get());
  const task = firstTask(db, plan.id);
  assert.throws(() => D.completeTaskByToken(db, task.scan_token, '甲', NOW), (e) => e.code === 'FEED_EXPIRED');
  assert.equal(feedRemaining(db, feedId), 1000);
});

test('补录读数：必须保留采集时间与设备编号；水温越界生成异常且当日去重', () => {
  const { db, tankId } = fixtures();
  assert.throws(
    () => D.recordReading(db, { tankId, deviceId: '', tempC: 26, collectedAt: iso(NOW), source: 'backfill' }, NOW),
    (e) => e.code === 'DEVICE_REQUIRED');
  assert.throws(
    () => D.recordReading(db, { tankId, deviceId: 'PROBE-1', tempC: 26, collectedAt: '', source: 'backfill' }, NOW),
    (e) => e.code === 'COLLECTED_AT_REQUIRED');

  const r = D.recordReading(db, {
    tankId, deviceId: 'PROBE-1', tempC: 29.5, collectedAt: '2026-09-25T08:00:00', source: 'backfill', operator: '甲',
  }, NOW);
  assert.ok(r.anomaly, '越界生成水温异常');
  assert.equal(r.reading.device_id, 'PROBE-1');
  assert.equal(r.reading.collected_at, '2026-09-25T08:00:00', '采集时间原样保留');
  assert.equal(r.reading.source, 'backfill');

  // 同日同水槽再次越界 → 去重，不重复生成
  const r2 = D.recordReading(db, {
    tankId, deviceId: 'PROBE-1', tempC: 29.8, collectedAt: '2026-09-25T09:00:00', source: 'backfill',
  }, NOW);
  assert.equal(r2.anomaly.id, r.anomaly.id);
  const c = db.prepare(`SELECT COUNT(*) c FROM anomalies WHERE kind = 'temp'`).get().c;
  assert.equal(Number(c), 1);
});

test('拒食观察：生成异常与处置任务', () => {
  const { db, tankId } = fixtures();
  const { anomaly, created } = D.recordRefusal(db, { tankId, note: '残饵八成', operator: '甲' }, NOW);
  assert.ok(created);
  assert.equal(anomaly.kind, 'refusal');
  const h = db.prepare('SELECT * FROM handling_tasks WHERE anomaly_id = ?').get(anomaly.id);
  assert.ok(h);
  assert.equal(h.status, 'open');
});
