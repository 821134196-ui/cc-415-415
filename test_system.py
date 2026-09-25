"""系统规则测试。

运行：python3 -m unittest -v
覆盖：剂量边界、饲料扣减、计划版本、重复扫码、异常冻结、
      补录读数保留采集时间与设备编号、漏投与到期提醒。
"""
import os
import tempfile
import unittest
from datetime import datetime, timedelta

import db
import service


class BaseCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.db_path = os.path.join(self.tmp.name, "test.db")
        self.conn = db.init_db(self.db_path)

    def tearDown(self):
        self.conn.close()
        self.tmp.cleanup()

    # ---- 构造辅助 ----
    def add_tank(self, code="T-01", tmin=24.0, tmax=26.0):
        cur = self.conn.execute(
            "INSERT INTO tanks(code,name,volume_l,temp_min,temp_max,pos_x,pos_y) "
            "VALUES(?,?,1000,?,?,10,10)", (code, code + "缸", tmin, tmax))
        return cur.lastrowid

    def add_feed(self, no="FB-01", remaining=1000.0, expiry_days=30):
        exp = (datetime.now().date() + timedelta(days=expiry_days)).isoformat()
        cur = self.conn.execute(
            "INSERT INTO feed_batches(batch_no,feed_type,expiry_date,remaining_g,initial_g) "
            "VALUES(?,?,?,?,?)", (no, "颗粒饲料", exp, remaining, remaining))
        return cur.lastrowid

    def add_equipment(self, tank_id, code="F-01"):
        cur = self.conn.execute(
            "INSERT INTO equipment(tank_id,code,kind,name) VALUES(?,?, 'filter','过滤器')",
            (tank_id, code))
        return cur.lastrowid

    def make_plan(self, tank_id=None, feed_id=None, dose=20.0,
                  times=("08:00", "18:00"), days=30):
        tank_id = tank_id or self.add_tank()
        feed_id = feed_id or self.add_feed()
        start = datetime.now().date().isoformat()
        end = (datetime.now().date() + timedelta(days=days)).isoformat()
        pid = service.create_plan(self.conn, tank_id, feed_id, dose,
                                  list(times), start, end)
        return pid, tank_id, feed_id

    def pending_task(self, plan_id):
        return self.conn.execute(
            "SELECT * FROM feeding_tasks WHERE plan_id=? AND status='pending' "
            "ORDER BY scheduled_at LIMIT 1", (plan_id,)).fetchone()

    def feed_remaining(self, feed_id):
        return self.conn.execute("SELECT remaining_g FROM feed_batches WHERE id=?",
                                 (feed_id,)).fetchone()["remaining_g"]


class TestDoseBoundary(BaseCase):
    """剂量边界。"""

    def test_min_dose_rejected(self):
        tid, fid = self.add_tank(), self.add_feed()
        with self.assertRaises(ValueError):
            service.create_plan(self.conn, tid, fid, 0.05, ["08:00"],
                                service.today_str(), service.today_str())

    def test_zero_dose_rejected(self):
        tid, fid = self.add_tank(), self.add_feed()
        with self.assertRaises(ValueError):
            service.create_plan(self.conn, tid, fid, 0, ["08:00"],
                                service.today_str(), service.today_str())

    def test_dose_over_remaining_rejected(self):
        tid, fid = self.add_tank(), self.add_feed(remaining=10.0)
        with self.assertRaises(ValueError):
            service.create_plan(self.conn, tid, fid, 50.0, ["08:00"],
                                service.today_str(), service.today_str())

    def test_expired_feed_rejected(self):
        fid = self.add_feed(expiry_days=-1)
        tid = self.add_tank()
        with self.assertRaises(ValueError):
            service.create_plan(self.conn, tid, fid, 5.0, ["08:00"],
                                service.today_str(), service.today_str())

    def test_boundary_dose_accepted(self):
        # 0.1g 为允许的最小剂量
        pid, _, _ = self.make_plan(dose=0.1)
        self.assertTrue(pid > 0)

    def test_insufficient_stock_blocks_completion(self):
        pid, tid, fid = self.make_plan(dose=20.0)
        task = self.pending_task(pid)
        # 库存被其他用途耗尽
        self.conn.execute("UPDATE feed_batches SET remaining_g=5 WHERE id=?", (fid,))
        self.conn.commit()
        r = service.complete_feeding(self.conn, task["scan_code"], "测试员")
        self.assertEqual(r["result"], "insufficient")
        # 未扣减
        self.assertAlmostEqual(self.feed_remaining(fid), 5.0)
        # 任务仍待完成
        self.assertEqual(
            self.conn.execute("SELECT status FROM feeding_tasks WHERE id=?",
                              (task["id"],)).fetchone()["status"], "pending")


