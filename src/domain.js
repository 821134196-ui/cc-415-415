'use strict';
/**
 * 领域逻辑：
 *  - 投喂计划版本化（变更保留历史，已执行任务按快照结算、绝不重算）
 *  - 投喂任务扫码完成（幂等：重复扫码不重复完成、不重复扣减）
 *  - 饲料批次：仅在任务完成时扣减剩余量；过期批次禁止投喂
 *  - 水质读数：补录必须保留采集时间与设备编号；水温越界生成异常
 *  - 设备点检：未通过 → 停机并冻结关联投喂计划；复检通过 → 解冻
 *  - 五类异常（水温/停机/拒食/饲料过期/漏投）各自生成处置任务
 *  - 交接班摘要、进程内到期提醒
 */
const { iso, dateStr, slotDate } = require('./util');

class DomainError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'DomainError';
    this.status = status;
    this.code = code;
  }
}

/** 剂量边界：单次下限、绝对上限、按生物数量的每尾上限 */
const DOSE = { MIN_G: 0.5, MAX_G: 5000, MAX_G_PER_ORG: 2.0 };
/** 投喂宽限期：超过时段 30 分钟仍未完成记为漏投 */
const GRACE_MINUTES = 30;
const REMIND_FEEDING_MIN = 15;   // 投喂到期提醒窗口
const REMIND_HANDLING_MIN = 60;  // 处置任务到期提醒窗口
const FEED_EXPIRING_DAYS = 7;    // 饲料临期提醒窗口

const ANOMALY_KINDS = {
  temp: '水温异常',
  filter_stop: '过滤器停机',
  refusal: '生物拒食',
  feed_expired: '饲料过期',
  missed_feeding: '漏投',
};
const TASK_STATUS_TEXT = {
  pending: '待执行', completed: '已完成', missed: '已漏投', frozen: '已冻结', cancelled: '已取消',
};

// ---------- 基础工具 ----------

const TX_FLAG = Symbol('tx');
/** 可重入事务：嵌套调用复用外层事务 */
function tx(db, fn) {
  if (db[TX_FLAG]) return fn();
  db[TX_FLAG] = true;
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* 连接已坏时忽略 */ }
    throw e;
  } finally {
    db[TX_FLAG] = false;
  }
}

const one = (db, sql, ...args) => db.prepare(sql).get(...args);
const all = (db, sql, ...args) => db.prepare(sql).all(...args);
const run = (db, sql, ...args) => db.prepare(sql).run(...args);

function maxDoseForTank(tank) {
  return Math.min(DOSE.MAX_G, Math.round(tank.bio_count * DOSE.MAX_G_PER_ORG * 100) / 100);
}

function assertDose(doseG, tank) {
  if (typeof doseG !== 'number' || !Number.isFinite(doseG)) {
    throw new DomainError(422, 'DOSE_INVALID', '单次剂量必须是有效数字');
  }
  if (doseG < DOSE.MIN_G) {
    throw new DomainError(422, 'DOSE_TOO_SMALL', `单次剂量 ${doseG}g 低于下限 ${DOSE.MIN_G}g`);
  }
  const max = maxDoseForTank(tank);
  if (doseG > max) {
    throw new DomainError(422, 'DOSE_TOO_LARGE',
      `单次剂量 ${doseG}g 超过上限 ${max}g（${tank.bio_count} 尾 × ${DOSE.MAX_G_PER_ORG}g/尾）`);
  }
}

function normalizeSlots(slots) {
  if (typeof slots === 'string') slots = slots.split(/[,，、\s]+/).filter(Boolean);
  if (!Array.isArray(slots) || slots.length === 0) {
    throw new DomainError(422, 'SLOTS_EMPTY', '至少配置一个投喂时段');
  }
  const clean = [...new Set(slots.map((s) => String(s).trim()))];
  if (clean.length > 6) throw new DomainError(422, 'SLOTS_TOO_MANY', '每日投喂时段最多 6 个');
  for (const s of clean) {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(s)) {
      throw new DomainError(422, 'SLOT_INVALID', `时段「${s}」格式应为 HH:MM`);
    }
  }
  return clean.sort();
}

// ---------- 异常与处置任务 ----------

