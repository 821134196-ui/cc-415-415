"""演示数据：水槽、生物批次、饲料、投喂计划/任务、设备点检（含停机与复核）、
水质读数（含补录）、水温异常、拒食、漏投、交接日志。

用法：python3 seed.py            # 重建数据库并写入演示数据
     python3 seed.py --keep     # 不删除已有数据库（追加演示数据，不建议）
"""
import json
import os
import sys
from datetime import datetime, timedelta

import db
import service


def _iso(dt):
    return dt.strftime("%Y-%m-%dT%H:%M:%S")


def _write_photo(name, label, color):
    """生成一张 SVG 占位点检照片，保存到本地文件。"""
    path = os.path.join(db.PHOTO_DIR, name)
    svg = f"""<svg xmlns='http://www.w3.org/2000/svg' width='320' height='200'>
<rect width='320' height='200' fill='{color}'/>
<rect x='10' y='10' width='300' height='180' fill='none' stroke='#ffffff'
 stroke-width='3' stroke-dasharray='8 6' rx='8'/>
<text x='160' y='95' fill='#ffffff' font-size='22' text-anchor='middle'
 font-family='sans-serif'>点检照片</text>
<text x='160' y='128' fill='#ffffff' font-size='16' text-anchor='middle'
 font-family='sans-serif'>{label}</text>
<text x='160' y='158' fill='#eaf6ff' font-size='13' text-anchor='middle'
 font-family='sans-serif'>{datetime.now().strftime('%Y-%m-%d %H:%M')}</text>
</svg>"""
    with open(path, "w", encoding="utf-8") as f:
        f.write(svg)
    return path