class TestFeedDeduction(BaseCase):
    """饲料扣减：任务完成后才扣。"""

    def test_deduct_only_on_completion(self):
        pid, _, fid = self.make_plan(dose=20.0)
        before = self.feed_remaining(fid)
        task = self.pending_task(pid)
        # pending 状态不扣减
        self.assertAlmostEqual(self.feed_remaining(fid), before)
        r = service.complete_feeding(self.conn, task["scan_code"], "测试员")
        self.assertEqual(r["result"], "ok")
        self.assertAlmostEqual(r["deducted_g"], 20.0)
        self.assertAlmostEqual(self.feed_remaining(fid), before - 20.0)
        # 任务记录完成人与时间
        done = self.conn.execute("SELECT * FROM feeding_tasks WHERE id=?",
                                 (task["id"],)).fetchone()
        self.assertEqual(done["status"], "done")
        self.assertEqual(done["completed_by"], "测试员")
        self.assertIsNotNone(done["completed_at"])

    def test_missed_task_does_not_deduct(self):
        pid, tid, fid = self.make_plan(dose=20.0)
        before = self.feed_remaining(fid)
        past = (datetime.now() - timedelta(minutes=40)
                ).strftime("%Y-%m-%dT%H:%M:%S")
        cur = self.conn.execute(
            "INSERT INTO feeding_tasks(plan_id,plan_version,tank_id,feed_batch_id,"
            "dose_g,scheduled_at,status,scan_code) VALUES(?,1,?,?,?,?,'pending',?)",
            (pid, tid, fid, 20.0, past, "FT-MISS-X"))
        service.sweep_missed(self.conn)
        self.assertAlmostEqual(self.feed_remaining(fid), before)
        self.assertEqual(
            self.conn.execute("SELECT status FROM feeding_tasks WHERE id=?",
                              (cur.lastrowid,)).fetchone()["status"], "missed")


class TestPlanVersioning(BaseCase):
    """计划版本：变更保留版本，已执行任务不能重算。"""

    def test_version_chain_and_done_tasks_keep_snapshot(self):
        pid, tid, fid = self.make_plan(dose=18.0)
        task = self.pending_task(pid)
        # 先完成一条 v1 任务
        service.complete_feeding(self.conn, task["scan_code"], "早班")
        remaining_after = self.feed_remaining(fid)

        # 变更计划：剂量 18 -> 25
        new_id = service.update_plan(self.conn, pid, dose_g=25.0)
        v1 = self.conn.execute("SELECT * FROM feeding_plans WHERE id=?",
                               (pid,)).fetchone()
        v2 = self.conn.execute("SELECT * FROM feeding_plans WHERE id=?",
                               (new_id,)).fetchone()
        self.assertEqual(v1["status"], "replaced")
        self.assertEqual(v2["status"], "active")
        self.assertEqual(v2["version"], 2)
        self.assertEqual(v2["lineage_id"], v1["lineage_id"])

        # 已执行任务保留在旧版本，剂量快照不重算
        done = self.conn.execute("SELECT * FROM feeding_tasks WHERE id=?",
                                 (task["id"],)).fetchone()
        self.assertEqual(done["status"], "done")
        self.assertEqual(done["plan_id"], pid)
        self.assertAlmostEqual(done["dose_g"], 18.0)
        # 旧版本未执行任务取消
        old_pending = self.conn.execute(
            "SELECT COUNT(*) c FROM feeding_tasks WHERE plan_id=? AND status='pending'",
            (pid,)).fetchone()["c"]
        self.assertEqual(old_pending, 0)
        # 新版本任务使用新剂量
        new_tasks = self.conn.execute(
            "SELECT DISTINCT dose_g FROM feeding_tasks WHERE plan_id=? AND status='pending'",
            (new_id,)).fetchall()
        self.assertTrue(new_tasks)
        self.assertTrue(all(r["dose_g"] == 25.0 for r in new_tasks))
        # 库存不被版本变更影响
        self.assertAlmostEqual(self.feed_remaining(fid), remaining_after)

    def test_update_rejected_on_replaced_version(self):
        pid, _, _ = self.make_plan(dose=18.0)
        new_id = service.update_plan(self.conn, pid, dose_g=19.0)
        with self.assertRaises(ValueError):
            service.update_plan(self.conn, pid, dose_g=20.0)
        # 最新版本仍可继续变更 => v3
        v3 = service.update_plan(self.conn, new_id, dose_g=20.0)
        ver = self.conn.execute("SELECT version FROM feeding_plans WHERE id=?",
                                (v3,)).fetchone()["version"]
        self.assertEqual(ver, 3)

    def test_done_task_immune_to_later_plan_dose(self):
        pid, _, fid = self.make_plan(dose=10.0)
        task = self.pending_task(pid)
        service.complete_feeding(self.conn, task["scan_code"], "甲")
        deducted = 1000.0 - self.feed_remaining(fid)
        self.assertAlmostEqual(deducted, 10.0)
        service.update_plan(self.conn, pid, dose_g=99.0)
        done = self.conn.execute("SELECT dose_g FROM feeding_tasks WHERE id=?",
                                 (task["id"],)).fetchone()
        self.assertAlmostEqual(done["dose_g"], 10.0)