function hasOpenAnomaly(db, refKey) {
  return !!one(db, `SELECT id FROM anomalies WHERE ref_key = ? AND status != 'resolved'`, refKey);
}

/** 生成异常并联动创建处置任务；dedupeKey 命中时返回已有异常（幂等） */
function createAnomaly(db, { kind, tankId = null, refKey = '', dedupeKey, detail, handlingTitle, dueMinutes = 120 }, now = new Date()) {
  return tx(db, () => {
    if (dedupeKey) {
      const existing = one(db, 'SELECT * FROM anomalies WHERE dedupe_key = ?', dedupeKey);
      if (existing) return { anomaly: existing, created: false };
    }
    const r = run(db,
      `INSERT INTO anomalies (kind, tank_id, ref_key, status, detail, dedupe_key, created_at)
       VALUES (?,?,?, 'open', ?, ?, ?)`,
      kind, tankId, refKey, detail, dedupeKey || null, iso(now));
    const anomalyId = Number(r.lastInsertRowid);
    run(db,
      `INSERT INTO handling_tasks (anomaly_id, title, status, due_at) VALUES (?,?, 'open', ?)`,
      anomalyId, handlingTitle, iso(new Date(now.getTime() + dueMinutes * 60000)));
    return { anomaly: one(db, 'SELECT * FROM anomalies WHERE id = ?', anomalyId), created: true };
  });
}

// ---------- 投喂计划（版本化） ----------

/**
 * 创建/变更投喂计划：旧版本置为 superseded，新版本 version+1。
 * 旧计划未执行的任务取消；已执行（completed/missed）任务保留快照，绝不重算。
 */
function createPlan(db, { tankId, feedBatchId, doseG, slots, operator }, now = new Date()) {
  const tank = one(db, 'SELECT * FROM tanks WHERE id = ?', tankId);
  if (!tank) throw new DomainError(404, 'TANK_NOT_FOUND', '水槽不存在');
  assertDose(doseG, tank);
  const cleanSlots = normalizeSlots(slots);
  const batch = one(db, 'SELECT * FROM feed_batches WHERE id = ?', feedBatchId);
  if (!batch) throw new DomainError(404, 'FEED_NOT_FOUND', '饲料批次不存在');
  if (batch.status !== 'active') {
    throw new DomainError(409, 'FEED_NOT_ACTIVE', `饲料批次 ${batch.batch_code} 状态为「${batch.status}」，不可用于新计划`);
  }
  if (batch.feed_type !== tank.feed_type) {
    throw new DomainError(422, 'FEED_TYPE_MISMATCH',
      `水槽 ${tank.code} 配置饲料为「${tank.feed_type}」，与批次「${batch.feed_type}」不符`);
  }
  return tx(db, () => {
    const cur = one(db,
      `SELECT * FROM feeding_plans WHERE tank_id = ? AND status IN ('active','frozen')
       ORDER BY version DESC LIMIT 1`, tankId);
    const version = cur ? cur.version + 1 : 1;
    if (cur) {
      run(db, `UPDATE feeding_plans SET status = 'superseded' WHERE id = ?`, cur.id);
      run(db, `UPDATE feeding_tasks SET status = 'cancelled' WHERE plan_id = ? AND status IN ('pending','frozen')`, cur.id);
    }
    const r = run(db,
      `INSERT INTO feeding_plans (tank_id, version, feed_batch_id, dose_g, slots, status, created_at, created_by)
       VALUES (?,?,?,?,?, 'active', ?, ?)`,
      tankId, version, feedBatchId, doseG, JSON.stringify(cleanSlots), iso(now), operator || '系统');
    return one(db, 'SELECT * FROM feeding_plans WHERE id = ?', Number(r.lastInsertRowid));
  });
}

function listPlans(db, tankId) {
  const rows = tankId
    ? all(db, 'SELECT * FROM feeding_plans WHERE tank_id = ? ORDER BY version DESC', tankId)
    : all(db, 'SELECT * FROM feeding_plans ORDER BY tank_id, version DESC');
  return rows.map((p) => ({ ...p, slots: JSON.parse(p.slots) }));
}

// ---------- 投喂任务 ----------

