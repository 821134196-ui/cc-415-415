"""进程内任务处理：到期提醒 + 漏投检测 + 计划任务滚动生成。

随主进程启动的后台线程，不依赖外部调度器。
"""
import threading
import time

import db
import service

INTERVAL_SEC = 20


def _tick(db_path):
    conn = db.connect(db_path)
    try:
        service.sweep_due_reminders(conn)   # 投喂到期提醒
        service.sweep_missed(conn)          # 漏投检测 => 异常 + 处置任务
        service.regenerate_all(conn)        # 滚动生成未来投喂任务
        service.check_feed_expiry(conn)     # 饲料过期巡检
    finally:
        conn.close()


def start(db_path=db.DEFAULT_DB, interval=INTERVAL_SEC):
    stop = threading.Event()

    def loop():
        while not stop.is_set():
            try:
                _tick(db_path)
            except Exception as e:  # 后台线程不拖垮主进程
                print(f"[reminder] tick error: {e}", flush=True)
            stop.wait(interval)

    t = threading.Thread(target=loop, name="reminder", daemon=True)
    t.start()
    return t, stop