class TestDuplicateScan(BaseCase):
    """重复扫码不得重复完成任务/扣减。"""

    def test_duplicate_feeding_scan(self):
        pid, _, fid = self.make_plan(dose=20.0)
        task = self.pending_task(pid)
        code = task["scan_code"]
        r1 = service.complete_feeding(self.conn, code, "测试员")
        self.assertEqual(r1["result"], "ok")
        r2 = service.complete_feeding(self.conn, code, "测试员")
        self.assertEqual(r2["result"], "duplicate")
        r3 = service.complete_feeding(self.conn, code, "另一人")
        self.assertEqual(r3["result"], "duplicate")
        # 只扣减一次
        self.assertAlmostEqual(self.feed_remaining(fid), 980.0)
        # 扫码事件留痕：1 ok + 2 duplicate
        n_ok = self.conn.execute(
            "SELECT COUNT(*) c FROM scan_events WHERE code=? AND result='ok'",
            (code,)).fetchone()["c"]
        n_dup = self.conn.execute(
            "SELECT COUNT(*) c FROM scan_events WHERE code=? AND result='duplicate'",
            (code,)).fetchone()["c"]
        self.assertEqual(n_ok, 1)
        self.assertEqual(n_dup, 2)

    def test_invalid_scan_code(self):
        r = service.complete_feeding(self.conn, "NOT-EXIST", "测试员")
        self.assertEqual(r["result"], "invalid")

    def test_duplicate_handling_scan(self):
        aid = service.raise_anomaly(self.conn, "refusal", "拒食", None)
        ht = self.conn.execute(
            "SELECT * FROM handling_tasks WHERE anomaly_id=?", (aid,)).fetchone()
        r1 = service.complete_handling(self.conn, ht["scan_code"], "测试员")
        r2 = service.complete_handling(self.conn, ht["scan_code"], "测试员")
        self.assertEqual(r1["result"], "ok")
        self.assertEqual(r2["result"], "duplicate")
        done_n = self.conn.execute(
            "SELECT COUNT(*) c FROM handling_tasks WHERE id=? AND status='done'",
            (ht["id"],)).fetchone()["c"]
        self.assertEqual(done_n, 1)