/** 为所有生效计划生成某日任务（INSERT OR IGNORE，幂等可重复调用） */
function generateTasksForDate(db, date) {
  const plans = all(db, `SELECT * FROM feeding_plans WHERE status = 'active'`);
  let created = 0;
  for (const plan of plans) {
    for (const slot of JSON.parse(plan.slots)) {
      const token = `SCAN-${plan.id}-${date}-${slot.replace(':', '')}`;
      const r = run(db,
        `INSERT OR IGNORE INTO feeding_tasks
           (plan_id, plan_version, tank_id, feed_batch_id, dose_g, slot, scheduled_date, status, scan_token)
         VALUES (?,?,?,?,?,?,?, 'pending', ?)`,
        plan.id, plan.version, plan.tank_id, plan.feed_batch_id, plan.dose_g, slot, date, token);
      created += Number(r.changes);
    }
  }
  return created;
}

/**
 * 扫码完成投喂任务（幂等）：
 *  - 重复扫码返回已有结果，不重复完成、不重复扣减饲料
 *  - 仅在完成时扣减批次剩余量（条件更新防超扣）
 */
function completeTaskByToken(db, token, operator, now = new Date()) {
  if (!token || !String(token).trim()) throw new DomainError(400, 'TOKEN_REQUIRED', '缺少扫码令牌');
  return tx(db, () => {
    const task = one(db, 'SELECT * FROM feeding_tasks WHERE scan_token = ?', String(token).trim());
    if (!task) throw new DomainError(404, 'TOKEN_UNKNOWN', '扫码令牌无效：找不到对应投喂任务');
    if (task.status === 'completed') {
      const batch0 = one(db, 'SELECT batch_code, remaining_qty_g FROM feed_batches WHERE id = ?', task.feed_batch_id);
      return { task, idempotent: true, feed: batch0, message: '该任务此前已完成，本次扫码未重复扣减' };
    }
    if (task.status !== 'pending') {
      throw new DomainError(409, 'TASK_NOT_PENDING',
        `任务状态为「${TASK_STATUS_TEXT[task.status] || task.status}」，不能执行完成操作`);
    }
    const batch = one(db, 'SELECT * FROM feed_batches WHERE id = ?', task.feed_batch_id);
    if (!batch) throw new DomainError(409, 'FEED_MISSING', '任务关联的饲料批次不存在');
    if (batch.status === 'expired') {
      throw new DomainError(409, 'FEED_EXPIRED', `饲料批次 ${batch.batch_code} 已过期，禁止投喂`);
    }
    if (batch.remaining_qty_g + 1e-9 < task.dose_g) {
      throw new DomainError(422, 'FEED_INSUFFICIENT',
        `批次 ${batch.batch_code} 剩余 ${batch.remaining_qty_g}g，不足本次剂量 ${task.dose_g}g`);
    }
    const upd = run(db,
      `UPDATE feed_batches SET remaining_qty_g = ROUND(remaining_qty_g - ?, 3)
       WHERE id = ? AND remaining_qty_g >= ?`, task.dose_g, batch.id, task.dose_g);
    if (Number(upd.changes) !== 1) throw new DomainError(422, 'FEED_INSUFFICIENT', '饲料余量不足，扣减失败');
    run(db, `UPDATE feed_batches SET status = 'depleted' WHERE id = ? AND remaining_qty_g <= 0`, batch.id);
    run(db,
      `UPDATE feeding_tasks SET status = 'completed', completed_at = ?, completed_by = ?
       WHERE id = ? AND status = 'pending'`, iso(now), operator || '未署名', task.id);
    const done = one(db, 'SELECT * FROM feeding_tasks WHERE id = ?', task.id);
    const feed = one(db, 'SELECT batch_code, remaining_qty_g FROM feed_batches WHERE id = ?', batch.id);
    return { task: done, idempotent: false, feed, message: `投喂完成，批次 ${batch.batch_code} 扣减 ${task.dose_g}g` };
  });
}

