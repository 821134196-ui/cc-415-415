"""业务服务层：投喂、点检、异常、冻结、扫码幂等等全部规则。"""
import json
import uuid
from datetime import datetime, date, timedelta

import db

GRACE_MINUTES = 30          # 超过计划时间多少分钟算漏投
MIN_DOSE_G = 0.1            # 单次剂量下限（克）
BACKFILL_TOLERANCE_SEC = 300  # 采集时间早于录入时间超过该值视为补录


# ---------- 时间工具 ----------
def now_iso():
    return datetime.now().strftime("%Y-%m-%dT%H:%M:%S")


def today_str():
    return date.today().isoformat()


def parse_dt(s):
    s = s.strip().replace("/", "-")
    for fmt in ("%Y-%m-%dT%H:%M:%S", "%Y-%m-%d %H:%M:%S",
                "%Y-%m-%dT%H:%M", "%Y-%m-%d %H:%M"):
        try:
            return datetime.strptime(s, fmt)
        except ValueError:
            continue
    raise ValueError(f"时间格式无法解析：{s}")


def new_scan_code(prefix):
    return f"{prefix}-{uuid.uuid4().hex[:10].upper()}"


# ---------- 异常与处置任务 ----------
def raise_anomaly(conn, kind, title, tank_id=None, detail="", dedupe_key=None):
    """登记异常并生成处置任务。dedupe_key 相同且未关闭时不重复生成。"""
    if dedupe_key:
        exists = conn.execute(
            "SELECT id FROM anomalies WHERE dedupe_key=? AND status!='resolved'",
            (dedupe_key,)).fetchone()
        if exists:
            return exists["id"]
    cur = conn.execute(
        "INSERT INTO anomalies(tank_id,kind,title,detail,dedupe_key,created_at) "
        "VALUES(?,?,?,?,?,?)",
        (tank_id, kind, title, detail, dedupe_key, now_iso()))
    anomaly_id = cur.lastrowid
    conn.execute(
        "INSERT INTO handling_tasks(anomaly_id,title,scan_code,created_at) VALUES(?,?,?,?)",
        (anomaly_id, f"【处置】{title}", new_scan_code("HT"), now_iso()))
    if tank_id:
        conn.execute("UPDATE tanks SET status='alert' WHERE id=? AND status='normal'",
                     (tank_id,))
    return anomaly_id


def resolve_anomaly(conn, anomaly_id):
    conn.execute("UPDATE anomalies SET status='resolved' WHERE id=?", (anomaly_id,))
    conn.execute(
        "UPDATE handling_tasks SET status='done', completed_at=?, completed_by='系统' "
        "WHERE anomaly_id=? AND status='open'", (now_iso(), anomaly_id))


# ---------- 饲料 ----------
def check_feed_expiry(conn):
    """检查所有饲料批次：过期则生成异常+处置任务。"""
    today = today_str()
    rows = conn.execute("SELECT * FROM feed_batches").fetchall()
    for b in rows:
        if b["expiry_date"] < today:
            raise_anomaly(
                conn, "feed_expired",
                f"饲料 {b['feed_type']}（批次 {b['batch_no']}）已过期",
                None, f"有效期至 {b['expiry_date']}，剩余 {b['remaining_g']}g",
                dedupe_key=f"feed_expired:{b['id']}")
    conn.commit()


# ---------- 计划版本与任务生成 ----------
def create_plan(conn, tank_id, feed_batch_id, dose_g, times, start_date, end_date):
    """创建投喂计划，校验剂量边界。"""
    if dose_g < MIN_DOSE_G:
        raise ValueError(f"单次剂量不能小于 {MIN_DOSE_G}g")
    batch = conn.execute("SELECT * FROM feed_batches WHERE id=?",
                         (feed_batch_id,)).fetchone()
    if not batch:
        raise ValueError("饲料批次不存在")
    if dose_g > batch["remaining_g"] + 1e-9:
        raise ValueError(
            f"单次剂量 {dose_g}g 超过该批次剩余量 {batch['remaining_g']}g")
    if batch["expiry_date"] < today_str():
        raise ValueError("该饲料批次已过期，不能用于新计划")
    if not times:
        raise ValueError("至少配置一个投喂时段")
    for t in times:
        datetime.strptime(t, "%H:%M")  # 校验格式
    if start_date > end_date:
        raise ValueError("开始日期不能晚于结束日期")
    cur = conn.execute(
        "INSERT INTO feeding_plans(tank_id,feed_batch_id,dose_g,times,start_date,end_date,"
        "version,status,created_at) VALUES(?,?,?,?,?,?,'1','active',?)",
        (tank_id, feed_batch_id, dose_g, json.dumps(times, ensure_ascii=False),
         start_date, end_date, now_iso()))
    plan_id = cur.lastrowid
    # 首版：版本链指向自身
    conn.execute("UPDATE feeding_plans SET lineage_id=id WHERE id=?", (plan_id,))
    # 水槽处于冻结状态时，新计划同样冻结（设备点检未通过期间禁止投喂）
    tank = conn.execute("SELECT status FROM tanks WHERE id=?", (tank_id,)).fetchone()
    if tank["status"] == "frozen":
        conn.execute(
            "UPDATE feeding_plans SET status='frozen',frozen_reason='水槽冻结中：关联设备点检未通过' "
            "WHERE id=?", (plan_id,))
    else:
        generate_tasks(conn, plan_id)
    conn.commit()
    return plan_id