class TestInspectionFreeze(BaseCase):
    """点检未通过冻结关联投喂计划。"""

    def test_fail_freezes_plan_and_blocks_feeding(self):
        pid, tid, fid = self.make_plan()
        eid = self.add_equipment(tid)
        service.inspect_equipment(self.conn, eid, "fail", note="电机故障")
        plan = self.conn.execute("SELECT * FROM feeding_plans WHERE id=?",
                                 (pid,)).fetchone()
        self.assertEqual(plan["status"], "frozen")
        self.assertIn("点检未通过", plan["frozen_reason"])
        # 水槽状态冻结
        tank = self.conn.execute("SELECT status FROM tanks WHERE id=?",
                                 (tid,)).fetchone()
        self.assertEqual(tank["status"], "frozen")
        # 设备停机 + 停机异常 + 处置任务
        eq = self.conn.execute("SELECT status FROM equipment WHERE id=?",
                               (eid,)).fetchone()
        self.assertEqual(eq["status"], "stopped")
        anom = self.conn.execute(
            "SELECT * FROM anomalies WHERE kind='filter_stop' AND status!='resolved'"
        ).fetchall()
        self.assertTrue(anom)
        ht = self.conn.execute(
            "SELECT COUNT(*) c FROM handling_tasks h JOIN anomalies a ON a.id=h.anomaly_id "
            "WHERE a.kind='filter_stop'").fetchone()["c"]
        self.assertGreaterEqual(ht, 1)
        # 冻结期间 pending 任务已取消；手工插入一条模拟残留任务也必须拒绝完成
        cur = self.conn.execute(
            "INSERT INTO feeding_tasks(plan_id,plan_version,tank_id,feed_batch_id,"
            "dose_g,scheduled_at,status,scan_code) VALUES(?,1,?,?,?,?,'pending',?)",
            (pid, tid, fid, 20.0,
             (datetime.now() + timedelta(hours=1)).strftime("%Y-%m-%dT%H:%M:%S"),
             "FT-FROZEN-X"))
        r = service.complete_feeding(self.conn, "FT-FROZEN-X", "测试员")
        self.assertEqual(r["result"], "frozen")
        self.assertAlmostEqual(self.feed_remaining(fid), 1000.0)

    def test_pass_recheck_unfreezes(self):
        pid, tid, _ = self.make_plan()
        eid = self.add_equipment(tid)
        service.inspect_equipment(self.conn, eid, "fail", note="故障")
        service.inspect_equipment(self.conn, eid, "pass", note="复核通过复机")
        plan = self.conn.execute("SELECT * FROM feeding_plans WHERE id=?",
                                 (pid,)).fetchone()
        self.assertEqual(plan["status"], "active")
        self.assertEqual(plan["frozen_reason"], "")
        eq = self.conn.execute("SELECT status FROM equipment WHERE id=?",
                               (eid,)).fetchone()
        self.assertEqual(eq["status"], "running")
        # 解冻后重新生成任务
        pending = self.conn.execute(
            "SELECT COUNT(*) c FROM feeding_tasks WHERE plan_id=? AND status='pending'",
            (pid,)).fetchone()["c"]
        self.assertGreater(pending, 0)
        # 水槽恢复正常
        tank = self.conn.execute("SELECT status FROM tanks WHERE id=?",
                                 (tid,)).fetchone()
        self.assertEqual(tank["status"], "normal")

    def test_new_plan_frozen_while_tank_frozen(self):
        pid, tid, fid = self.make_plan()
        eid = self.add_equipment(tid)
        service.inspect_equipment(self.conn, eid, "fail", note="故障")
        # 冻结期间新建计划也必须冻结且不生成任务
        start = service.today_str()
        end = (datetime.now().date() + timedelta(days=10)).isoformat()
        new_pid = service.create_plan(self.conn, tid, fid, 12.0, ["09:00"], start, end)
        p = self.conn.execute("SELECT status FROM feeding_plans WHERE id=?",
                              (new_pid,)).fetchone()
        self.assertEqual(p["status"], "frozen")
        n = self.conn.execute(
            "SELECT COUNT(*) c FROM feeding_tasks WHERE plan_id=?",
            (new_pid,)).fetchone()["c"]
        self.assertEqual(n, 0)


class TestReadings(BaseCase):
    """补录读数须保留采集时间和设备编号。"""

    def test_backfilled_reading_preserved(self):
        tid = self.add_tank()
        collected = (datetime.now() - timedelta(days=2)
                     ).strftime("%Y-%m-%dT%H:%M:%S")
        rid, backfilled = service.add_reading(
            self.conn, tid, "temperature", 25.1, "℃", "TH-01-BACKUP",
            collected_at=collected)
        self.assertTrue(backfilled)
        r = self.conn.execute("SELECT * FROM water_readings WHERE id=?",
                              (rid,)).fetchone()
        self.assertEqual(r["collected_at"], collected)  # 采集时间原样保留
        self.assertEqual(r["device_no"], "TH-01-BACKUP")  # 设备编号保留
        self.assertNotEqual(r["recorded_at"], collected)
        self.assertEqual(r["backfilled"], 1)

    def test_device_no_required(self):
        tid = self.add_tank()
        with self.assertRaises(ValueError):
            service.add_reading(self.conn, tid, "temperature", 25.0, "℃", "")

    def test_temperature_anomaly_generated(self):
        tid = self.add_tank(tmin=24.0, tmax=26.0)
        service.add_reading(self.conn, tid, "temperature", 28.5, "℃", "TH-01")
        anom = self.conn.execute(
            "SELECT * FROM anomalies WHERE kind='temp' AND status!='resolved'"
        ).fetchall()
        self.assertEqual(len(anom), 1)
        ht = self.conn.execute(
            "SELECT COUNT(*) c FROM handling_tasks h JOIN anomalies a ON a.id=h.anomaly_id "
            "WHERE a.kind='temp'").fetchone()["c"]
        self.assertEqual(ht, 1)
        # 正常温度不生成异常
        service.add_reading(self.conn, tid, "temperature", 25.0, "℃", "TH-01")
        self.assertEqual(
            self.conn.execute(
                "SELECT COUNT(*) c FROM anomalies WHERE kind='temp'").fetchone()["c"], 1)