/** 单条任务记漏投并生成异常（内部使用） */
function markTaskMissed(db, task, now = new Date()) {
  tx(db, () => {
    const r = run(db,
      `UPDATE feeding_tasks SET status = 'missed' WHERE id = ? AND status IN ('pending','frozen')`, task.id);
    if (Number(r.changes) !== 1) return;
    const tank = one(db, 'SELECT code FROM tanks WHERE id = ?', task.tank_id);
    createAnomaly(db, {
      kind: 'missed_feeding',
      tankId: task.tank_id,
      refKey: `tank:${task.tank_id}:missed`,
      dedupeKey: `missed:${task.id}`,
      detail: `${tank ? tank.code : task.tank_id} ${task.scheduled_date} ${task.slot} 时段漏投（计划 v${task.plan_version}，${task.dose_g}g）`,
      handlingTitle: `补投或确认 ${task.scheduled_date} ${task.slot} 漏投`,
      dueMinutes: 240,
    }, now);
  });
}

/** 调度器：超过宽限期的待执行任务记漏投 */
function markMissedTasks(db, now = new Date(), graceMinutes = GRACE_MINUTES) {
  const rows = all(db, `SELECT * FROM feeding_tasks WHERE status = 'pending'`);
  let n = 0;
  for (const t of rows) {
    if (slotDate(t.scheduled_date, t.slot).getTime() + graceMinutes * 60000 < now.getTime()) {
      markTaskMissed(db, t, now);
      n += 1;
    }
  }
  return n;
}

// ---------- 饲料批次 ----------

function createFeedBatch(db, { batchCode, feedType, expiryDate, initialQtyG }) {
  if (!batchCode || !String(batchCode).trim()) throw new DomainError(422, 'BATCH_CODE_REQUIRED', '批次号必填');
  if (!feedType || !String(feedType).trim()) throw new DomainError(422, 'FEED_TYPE_REQUIRED', '饲料类型必填');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(expiryDate || ''))) {
    throw new DomainError(422, 'EXPIRY_INVALID', '有效期格式应为 YYYY-MM-DD');
  }
  const qty = Number(initialQtyG);
  if (!Number.isFinite(qty) || qty <= 0) throw new DomainError(422, 'QTY_INVALID', '初始数量必须为正数');
  const r = run(db,
    `INSERT INTO feed_batches (batch_code, feed_type, expiry_date, initial_qty_g, remaining_qty_g, status)
     VALUES (?,?,?,?,?, 'active')`,
    String(batchCode).trim(), String(feedType).trim(), expiryDate, qty, qty);
  return one(db, 'SELECT * FROM feed_batches WHERE id = ?', Number(r.lastInsertRowid));
}

/** 调度器：过期批次置为 expired 并生成异常 */
function markExpiredFeeds(db, today = dateStr(), now = new Date()) {
  const rows = all(db, `SELECT * FROM feed_batches WHERE status = 'active' AND expiry_date < ?`, today);
  for (const b of rows) {
    tx(db, () => {
      run(db, `UPDATE feed_batches SET status = 'expired' WHERE id = ? AND status = 'active'`, b.id);
      createAnomaly(db, {
        kind: 'feed_expired',
        refKey: `feed:${b.id}`,
        dedupeKey: `feedexp:${b.id}`,
        detail: `饲料批次 ${b.batch_code}（${b.feed_type}）已于 ${b.expiry_date} 过期，剩余 ${b.remaining_qty_g}g`,
        handlingTitle: `下架并销毁过期饲料 ${b.batch_code}`,
        dueMinutes: 720,
      }, now);
    });
  }
  return rows.length;
}

// ---------- 水质读数 ----------