def update_plan(conn, plan_id, **changes):
    """计划变更：旧版本置 replaced 并保留，新版本从 1 开始。

    已执行（done/missed）的任务保留旧版本剂量快照，不重算；
    旧版本未执行的 pending 任务取消，按新版本重新生成。
    """
    old = conn.execute("SELECT * FROM feeding_plans WHERE id=?", (plan_id,)).fetchone()
    if not old:
        raise ValueError("计划不存在")
    if old["status"] == "replaced":
        raise ValueError("该版本已被替换，请基于最新版本修改")
    dose_g = changes.get("dose_g", old["dose_g"])
    times = changes.get("times", json.loads(old["times"]))
    start_date = changes.get("start_date", old["start_date"])
    end_date = changes.get("end_date", old["end_date"])
    feed_batch_id = changes.get("feed_batch_id", old["feed_batch_id"])

    if dose_g < MIN_DOSE_G:
        raise ValueError(f"单次剂量不能小于 {MIN_DOSE_G}g")
    batch = conn.execute("SELECT * FROM feed_batches WHERE id=?",
                         (feed_batch_id,)).fetchone()
    if dose_g > batch["remaining_g"] + 1e-9:
        raise ValueError(
            f"单次剂量 {dose_g}g 超过该批次剩余量 {batch['remaining_g']}g")
    if not times:
        raise ValueError("至少配置一个投喂时段")
    for t in times:
        datetime.strptime(t, "%H:%M")
    if start_date > end_date:
        raise ValueError("开始日期不能晚于结束日期")

    # 旧版本保留（replaced）；冻结/活动版本均保留版本记录
    frozen_reason = old["frozen_reason"]
    new_status = "frozen" if old["status"] == "frozen" else "active"
    conn.execute("UPDATE feeding_plans SET status='replaced' WHERE id=?", (plan_id,))
    # 旧版本未执行任务取消；已完成/漏投的保留旧版本剂量快照不动
    conn.execute(
        "UPDATE feeding_tasks SET status='cancelled' WHERE plan_id=? AND status='pending'",
        (plan_id,))

    new_version = old["version"] + 1
    cur = conn.execute(
        "INSERT INTO feeding_plans(tank_id,feed_batch_id,dose_g,times,start_date,end_date,"
        "version,lineage_id,status,frozen_reason,created_at) "
        "VALUES(?,?,?,?,?,?,?,?,?,?,?)",
        (old["tank_id"], feed_batch_id, dose_g,
         json.dumps(times, ensure_ascii=False),
         start_date, end_date, new_version, old["lineage_id"] or plan_id,
         new_status, frozen_reason if new_status == "frozen" else "", now_iso()))
    new_id = cur.lastrowid
    if new_status == "active":
        generate_tasks(conn, new_id)
    # 冻结状态下不生成任务，待设备点检通过解冻后再生成
    conn.commit()
    return new_id