class TestMissedAndReminder(BaseCase):
    """漏投处置与到期提醒。"""

    def test_missed_generates_handling_task(self):
        pid, tid, fid = self.make_plan(dose=20.0)
        past = (datetime.now() - timedelta(minutes=31)
                ).strftime("%Y-%m-%dT%H:%M:%S")
        self.conn.execute(
            "INSERT INTO feeding_tasks(plan_id,plan_version,tank_id,feed_batch_id,"
            "dose_g,scheduled_at,status,scan_code) VALUES(?,1,?,?,?,?,'pending',?)",
            (pid, tid, fid, 20.0, past, "FT-M1"))
        n = service.sweep_missed(self.conn)
        self.assertEqual(n, 1)
        anom = self.conn.execute(
            "SELECT * FROM anomalies WHERE kind='missed_feed'").fetchone()
        self.assertIsNotNone(anom)
        self.assertEqual(
            self.conn.execute("SELECT status FROM feeding_tasks WHERE scan_code='FT-M1'"
                              ).fetchone()["status"], "missed")

    def test_within_grace_not_missed(self):
        pid, tid, fid = self.make_plan(dose=20.0)
        past = (datetime.now() - timedelta(minutes=10)
                ).strftime("%Y-%m-%dT%H:%M:%S")
        self.conn.execute(
            "INSERT INTO feeding_tasks(plan_id,plan_version,tank_id,feed_batch_id,"
            "dose_g,scheduled_at,status,scan_code) VALUES(?,1,?,?,?,?,'pending',?)",
            (pid, tid, fid, 20.0, past, "FT-GRACE"))
        self.assertEqual(service.sweep_missed(self.conn), 0)

    def test_due_reminder(self):
        pid, tid, fid = self.make_plan(dose=20.0)
        due = datetime.now().strftime("%Y-%m-%dT%H:%M:%S")
        self.conn.execute(
            "INSERT INTO feeding_tasks(plan_id,plan_version,tank_id,feed_batch_id,"
            "dose_g,scheduled_at,status,scan_code) VALUES(?,1,?,?,?,?,'pending',?)",
            (pid, tid, fid, 20.0, due, "FT-DUE"))
        fired = service.sweep_due_reminders(self.conn)
        self.assertEqual(fired, 1)
        # 幂等：再次扫描不重复提醒
        self.assertEqual(service.sweep_due_reminders(self.conn), 0)


class TestFeedExpiryAndRefusal(BaseCase):
    def test_expired_feed_anomaly_and_block_feeding(self):
        tid = self.add_tank()
        fid = self.add_feed(no="FB-OLD", remaining=500.0, expiry_days=-5)
        service.check_feed_expiry(self.conn)
        anom = self.conn.execute(
            "SELECT * FROM anomalies WHERE kind='feed_expired'").fetchone()
        self.assertIsNotNone(anom)
        # 用过期饲料的任务扫码必须被拦（直接构造计划与任务）
        cur = self.conn.execute(
            "INSERT INTO feeding_plans(tank_id,feed_batch_id,dose_g,times,start_date,"
            "end_date,version,status,created_at) VALUES(?,?,20.0,'[\"09:00\"]',?,?,1,"
            "'active',?)",
            (tid, fid, service.today_str(), service.today_str(), service.now_iso()))
        pid = cur.lastrowid
        self.conn.execute(
            "UPDATE feeding_plans SET lineage_id=id WHERE id=?", (pid,))
        self.conn.execute(
            "INSERT INTO feeding_tasks(plan_id,plan_version,tank_id,feed_batch_id,"
            "dose_g,scheduled_at,status,scan_code) VALUES(?,1,?,?,?,?,'pending',?)",
            (pid, tid, fid, 20.0,
             (datetime.now() + timedelta(hours=1)).strftime("%Y-%m-%dT%H:%M:%S"),
             "FT-EXPIRED"))
        self.conn.commit()
        r = service.complete_feeding(self.conn, "FT-EXPIRED", "测试员")
        self.assertEqual(r["result"], "feed_expired")
        self.assertAlmostEqual(self.feed_remaining(fid), 500.0)

    def test_refusal_anomaly(self):
        tid = self.add_tank()
        service.log_refusal(self.conn, tid, "不进食")
        anom = self.conn.execute(
            "SELECT * FROM anomalies WHERE kind='refusal'").fetchone()
        self.assertIsNotNone(anom)
        self.assertEqual(anom["tank_id"], tid)


if __name__ == "__main__":
    unittest.main(verbosity=2)