def seed(reset=True):
    if reset and os.path.exists(db.DEFAULT_DB):
        os.remove(db.DEFAULT_DB)
    conn = db.init_db(db.DEFAULT_DB)
    now = datetime.now()
    today = now.date()

    # ---------- 水槽（平面水槽图坐标为百分比） ----------
    tanks = [
        ("T-01", "主展缸", 12000, 24.0, 26.0, 6, 10),
        ("T-02", "海马缸", 800, 22.0, 24.0, 56, 10),
        ("T-03", "水母缸", 500, 18.0, 22.0, 6, 58),
        ("T-04", "幼鱼培育缸", 300, 25.0, 27.0, 56, 58),
    ]
    tank_ids = {}
    for code, name, vol, tmin, tmax, x, y in tanks:
        cur = conn.execute(
            "INSERT INTO tanks(code,name,volume_l,temp_min,temp_max,pos_x,pos_y) "
            "VALUES(?,?,?,?,?,?,?)", (code, name, vol, tmin, tmax, x, y))
        tank_ids[code] = cur.lastrowid

    # ---------- 生物批次（演示编号） ----------
    creatures = [
        ("BIO-2609-01", tank_ids["T-01"], "蓝吊", 12, "入缸 2026-09-01"),
        ("BIO-2609-02", tank_ids["T-01"], "小丑鱼", 18, "入缸 2026-09-05"),
        ("BIO-2609-03", tank_ids["T-02"], "巴里巴里海马", 8, "成对饲养"),
        ("BIO-2609-04", tank_ids["T-03"], "海月水母", 24, "伞径 6~9cm"),
        ("BIO-2609-05", tank_ids["T-04"], "雀鲷幼鱼", 40, "本月繁育批次"),
    ]
    for no, tid, sp, qty, note in creatures:
        conn.execute(
            "INSERT INTO creature_batches(tank_id,batch_no,species,quantity,note) "
            "VALUES(?,?,?,?,?)", (tid, no, sp, qty, note))

    # ---------- 饲料批次（含一个过期批次） ----------
    feeds = [
        ("FB-2601", "海洋颗粒饲料", "2027-06-30", 5000.0, 4760.0),
        ("FB-2602", "冷冻磷虾", "2026-12-15", 2000.0, 1460.0),
        ("FB-2508", "海藻薄片", "2026-08-31", 800.0, 320.0),   # 已过期
    ]
    feed_ids = {}
    for no, typ, exp, init, rem in feeds:
        cur = conn.execute(
            "INSERT INTO feed_batches(batch_no,feed_type,expiry_date,remaining_g,initial_g) "
            "VALUES(?,?,?,?,?)", (no, typ, exp, rem, init))
        feed_ids[no] = cur.lastrowid

    # ---------- 投喂计划 ----------
    end = (today + timedelta(days=14)).isoformat()
    start = today.isoformat()
    p1 = service.create_plan(conn, tank_ids["T-01"], feed_ids["FB-2601"], 18.0,
                             ["08:30", "12:30", "17:30"], start, end)
    p3 = service.create_plan(conn, tank_ids["T-03"], feed_ids["FB-2602"], 8.0,
                             ["10:00", "16:00"], start, end)
    p4 = service.create_plan(conn, tank_ids["T-04"], feed_ids["FB-2602"], 4.0,
                             ["09:00", "13:00", "18:00"], start, end)
    p2 = service.create_plan(conn, tank_ids["T-02"], feed_ids["FB-2601"], 6.0,
                             ["11:00", "16:30"], start, end)

    # 演示：T-01 计划变更过两次（保留 v1/v2 版本链，当前 v3），剂量 18g→20g
    service.update_plan(conn, p1, dose_g=20.0,
                        times=["08:30", "13:00", "17:30"])
    v2 = conn.execute(
        "SELECT id FROM feeding_plans WHERE lineage_id=? ORDER BY version DESC LIMIT 1",
        (p1,)).fetchone()["id"]
    service.update_plan(conn, v2, times=["08:30", "12:30", "17:30"])
    active_p1 = conn.execute(
        "SELECT id,version FROM feeding_plans WHERE lineage_id=? AND status='active' "
        "ORDER BY version DESC LIMIT 1", (p1,)).fetchone()
    active_p1_id, active_p1_ver = active_p1["id"], active_p1["version"]

    # ---------- 设备 ----------
    equip = [
        ("F-01", tank_ids["T-01"], "主展缸循环过滤器"),
        ("H-01", tank_ids["T-01"], "主展缸恒温机"),
        ("F-02", tank_ids["T-02"], "海马缸过滤泵"),
        ("F-03", tank_ids["T-03"], "水母缸缓流过滤器"),
        ("F-04", tank_ids["T-04"], "幼鱼缸过滤桶"),
    ]
    eq_ids = {}
    for code, tid, name in equip:
        kind = "heater" if code.startswith("H") else "filter"
        cur = conn.execute(
            "INSERT INTO equipment(tank_id,code,kind,name,status) "
            "VALUES(?,?,?,?,'running')", (tid, code, kind, name))
        eq_ids[code] = cur.lastrowid

    # ---------- 水质读数（演示数据，含补录；设备编号必填） ----------
    # T-01 近几日正常读数
    for d, v in [(3, 25.2), (2, 25.0), (1, 25.4), (0, 25.3)]:
        ts = _iso(now - timedelta(days=d, hours=2))
        service.add_reading(conn, tank_ids["T-01"], "temperature", v, "℃",
                            "TH-01", collected_at=ts)
    # T-01 一条补录读数：采集时间为昨天深夜，录入时间为现在（保留采集时间+设备编号）
    service.add_reading(
        conn, tank_ids["T-01"], "temperature", 24.8, "℃", "TH-01-BACKUP",
        collected_at=_iso(now - timedelta(days=1, hours=8)))
    # T-03 正常历史 + 当前异常水温 23.6℃（上限 22℃）
    for d, v in [(2, 20.8), (1, 21.1)]:
        service.add_reading(
            conn, tank_ids["T-03"], "temperature", v, "℃", "TH-03",
            collected_at=_iso(now - timedelta(days=d)))
    service.add_reading(conn, tank_ids["T-03"], "temperature", 23.6, "℃",
                        "TH-03", collected_at=_iso(now - timedelta(minutes=20)))
    # T-02 / T-04 当前读数
    service.add_reading(conn, tank_ids["T-02"], "temperature", 23.1, "℃",
                        "TH-02", collected_at=_iso(now - timedelta(minutes=40)))
    service.add_reading(conn, tank_ids["T-04"], "temperature", 26.2, "℃",
                        "TH-04", collected_at=_iso(now - timedelta(minutes=15)))
    # pH 演示读数
    service.add_reading(conn, tank_ids["T-01"], "ph", 8.1, "", "WQ-01",
                        collected_at=_iso(now - timedelta(hours=1)))
    service.add_reading(conn, tank_ids["T-04"], "ammonia", 0.02, "mg/L",
                        "WQ-04", collected_at=_iso(now - timedelta(hours=2)))

    # ---------- 设备点检：复核样例（F-01 先未通过、复核通过） ----------
    photo_fail_01 = _write_photo("demo_F01_fail.svg", "F-01 异常照片", "#c0504d")
    photo_pass_01 = _write_photo("demo_F01_recheck.svg", "F-01 复核照片", "#2e9e8f")
    conn.execute(
        "INSERT INTO inspections(equipment_id,result,note,photo_path,inspector,created_at) "
        "VALUES(?,?,?,?,?,?)",
        (eq_ids["F-01"], "fail", "流量偏低，叶轮卡滞，已停机检修",
         photo_fail_01, "周值班", _iso(now - timedelta(days=2, hours=3))))
    conn.execute(
        "INSERT INTO inspections(equipment_id,result,note,photo_path,inspector,created_at) "
        "VALUES(?,?,?,?,?,?)",
        (eq_ids["F-01"], "pass", "复核：更换叶轮后流量恢复，设备复机",
         photo_pass_01, "周值班", _iso(now - timedelta(days=1, hours=1))))

    # ---------- 设备点检：未通过样例（F-02 => 停机 + 冻结 T-02 投喂计划） ----------
    photo_fail_02 = _write_photo("demo_F02_fail.svg", "F-02 点检未通过", "#c0504d")
    service.inspect_equipment(
        conn, eq_ids["F-02"], "fail",
        note="点检未通过：电机过热保护，无法启动",
        photo_path=photo_fail_02, inspector="早班-林")

    # ---------- 投喂任务样例 ----------
    # 1) 一条已完成任务（今早 07:45，避开计划时段），饲料已扣减（剩余量已在批次初始值预留）
    conn.execute(
        "INSERT INTO feeding_tasks(plan_id,plan_version,tank_id,feed_batch_id,dose_g,"
        "scheduled_at,status,scan_code,completed_at,completed_by) "
        "VALUES(?,?,?,?,?,?,'done',?,?, '早班-林')",
        (active_p1_id, active_p1_ver, tank_ids["T-01"], feed_ids["FB-2601"], 20.0,
         _iso(now.replace(hour=7, minute=45, second=0, microsecond=0)),
         "FT-DEMO-DONE01",
         _iso(now.replace(hour=7, minute=46, second=0, microsecond=0))))

    # 2) 一条到期任务（计划时间 = 5 分钟前，用于进程内到期提醒演示，仍在宽限期内）
    due_at = now - timedelta(minutes=5)
    conn.execute(
        "INSERT INTO feeding_tasks(plan_id,plan_version,tank_id,feed_batch_id,dose_g,"
        "scheduled_at,status,scan_code) "
        "VALUES(?,?,?,?,?,?,'pending',?)",
        (active_p1_id, active_p1_ver, tank_ids["T-01"], feed_ids["FB-2601"], 20.0,
         _iso(due_at.replace(second=0, microsecond=0)), "FT-DEMO-DUE01"))

    # 3) 一条漏投任务（T-04，50 分钟前，超过 30 分钟宽限）
    missed_at = now - timedelta(minutes=50)
    conn.execute(
        "INSERT INTO feeding_tasks(plan_id,plan_version,tank_id,feed_batch_id,dose_g,"
        "scheduled_at,status,scan_code) "
        "VALUES(?,1,?,?,?,?,'pending',?)",
        (p4, tank_ids["T-04"], feed_ids["FB-2602"], 4.0,
         _iso(missed_at.replace(second=0, microsecond=0)), "FT-DEMO-MISS01"))

    conn.commit()
    # 触发漏投检测 => missed + 异常 + 处置任务
    service.sweep_missed(conn, now=now)
    # 过期饲料 => 异常 + 处置任务
    service.check_feed_expiry(conn)

    # ---------- 生物拒食样例（T-04） ----------
    service.log_refusal(conn, tank_ids["T-04"],
                        "09:00 投喂时幼鱼集群不进食，疑似水温波动应激，已减量观察")

    # ---------- 交接日志样例 ----------
    conn.execute(
        "INSERT INTO handoffs(shift_date,from_person,to_person,content,created_at) "
        "VALUES(?,?,?,?,?)",
        ((today - timedelta(days=1)).isoformat(), "夜班-顾", "早班-林",
         "T-02 过滤泵 F-02 夜间异响，已挂待点检牌，早班务必先点检再投喂；"
         "T-03 水温缓升，已通知设备班；饲料 FB-2508 已过期待报废。",
         _iso(now - timedelta(days=1, hours=1))))

    conn.commit()
    conn.close()
    return db.DEFAULT_DB


if __name__ == "__main__":
    reset = "--keep" not in sys.argv
    path = seed(reset=reset)
    print(f"演示数据已写入：{path}")