def generate_tasks(conn, plan_id, horizon_days=14):
    """按计划的时段生成投喂任务（只生成现在之后的）。重复生成自动忽略。"""
    plan = conn.execute("SELECT * FROM feeding_plans WHERE id=?",
                        (plan_id,)).fetchone()
    if not plan or plan["status"] != "active":
        return 0
    times = json.loads(plan["times"])
    start = date.fromisoformat(plan["start_date"])
    end = date.fromisoformat(plan["end_date"])
    cap = date.today() + timedelta(days=horizon_days)
    end = min(end, cap)
    now = datetime.now()
    count = 0
    d = start
    while d <= end:
        for t in times:
            scheduled = datetime.combine(d, datetime.strptime(t, "%H:%M").time())
            if scheduled <= now:
                continue
            scheduled_str = scheduled.strftime("%Y-%m-%dT%H:%M:%S")
            # 解冻重生成：优先复活同计划同时刻的已取消任务
            cur = conn.execute(
                "UPDATE feeding_tasks SET status='pending' "
                "WHERE plan_id=? AND scheduled_at=? AND status='cancelled'",
                (plan_id, scheduled_str))
            if cur.rowcount:
                count += 1
                continue
            try:
                conn.execute(
                    "INSERT INTO feeding_tasks(plan_id,plan_version,tank_id,"
                    "feed_batch_id,dose_g,scheduled_at,scan_code) "
                    "VALUES(?,?,?,?,?,?,?)",
                    (plan_id, plan["version"], plan["tank_id"], plan["feed_batch_id"],
                     plan["dose_g"], scheduled_str, new_scan_code("FT")))
                count += 1
            except Exception:
                pass  # UNIQUE 冲突 = 已生成
        d += timedelta(days=1)
    return count


def regenerate_all(conn, horizon_days=14):
    plans = conn.execute("SELECT id FROM feeding_plans WHERE status='active'").fetchall()
    n = 0
    for p in plans:
        n += generate_tasks(conn, p["id"], horizon_days)
    conn.commit()
    return n


# ---------- 扫码完成投喂（幂等 + 扣减规则） ----------
def complete_feeding(conn, scan_code, operator=""):
    """扫码完成投喂。

    - 重复扫码返回 result=duplicate，不重复扣减、不重复完成；
    - 已执行任务的剂量快照不随计划变化重算；
    - 仅完成时扣减饲料；剂量 0、过期、库存不足、计划冻结均拒绝。
    """
    now = now_iso()
    task = conn.execute("SELECT * FROM feeding_tasks WHERE scan_code=?",
                        (scan_code,)).fetchone()
    if not task:
        conn.execute(
            "INSERT INTO scan_events(code,task_type,task_id,result,scanned_at,operator) "
            "VALUES(?,?,0,'invalid',?,?)", (scan_code, "feeding", now, operator))
        conn.commit()
        return {"result": "invalid", "message": "无效二维码"}

    if task["status"] == "done":
        conn.execute(
            "INSERT INTO scan_events(code,task_type,task_id,result,scanned_at,operator) "
            "VALUES(?,?,?,'duplicate',?,?)",
            (scan_code, "feeding", task["id"], now, operator))
        conn.commit()
        return {"result": "duplicate",
                "message": "重复扫码：该投喂任务已完成，未重复扣减饲料",
                "task_id": task["id"], "completed_at": task["completed_at"]}

    if task["status"] != "pending":
        return {"result": "invalid",
                "message": f"任务当前状态为 {task['status']}，不能完成"}

    plan = conn.execute("SELECT * FROM feeding_plans WHERE id=?",
                        (task["plan_id"],)).fetchone()
    if plan["status"] == "frozen":
        return {"result": "frozen", "message": "投喂计划已冻结（设备点检未通过）"}

    batch = conn.execute("SELECT * FROM feed_batches WHERE id=?",
                         (task["feed_batch_id"],)).fetchone()
    if batch["expiry_date"] < today_str():
        raise_anomaly(conn, "feed_expired",
                      f"饲料 {batch['feed_type']}（批次 {batch['batch_no']}）已过期，"
                      "禁止投喂",
                      task["tank_id"], dedupe_key=f"feed_expired:{batch['id']}")
        conn.commit()
        return {"result": "feed_expired", "message": "饲料已过期，禁止投喂"}

    dose = task["dose_g"]   # 始终使用任务生成时的剂量快照
    if dose < MIN_DOSE_G:
        return {"result": "bad_dose", "message": "剂量低于最小允许值"}
    if batch["remaining_g"] + 1e-9 < dose:
        return {"result": "insufficient",
                "message": f"饲料剩余 {batch['remaining_g']}g，不足本次剂量 {dose}g"}

    # 扣减（任务完成后才扣）
    conn.execute("UPDATE feed_batches SET remaining_g=remaining_g-? WHERE id=?",
                 (dose, batch["id"]))
    conn.execute(
        "UPDATE feeding_tasks SET status='done',completed_at=?,completed_by=? WHERE id=?",
        (now, operator, task["id"]))
    conn.execute(
        "INSERT INTO scan_events(code,task_type,task_id,result,scanned_at,operator) "
        "VALUES(?, 'feeding', ?, 'ok', ?, ?)",
        (scan_code, task["id"], now, operator))
    conn.commit()
    return {"result": "ok", "message": "投喂完成，饲料已扣减", "task_id": task["id"],
            "deducted_g": dose, "remaining_g": round(batch["remaining_g"] - dose, 2)}