/** 录入读数；补录（backfill）与实时读数一样必须保留采集时间与设备编号 */
function recordReading(db, { tankId, deviceId, tempC, ph = null, doMgL = null, collectedAt, source = 'live', operator = null }, now = new Date()) {
  const tank = one(db, 'SELECT * FROM tanks WHERE id = ?', tankId);
  if (!tank) throw new DomainError(404, 'TANK_NOT_FOUND', '水槽不存在');
  if (!deviceId || !String(deviceId).trim()) {
    throw new DomainError(422, 'DEVICE_REQUIRED', '必须填写采集设备编号（补录读数同样要求）');
  }
  if (!collectedAt || !String(collectedAt).trim()) {
    throw new DomainError(422, 'COLLECTED_AT_REQUIRED', '必须保留读数采集时间（补录读数同样要求）');
  }
  const collected = new Date(collectedAt);
  if (Number.isNaN(collected.getTime())) throw new DomainError(422, 'COLLECTED_AT_INVALID', '采集时间格式无效');
  if (typeof tempC !== 'number' || !Number.isFinite(tempC)) {
    throw new DomainError(422, 'TEMP_INVALID', '水温必须是有效数字');
  }
  if (!['live', 'backfill'].includes(source)) throw new DomainError(422, 'SOURCE_INVALID', '读数来源无效');
  return tx(db, () => {
    const r = run(db,
      `INSERT INTO water_readings (tank_id, device_id, temp_c, ph, do_mg_l, collected_at, recorded_at, source, operator)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      tankId, String(deviceId).trim(), tempC, ph, doMgL, iso(collected), iso(now), source, operator);
    const reading = one(db, 'SELECT * FROM water_readings WHERE id = ?', Number(r.lastInsertRowid));
    let anomaly = null;
    if (tempC < tank.temp_min || tempC > tank.temp_max) {
      const res = createAnomaly(db, {
        kind: 'temp',
        tankId,
        refKey: `tank:${tankId}:temp`,
        dedupeKey: `temp:${tankId}:${dateStr(collected)}`,
        detail: `水温 ${tempC}℃ 超出 ${tank.temp_min}–${tank.temp_max}℃ 范围（设备 ${deviceId}，采集于 ${iso(collected)}${source === 'backfill' ? '，补录' : ''}）`,
        handlingTitle: `复核 ${tank.code} 水温并检查温控设备`,
        dueMinutes: 60,
      }, now);
      anomaly = res.anomaly;
    }
    return { reading, anomaly };
  });
}

// ---------- 设备点检 ----------

/**
 * 记录点检：
 *  - 未通过 → 设备停机、冻结该水槽全部生效计划及其待执行任务、生成停机异常
 *  - 复检通过 → 设备恢复运行；若水槽已无停机设备则解冻计划，过期时段记漏投
 */
function recordInspection(db, { equipmentId, result, inspector, notes = '', photoPath = null, inspectedAt = null }, now = new Date()) {
  const eq = one(db, 'SELECT * FROM equipment WHERE id = ?', equipmentId);
  if (!eq) throw new DomainError(404, 'EQUIPMENT_NOT_FOUND', '设备不存在');
  if (!['pass', 'fail'].includes(result)) throw new DomainError(422, 'RESULT_INVALID', '点检结果必须为 pass 或 fail');
  return tx(db, () => {
    const r = run(db,
      `INSERT INTO inspections (equipment_id, inspected_at, inspector, result, photo_path, notes)
       VALUES (?,?,?,?,?,?)`,
      equipmentId, inspectedAt || iso(now), inspector || '未署名', result, photoPath, notes || '');
    const inspection = one(db, 'SELECT * FROM inspections WHERE id = ?', Number(r.lastInsertRowid));

    if (result === 'fail') {
      run(db, `UPDATE equipment SET status = 'stopped' WHERE id = ?`, eq.id);
      const plans = all(db, `SELECT * FROM feeding_plans WHERE tank_id = ? AND status = 'active'`, eq.tank_id);
      for (const p of plans) {
        run(db, `UPDATE feeding_plans SET status = 'frozen' WHERE id = ?`, p.id);
        run(db, `UPDATE feeding_tasks SET status = 'frozen' WHERE plan_id = ? AND status = 'pending'`, p.id);
      }
      if (!hasOpenAnomaly(db, `equipment:${eq.id}`)) {
        createAnomaly(db, {
          kind: 'filter_stop',
          tankId: eq.tank_id,
          refKey: `equipment:${eq.id}`,
          dedupeKey: `filterstop:${eq.id}:${inspection.id}`,
          detail: `设备 ${eq.device_code} 点检未通过（${notes || '无备注'}），已停机并冻结关联投喂计划`,
          handlingTitle: `检修设备 ${eq.device_code} 并复检`,
          dueMinutes: 120,
        }, now);
      }
    } else {
      run(db, `UPDATE equipment SET status = 'running' WHERE id = ?`, eq.id);
      const stopped = one(db, `SELECT COUNT(*) AS c FROM equipment WHERE tank_id = ? AND status = 'stopped'`, eq.tank_id).c;
      if (Number(stopped) === 0) {
        const plans = all(db, `SELECT * FROM feeding_plans WHERE tank_id = ? AND status = 'frozen'`, eq.tank_id);
        for (const p of plans) {
          run(db, `UPDATE feeding_plans SET status = 'active' WHERE id = ?`, p.id);
          for (const t of all(db, `SELECT * FROM feeding_tasks WHERE plan_id = ? AND status = 'frozen'`, p.id)) {
            if (slotDate(t.scheduled_date, t.slot).getTime() + GRACE_MINUTES * 60000 < now.getTime()) {
              markTaskMissed(db, t, now);
            } else {
              run(db, `UPDATE feeding_tasks SET status = 'pending' WHERE id = ?`, t.id);
            }
          }
        }
      }
      const an = one(db, `SELECT * FROM anomalies WHERE ref_key = ? AND status != 'resolved'`, `equipment:${eq.id}`);
      if (an) {
        run(db, `UPDATE anomalies SET status = 'resolved', resolved_at = ? WHERE id = ?`, iso(now), an.id);
        run(db, `UPDATE handling_tasks SET status = 'done', done_at = ?, done_by = ? WHERE anomaly_id = ? AND status = 'open'`,
          iso(now), inspector || '系统', an.id);
      }
    }
    return inspection;
  });
}

// ---------- 观察 / 处置 / 交接 ----------

/** 生物拒食观察 → 异常 + 处置任务（按水槽+小时去重） */
function recordRefusal(db, { tankId, note = '', operator = null }, now = new Date()) {
  const tank = one(db, 'SELECT * FROM tanks WHERE id = ?', tankId);
  if (!tank) throw new DomainError(404, 'TANK_NOT_FOUND', '水槽不存在');
  const hour = iso(now).slice(0, 13);
  return createAnomaly(db, {
    kind: 'refusal',
    tankId,
    refKey: `tank:${tankId}:refusal`,
    dedupeKey: `refusal:${tankId}:${hour}`,
    detail: `${tank.code} 生物拒食观察：${note || '未填写说明'}（记录人 ${operator || '未署名'}）`,
    handlingTitle: `排查 ${tank.code} 拒食原因（水质/健康/饲料适口性）`,
    dueMinutes: 180,
  }, now);
}

function ackAnomaly(db, id, now = new Date()) {
  const r = run(db, `UPDATE anomalies SET status = 'acked' WHERE id = ? AND status = 'open'`, id);
  if (Number(r.changes) !== 1) throw new DomainError(409, 'ANOMALY_NOT_OPEN', '异常不存在或已处理');
  return one(db, 'SELECT * FROM anomalies WHERE id = ?', id);
}

function resolveAnomaly(db, id, operator, now = new Date()) {
  return tx(db, () => {
    const an = one(db, 'SELECT * FROM anomalies WHERE id = ?', id);
    if (!an) throw new DomainError(404, 'ANOMALY_NOT_FOUND', '异常不存在');
    if (an.status === 'resolved') return an;
    run(db, `UPDATE anomalies SET status = 'resolved', resolved_at = ? WHERE id = ?`, iso(now), id);
    run(db, `UPDATE handling_tasks SET status = 'done', done_at = ?, done_by = ? WHERE anomaly_id = ? AND status = 'open'`,
      iso(now), operator || '系统', id);
    return one(db, 'SELECT * FROM anomalies WHERE id = ?', id);
  });
}

function completeHandling(db, id, operator, now = new Date()) {
  const r = run(db,
    `UPDATE handling_tasks SET status = 'done', done_at = ?, done_by = ? WHERE id = ? AND status = 'open'`,
    iso(now), operator || '未署名', id);
  if (Number(r.changes) !== 1) throw new DomainError(409, 'HANDLING_NOT_OPEN', '处置任务不存在或已完成');
  return one(db, 'SELECT * FROM handling_tasks WHERE id = ?', id);
}

/** 交接班：自动附带当前运营摘要 */
function digest(db, now = new Date()) {
  const c = (sql, ...a) => Number(one(db, sql, ...a).c);
  const openAn = c(`SELECT COUNT(*) c FROM anomalies WHERE status != 'resolved'`);
  const openHandling = c(`SELECT COUNT(*) c FROM handling_tasks WHERE status = 'open'`);
  const stopped = c(`SELECT COUNT(*) c FROM equipment WHERE status = 'stopped'`);
  const frozen = c(`SELECT COUNT(*) c FROM feeding_plans WHERE status = 'frozen'`);
  const pendingToday = c(`SELECT COUNT(*) c FROM feeding_tasks WHERE status = 'pending' AND scheduled_date = ?`, dateStr(now));
  return `未结异常 ${openAn} 项 · 待处置 ${openHandling} 项 · 停机设备 ${stopped} 台 · 冻结计划 ${frozen} 份 · 今日待投喂 ${pendingToday} 次`;
}

function createHandover(db, { shift, fromUser, toUser, summary = '' }, now = new Date()) {
  if (!shift || !fromUser || !toUser) throw new DomainError(422, 'HANDOVER_FIELDS', '班次、交班人、接班人均必填');
  const r = run(db,
    `INSERT INTO handovers (shift, from_user, to_user, summary, digest, created_at) VALUES (?,?,?,?,?,?)`,
    shift, fromUser, toUser, summary, digest(db, now), iso(now));
  return one(db, 'SELECT * FROM handovers WHERE id = ?', Number(r.lastInsertRowid));
}

// ---------- 提醒（进程内） ----------

function addReminder(db, key, kind, message, now) {
  run(db, `INSERT OR IGNORE INTO reminders (dedupe_key, kind, message, created_at) VALUES (?,?,?,?)`,
    key, kind, message, iso(now));
}

/** 调度器：刷新到期提醒（投喂临期 / 处置临期 / 饲料临期） */
function refreshReminders(db, now = new Date()) {
  const today = dateStr(now);
  const tasks = all(db,
    `SELECT ft.*, t.code AS tank_code FROM feeding_tasks ft JOIN tanks t ON t.id = ft.tank_id
     WHERE ft.status = 'pending' AND ft.scheduled_date = ?`, today);
  for (const t of tasks) {
    const diff = slotDate(t.scheduled_date, t.slot).getTime() - now.getTime();
    if (diff <= REMIND_FEEDING_MIN * 60000 && diff > -GRACE_MINUTES * 60000) {
      addReminder(db, `feedue:${t.id}`, 'feeding_due', `水槽 ${t.tank_code} ${t.slot} 投喂待执行（${t.dose_g}g）`, now);
    }
  }
  const handlings = all(db, `SELECT * FROM handling_tasks WHERE status = 'open' AND due_at IS NOT NULL`);
  for (const h of handlings) {
    const due = new Date(h.due_at).getTime();
    if (due <= now.getTime() + REMIND_HANDLING_MIN * 60000) {
      addReminder(db, `handleue:${h.id}`, 'handling_due',
        `处置任务「${h.title}」${due < now.getTime() ? '已逾期' : '即将到期'}`, now);
    }
  }
  const feeds = all(db, `SELECT * FROM feed_batches WHERE status = 'active'`);
  for (const f of feeds) {
    const days = (new Date(`${f.expiry_date}T23:59:59`).getTime() - now.getTime()) / 86400000;
    if (days >= 0 && days <= FEED_EXPIRING_DAYS) {
      addReminder(db, `feedexp7:${f.id}`, 'feed_expiring', `饲料批次 ${f.batch_code} 将于 ${f.expiry_date} 过期`, now);
    }
  }
}

// ---------- 查询 ----------

function overview(db, now = new Date()) {
  const today = dateStr(now);
  return all(db, 'SELECT * FROM tanks ORDER BY code').map((t) => {
    const plan = one(db,
      `SELECT * FROM feeding_plans WHERE tank_id = ? AND status IN ('active','frozen')
       ORDER BY version DESC LIMIT 1`, t.id);
    return {
      ...t,
      max_dose_g: maxDoseForTank(t),
      equipment: all(db, 'SELECT * FROM equipment WHERE tank_id = ? ORDER BY id', t.id),
      plan: plan ? { ...plan, slots: JSON.parse(plan.slots) } : null,
      tasks: all(db, 'SELECT * FROM feeding_tasks WHERE tank_id = ? AND scheduled_date = ? ORDER BY slot', t.id, today),
      anomalies: all(db, `SELECT * FROM anomalies WHERE tank_id = ? AND status != 'resolved' ORDER BY id DESC`, t.id),
      last_reading: one(db, 'SELECT * FROM water_readings WHERE tank_id = ? ORDER BY collected_at DESC LIMIT 1', t.id),
    };
  });
}

function listCalendar(db, date) {
  return all(db,
    `SELECT ft.*, t.code AS tank_code, t.name AS tank_name, t.bio_count, fb.batch_code AS feed_batch_code
     FROM feeding_tasks ft
     JOIN tanks t ON t.id = ft.tank_id
     JOIN feed_batches fb ON fb.id = ft.feed_batch_id
     WHERE ft.scheduled_date = ? ORDER BY ft.slot, t.code`, date)
    .map((r) => ({ ...r, max_dose_g: maxDoseForTank(r) }));
}

function listFeeds(db) {
  return all(db, 'SELECT * FROM feed_batches ORDER BY CASE status WHEN \'active\' THEN 0 ELSE 1 END, expiry_date');
}

function listEquipment(db) {
  return all(db,
    `SELECT e.*, t.code AS tank_code, t.name AS tank_name,
       (SELECT json_object('result', i.result, 'inspected_at', i.inspected_at, 'inspector', i.inspector,
                           'photo_path', i.photo_path, 'notes', i.notes)
        FROM inspections i WHERE i.equipment_id = e.id ORDER BY i.inspected_at DESC, i.id DESC LIMIT 1) AS last_inspection
     FROM equipment e JOIN tanks t ON t.id = e.tank_id ORDER BY t.code, e.device_code`)
    .map((r) => ({ ...r, last_inspection: r.last_inspection ? JSON.parse(r.last_inspection) : null }));
}

function listAnomalies(db, status = 'open') {
  const rows = status === 'all'
    ? all(db, `SELECT a.*, t.code AS tank_code FROM anomalies a LEFT JOIN tanks t ON t.id = a.tank_id ORDER BY a.id DESC LIMIT 200`)
    : all(db, `SELECT a.*, t.code AS tank_code FROM anomalies a LEFT JOIN tanks t ON t.id = a.tank_id
               WHERE a.status = ? ORDER BY a.id DESC LIMIT 200`, status);
  return rows.map((a) => ({
    ...a,
    handling: all(db, 'SELECT * FROM handling_tasks WHERE anomaly_id = ? ORDER BY id', a.id),
  }));
}

function listReadings(db, tankId) {
  return tankId
    ? all(db, 'SELECT * FROM water_readings WHERE tank_id = ? ORDER BY collected_at DESC LIMIT 50', tankId)
    : all(db, 'SELECT * FROM water_readings ORDER BY collected_at DESC LIMIT 100');
}

function listInspections(db, equipmentId) {
  return equipmentId
    ? all(db, 'SELECT * FROM inspections WHERE equipment_id = ? ORDER BY inspected_at DESC LIMIT 50', equipmentId)
    : all(db, 'SELECT * FROM inspections ORDER BY inspected_at DESC LIMIT 100');
}

function listHandovers(db) {
  return all(db, 'SELECT * FROM handovers ORDER BY id DESC LIMIT 50');
}

function listReminders(db) {
  return all(db, 'SELECT * FROM reminders WHERE acked = 0 ORDER BY id DESC LIMIT 50');
}

function ackReminder(db, id) {
  const r = run(db, 'UPDATE reminders SET acked = 1 WHERE id = ? AND acked = 0', id);
  if (Number(r.changes) !== 1) throw new DomainError(404, 'REMINDER_NOT_FOUND', '提醒不存在或已确认');
  return { id, acked: true };
}

module.exports = {
  DomainError,
  DOSE, GRACE_MINUTES, ANOMALY_KINDS, TASK_STATUS_TEXT,
  tx, one, all, run,
  maxDoseForTank, assertDose, normalizeSlots,
  createAnomaly, hasOpenAnomaly,
  createPlan, listPlans,
  generateTasksForDate, completeTaskByToken, markTaskMissed, markMissedTasks,
  createFeedBatch, markExpiredFeeds,
  recordReading, recordInspection, recordRefusal,
  ackAnomaly, resolveAnomaly, completeHandling,
  digest, createHandover,
  refreshReminders,
  overview, listCalendar, listFeeds, listEquipment, listAnomalies, listReadings,
  listInspections, listHandovers, listReminders, ackReminder,
};