# ---------- 处置任务扫码 ----------
def complete_handling(conn, scan_code, operator=""):
    now = now_iso()
    ht = conn.execute("SELECT * FROM handling_tasks WHERE scan_code=?",
                      (scan_code,)).fetchone()
    if not ht:
        conn.execute(
            "INSERT INTO scan_events(code,task_type,task_id,result,scanned_at,operator) "
            "VALUES(?, 'handling', 0, 'invalid', ?, ?)", (scan_code, now, operator))
        conn.commit()
        return {"result": "invalid", "message": "无效二维码"}
    if ht["status"] == "done":
        conn.execute(
            "INSERT INTO scan_events(code,task_type,task_id,result,scanned_at,operator) "
            "VALUES(?, 'handling', ?, 'duplicate', ?, ?)",
            (scan_code, ht["id"], now, operator))
        conn.commit()
        return {"result": "duplicate",
                "message": "重复扫码：该处置任务已完成", "task_id": ht["id"]}
    conn.execute(
        "UPDATE handling_tasks SET status='done',completed_at=?,completed_by=? WHERE id=?",
        (now, operator, ht["id"]))
    conn.execute(
        "INSERT INTO scan_events(code,task_type,task_id,result,scanned_at,operator) "
        "VALUES(?, 'handling', ?, 'ok', ?, ?)", (scan_code, ht["id"], now, operator))
    conn.commit()
    return {"result": "ok", "message": "处置任务已完成", "task_id": ht["id"]}


# ---------- 设备与点检 ----------
def set_equipment_status(conn, equipment_id, status, note=""):
    eq = conn.execute("SELECT * FROM equipment WHERE id=?",
                      (equipment_id,)).fetchone()
    if not eq:
        raise ValueError("设备不存在")
    conn.execute("UPDATE equipment SET status=? WHERE id=?", (status, equipment_id))
    if status == "stopped":
        # 过滤器停机（也兼容其他停机设备）：异常+处置任务，未恢复不去重
        raise_anomaly(
            conn, "filter_stop",
            f"{eq['name']}（{eq['code']}）停机",
            eq["tank_id"], note,
            dedupe_key=f"filter_stop:{eq['id']}")
    elif status == "running":
        # 恢复后关闭对应异常
        a = conn.execute(
            "SELECT id FROM anomalies WHERE dedupe_key=? AND status!='resolved'",
            (f"filter_stop:{eq['id']}",)).fetchone()
        if a:
            resolve_anomaly(conn, a["id"])
        # 若水槽无其他未解决异常，恢复状态
        _refresh_tank_status(conn, eq["tank_id"])
    conn.commit()


def inspect_equipment(conn, equipment_id, result, note="", photo_path="",
                      inspector=""):
    """设备点检。未通过 => 冻结关联水槽的投喂计划；重新通过 => 解冻。"""
    eq = conn.execute("SELECT * FROM equipment WHERE id=?",
                      (equipment_id,)).fetchone()
    if not eq:
        raise ValueError("设备不存在")
    if result not in ("pass", "fail"):
        raise ValueError("点检结果必须为 pass/fail")
    cur = conn.execute(
        "INSERT INTO inspections(equipment_id,result,note,photo_path,inspector,created_at) "
        "VALUES(?,?,?,?,?,?)",
        (equipment_id, result, note, photo_path, inspector, now_iso()))
    inspection_id = cur.lastrowid

    if result == "fail":
        # 设备视为停机，生成停机异常+处置任务
        conn.execute("UPDATE equipment SET status='stopped' WHERE id=?",
                     (equipment_id,))
        raise_anomaly(
            conn, "filter_stop",
            f"{eq['name']}（{eq['code']}）点检未通过并停机",
            eq["tank_id"], f"点检记录 #{inspection_id}：{note}",
            dedupe_key=f"filter_stop:{eq['id']}")
        # 冻结该水槽所有活动投喂计划（保留版本，仅状态变更）
        plans = conn.execute(
            "SELECT id FROM feeding_plans WHERE tank_id=? AND status='active'",
            (eq["tank_id"],)).fetchall()
        for p in plans:
            conn.execute(
                "UPDATE feeding_plans SET status='frozen',frozen_reason=? WHERE id=?",
                (f"设备点检未通过：{eq['code']}（点检 #{inspection_id}）", p["id"]))
            conn.execute(
                "UPDATE feeding_tasks SET status='cancelled' "
                "WHERE plan_id=? AND status='pending'", (p["id"],))
        conn.execute("UPDATE tanks SET status='frozen' WHERE id=?", (eq["tank_id"],))
    else:
        # 重新点检通过：设备恢复，解除该设备导致的冻结
        conn.execute("UPDATE equipment SET status='running' WHERE id=?",
                     (equipment_id,))
        a = conn.execute(
            "SELECT id FROM anomalies WHERE dedupe_key=? AND status!='resolved'",
            (f"filter_stop:{eq['id']}",)).fetchone()
        if a:
            resolve_anomaly(conn, a["id"])
        frozen = conn.execute(
            "SELECT id FROM feeding_plans WHERE tank_id=? AND status='frozen' "
            "AND frozen_reason LIKE ?",
            (eq["tank_id"], f"%{eq['code']}%")).fetchall()
        for p in frozen:
            conn.execute(
                "UPDATE feeding_plans SET status='active',frozen_reason='' WHERE id=?",
                (p["id"],))
            generate_tasks(conn, p["id"])
        still = conn.execute(
            "SELECT COUNT(*) c FROM feeding_plans WHERE tank_id=? AND status='frozen'",
            (eq["tank_id"],)).fetchone()["c"]
        if still == 0:
            _refresh_tank_status(conn, eq["tank_id"])
    conn.commit()
    return inspection_id


def _refresh_tank_status(conn, tank_id):
    open_n = conn.execute(
        "SELECT COUNT(*) c FROM anomalies WHERE tank_id=? AND status!='resolved'",
        (tank_id,)).fetchone()["c"]
    frozen_n = conn.execute(
        "SELECT COUNT(*) c FROM feeding_plans WHERE tank_id=? AND status='frozen'",
        (tank_id,)).fetchone()["c"]
    new_status = "frozen" if frozen_n else ("alert" if open_n else "normal")
    conn.execute("UPDATE tanks SET status=? WHERE id=?", (new_status, tank_id))


# ---------- 水质读数（补录保留采集时间与设备编号） ----------
def add_reading(conn, tank_id, kind, value, unit, device_no,
                collected_at=None, recorded_at=None):
    if not device_no or not str(device_no).strip():
        raise ValueError("设备编号必填")
    recorded = parse_dt(recorded_at) if recorded_at else datetime.now()
    if collected_at is None:
        collected = recorded
        backfilled = 0
    else:
        collected = parse_dt(collected_at)
        backfilled = 1 if (recorded - collected).total_seconds() > BACKFILL_TOLERANCE_SEC else 0
    cur = conn.execute(
        "INSERT INTO water_readings(tank_id,kind,value,unit,device_no,collected_at,"
        "recorded_at,backfilled) VALUES(?,?,?,?,?,?,?,?)",
        (tank_id, kind, value, unit, device_no,
         collected.strftime("%Y-%m-%dT%H:%M:%S"),
         recorded.strftime("%Y-%m-%dT%H:%M:%S"), backfilled))
    reading_id = cur.lastrowid

    # 水温异常判定
    if kind == "temperature":
        tank = conn.execute("SELECT * FROM tanks WHERE id=?", (tank_id,)).fetchone()
        if value < tank["temp_min"] or value > tank["temp_max"]:
            day = collected.strftime("%Y-%m-%d")
            raise_anomaly(
                conn, "temp",
                f"{tank['code']} 水温异常 {value}{unit}（正常 {tank['temp_min']}~"
                f"{tank['temp_max']}{unit}）",
                tank_id, f"采集时间 {collected.strftime('%Y-%m-%d %H:%M')}，"
                         f"设备 {device_no}" + ("（补录）" if backfilled else ""),
                dedupe_key=f"temp:{tank_id}:{day}")
    conn.commit()
    return reading_id, backfilled


def log_refusal(conn, tank_id, detail=""):
    """生物拒食观察。"""
    tank = conn.execute("SELECT * FROM tanks WHERE id=?", (tank_id,)).fetchone()
    day = today_str()
    aid = raise_anomaly(
        conn, "refusal", f"{tank['code']} 生物拒食", tank_id, detail,
        dedupe_key=f"refusal:{tank_id}:{day}")
    conn.commit()
    return aid


# ---------- 漏投检测 ----------
def sweep_missed(conn, now=None):
    """超过宽限期仍 pending 的任务标记 missed 并生成异常+处置任务。"""
    now = now or datetime.now()
    deadline = (now - timedelta(minutes=GRACE_MINUTES)).strftime("%Y-%m-%dT%H:%M:%S")
    rows = conn.execute(
        "SELECT t.*, tk.code tank_code FROM feeding_tasks t JOIN tanks tk ON tk.id=t.tank_id "
        "WHERE t.status='pending' AND t.scheduled_at<=?", (deadline,)).fetchall()
    n = 0
    for t in rows:
        conn.execute("UPDATE feeding_tasks SET status='missed' WHERE id=?", (t["id"],))
        day = t["scheduled_at"][:10]
        raise_anomaly(
            conn, "missed_feed",
            f"{t['tank_code']} 漏投（计划 {t['scheduled_at'][11:16]}，"
            f"剂量 {t['dose_g']}g）",
            t["tank_id"], f"任务 #{t['id']}",
            dedupe_key=f"missed_feed:{t['id']}")
        n += 1
    if n:
        conn.commit()
    return n


# ---------- 到期提醒（进程内调用） ----------
def sweep_due_reminders(conn, now=None):
    now = now or datetime.now()
    ts = now.strftime("%Y-%m-%dT%H:%M:%S")
    rows = conn.execute(
        "SELECT * FROM feeding_tasks WHERE status='pending' AND scheduled_at<=?",
        (ts,)).fetchall()
    fired = 0
    for t in rows:
        try:
            conn.execute(
                "INSERT INTO reminders(kind,ref_id,message,fired_at) "
                "VALUES('feeding_due',?,?,?)",
                (t["id"],
                 f"投喂任务到期：剂量 {t['dose_g']}g，计划 {t['scheduled_at'][11:16]}",
                 ts))
            fired += 1
        except Exception:
            pass
    conn.commit()
    return fired


# ---------- 交接日志 ----------
def add_handoff(conn, shift_date, from_person, to_person, content):
    if not content.strip():
        raise ValueError("交接内容不能为空")
    cur = conn.execute(
        "INSERT INTO handoffs(shift_date,from_person,to_person,content,created_at) "
        "VALUES(?,?,?,?,?)",
        (shift_date, from_person, to_person, content, now_iso()))
    conn.commit()
    return cur.lastrowid


# ---------- 查询聚合 ----------
def tank_overview(conn):
    tanks = conn.execute("SELECT * FROM tanks ORDER BY code").fetchall()
    result = []
    for tk in tanks:
        latest_temp = conn.execute(
            "SELECT value,unit,collected_at,device_no,backfilled FROM water_readings "
            "WHERE tank_id=? AND kind='temperature' ORDER BY collected_at DESC LIMIT 1",
            (tk["id"],)).fetchone()
        plan = conn.execute(
            "SELECT * FROM feeding_plans WHERE tank_id=? AND status IN ('active','frozen') "
            "ORDER BY id DESC LIMIT 1", (tk["id"],)).fetchone()
        equipments = conn.execute(
            "SELECT * FROM equipment WHERE tank_id=? ORDER BY code",
            (tk["id"],)).fetchall()
        creatures = conn.execute(
            "SELECT * FROM creature_batches WHERE tank_id=?", (tk["id"],)).fetchall()
        open_anomalies = conn.execute(
            "SELECT COUNT(*) c FROM anomalies WHERE tank_id=? AND status!='resolved'",
            (tk["id"],)).fetchone()["c"]
        today = today_str()
        pending_today = conn.execute(
            "SELECT COUNT(*) c FROM feeding_tasks WHERE tank_id=? AND status='pending' "
            "AND substr(scheduled_at,1,10)=?", (tk["id"], today)).fetchone()["c"]
        result.append({
            "id": tk["id"], "code": tk["code"], "name": tk["name"],
            "volume_l": tk["volume_l"], "temp_min": tk["temp_min"],
            "temp_max": tk["temp_max"], "pos_x": tk["pos_x"], "pos_y": tk["pos_y"],
            "status": tk["status"],
            "creature_count": sum(c["quantity"] for c in creatures),
            "creatures": [dict(c) for c in creatures],
            "latest_temp": dict(latest_temp) if latest_temp else None,
            "plan": dict(plan) if plan else None,
            "plan_times": json.loads(plan["times"]) if plan else [],
            "equipments": [dict(e) for e in equipments],
            "open_anomalies": open_anomalies,
            "pending_today": pending_today,
        })
    return result
