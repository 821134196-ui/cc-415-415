"""水族馆水槽投喂与设备点检系统 —— 单文件 HTTP 服务（仅标准库）。

启动：
    python3 app.py            # 启动服务（无数据时自动建库）
    python3 app.py --demo     # 重建演示数据（投喂/停机/复核样例）并启动服务
    python3 app.py --port 8080
"""
import argparse
import json
import os
import re
import sys
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

import db
import reminder
import service

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(BASE_DIR, "static")


# ---------- 工具 ----------
def json_body(handler):
    length = int(handler.headers.get("Content-Length") or 0)
    raw = handler.rfile.read(length) if length else b"{}"
    try:
        return json.loads(raw.decode("utf-8") or "{}")
    except json.JSONDecodeError:
        raise ValueError("请求体不是合法 JSON")


def parse_multipart(handler):
    """极简 multipart/form-data 解析，返回 (fields, files)。

    files: {name: (filename, bytes)}
    """
    ctype = handler.headers.get("Content-Type", "")
    m = re.search(r"boundary=(.+)", ctype)
    if not m:
        raise ValueError("缺少 multipart boundary")
    boundary = m.group(1).strip().strip('"').encode()
    length = int(handler.headers.get("Content-Length") or 0)
    body = handler.rfile.read(length)
    fields, files = {}, {}
    for part in body.split(b"--" + boundary):
        part = part.strip(b"\r\n")
        if not part or part == b"--":
            continue
        if b"\r\n\r\n" not in part:
            continue
        head, _, content = part.partition(b"\r\n\r\n")
        head = head.decode("utf-8", "replace")
        name_m = re.search(r'name="([^"]+)"', head)
        if not name_m:
            continue
        name = name_m.group(1)
        file_m = re.search(r'filename="([^"]*)"', head)
        if file_m and file_m.group(1):
            files[name] = (file_m.group(1), content)
        else:
            fields[name] = content.decode("utf-8", "replace").strip()
    return fields, files


def save_photo(filename, content):
    """点检照片保存到本地文件，返回可访问的相对路径。"""
    ext = os.path.splitext(filename)[1].lower()
    if ext not in (".jpg", ".jpeg", ".png", ".gif", ".webp", ".svg"):
        ext = ".jpg"
    safe = f"insp_{uuid.uuid4().hex[:12]}{ext}"
    os.makedirs(db.PHOTO_DIR, exist_ok=True)
    path = os.path.join(db.PHOTO_DIR, safe)
    with open(path, "wb") as f:
        f.write(content)
    return path


# ---------- API 处理 ----------
def api_get_tanks(conn, _q):
    return service.tank_overview(conn)


def api_get_tank_readings(conn, q, tank_id):
    rows = conn.execute(
        "SELECT * FROM water_readings WHERE tank_id=? ORDER BY collected_at DESC LIMIT 100",
        (tank_id,)).fetchall()
    return [dict(r) for r in rows]


def api_post_reading(conn, body):
    rid, backfilled = service.add_reading(
        conn, int(body["tank_id"]), body["kind"], float(body["value"]),
        body.get("unit", ""), body.get("device_no", ""),
        collected_at=body.get("collected_at") or None)
    return {"id": rid, "backfilled": backfilled}


def api_get_calendar(conn, q):
    day = q.get("date", [service.today_str()])[0]
    rows = conn.execute(
        "SELECT t.*, tk.code tank_code, tk.name tank_name, fb.feed_type, fb.batch_no, "
        "fb.remaining_g, fb.expiry_date, p.status plan_status, p.frozen_reason "
        "FROM feeding_tasks t "
        "JOIN tanks tk ON tk.id=t.tank_id "
        "JOIN feed_batches fb ON fb.id=t.feed_batch_id "
        "JOIN feeding_plans p ON p.id=t.plan_id "
        "WHERE substr(t.scheduled_at,1,10)=? AND t.status!='cancelled' "
        "ORDER BY t.scheduled_at", (day,)).fetchall()
    return [dict(r) for r in rows]


def api_get_plans(conn, _q):
    rows = conn.execute(
        "SELECT p.*, tk.code tank_code, fb.batch_no, fb.feed_type, fb.remaining_g "
        "FROM feeding_plans p JOIN tanks tk ON tk.id=p.tank_id "
        "JOIN feed_batches fb ON fb.id=p.feed_batch_id "
        "ORDER BY p.lineage_id, p.version").fetchall()
    out = []
    for r in rows:
        d = dict(r)
        d["times"] = json.loads(d["times"])
        out.append(d)
    return out


def api_post_plan(conn, body):
    pid = service.create_plan(
        conn, int(body["tank_id"]), int(body["feed_batch_id"]),
        float(body["dose_g"]), body["times"],
        body["start_date"], body["end_date"])
    return {"id": pid}


def api_update_plan(conn, body, plan_id):
    changes = {}
    for k in ("dose_g", "times", "start_date", "end_date", "feed_batch_id"):
        if k in body and body[k] is not None:
            changes[k] = float(body[k]) if k == "dose_g" else body[k]
    new_id = service.update_plan(conn, plan_id, **changes)
    return {"id": new_id}


def api_scan_feeding(conn, body):
    return service.complete_feeding(conn, body.get("code", ""),
                                    body.get("operator", ""))


def api_scan_handling(conn, body):
    return service.complete_handling(conn, body.get("code", ""),
                                     body.get("operator", ""))


def api_get_feeds(conn, _q):
    rows = conn.execute("SELECT * FROM feed_batches ORDER BY batch_no").fetchall()
    today = service.today_str()
    out = []
    for r in rows:
        d = dict(r)
        d["expired"] = d["expiry_date"] < today
        out.append(d)
    return out


def api_get_equipment(conn, _q):
    rows = conn.execute(
        "SELECT e.*, tk.code tank_code, tk.name tank_name FROM equipment e "
        "JOIN tanks tk ON tk.id=e.tank_id ORDER BY e.code").fetchall()
    out = []
    for r in rows:
        d = dict(r)
        last = conn.execute(
            "SELECT result,created_at,inspector FROM inspections WHERE equipment_id=? "
            "ORDER BY id DESC LIMIT 1", (r["id"],)).fetchone()
        d["last_inspection"] = dict(last) if last else None
        out.append(d)
    return out


def api_set_equipment_status(conn, body, eq_id):
    service.set_equipment_status(conn, eq_id, body["status"], body.get("note", ""))
    return {"ok": True}


def api_get_inspections(conn, q):
    sql = ("SELECT i.*, e.code equipment_code, e.name equipment_name, tk.code tank_code "
           "FROM inspections i JOIN equipment e ON e.id=i.equipment_id "
           "JOIN tanks tk ON tk.id=e.tank_id")
    params = []
    if q.get("equipment_id"):
        sql += " WHERE i.equipment_id=?"
        params.append(int(q["equipment_id"][0]))
    sql += " ORDER BY i.id DESC LIMIT 100"
    rows = conn.execute(sql, params).fetchall()
    out = []
    for r in rows:
        d = dict(r)
        # 照片路径转为可访问 URL
        if d["photo_path"]:
            d["photo_url"] = "/photos/" + os.path.basename(d["photo_path"])
        out.append(d)
    return out


def api_post_inspection(conn, handler):
    fields, files = parse_multipart(handler)
    photo_path = ""
    if "photo" in files:
        photo_path = save_photo(*files["photo"])
    iid = service.inspect_equipment(
        conn, int(fields["equipment_id"]), fields["result"],
        note=fields.get("note", ""), photo_path=photo_path,
        inspector=fields.get("inspector", ""))
    return {"id": iid}


def api_get_anomalies(conn, _q):
    rows = conn.execute(
        "SELECT a.*, tk.code tank_code FROM anomalies a "
        "LEFT JOIN tanks tk ON tk.id=a.tank_id ORDER BY a.id DESC LIMIT 200").fetchall()
    return [dict(r) for r in rows]


def api_post_refusal(conn, body):
    aid = service.log_refusal(conn, int(body["tank_id"]), body.get("detail", ""))
    return {"id": aid}


def api_resolve_anomaly(conn, _body, anomaly_id):
    service.resolve_anomaly(conn, anomaly_id)
    row = conn.execute("SELECT tank_id FROM anomalies WHERE id=?",
                       (anomaly_id,)).fetchone()
    if row and row["tank_id"]:
        service._refresh_tank_status(conn, row["tank_id"])
    conn.commit()
    return {"ok": True}


def api_get_handling(conn, _q):
    rows = conn.execute(
        "SELECT h.*, a.kind anomaly_kind, a.title anomaly_title, tk.code tank_code "
        "FROM handling_tasks h JOIN anomalies a ON a.id=h.anomaly_id "
        "LEFT JOIN tanks tk ON tk.id=a.tank_id "
        "ORDER BY h.id DESC LIMIT 200").fetchall()
    return [dict(r) for r in rows]


def api_get_handoffs(conn, _q):
    rows = conn.execute("SELECT * FROM handoffs ORDER BY id DESC LIMIT 100").fetchall()
    return [dict(r) for r in rows]


def api_post_handoff(conn, body):
    hid = service.add_handoff(conn, body["shift_date"], body["from_person"],
                              body["to_person"], body["content"])
    return {"id": hid}


def api_get_reminders(conn, _q):
    rows = conn.execute(
        "SELECT * FROM reminders WHERE read=0 ORDER BY id DESC LIMIT 50").fetchall()
    return [dict(r) for r in rows]


def api_read_reminders(conn, _body):
    conn.execute("UPDATE reminders SET read=1 WHERE read=0")
    conn.commit()
    return {"ok": True}


# ---------- 路由 ----------
GET_ROUTES = [
    (r"^/api/tanks$", api_get_tanks),
    (r"^/api/tanks/(\d+)/readings$", api_get_tank_readings),
    (r"^/api/calendar$", api_get_calendar),
    (r"^/api/plans$", api_get_plans),
    (r"^/api/feeds$", api_get_feeds),
    (r"^/api/equipment$", api_get_equipment),
    (r"^/api/inspections$", api_get_inspections),
    (r"^/api/anomalies$", api_get_anomalies),
    (r"^/api/handling-tasks$", api_get_handling),
    (r"^/api/handoffs$", api_get_handoffs),
    (r"^/api/reminders$", api_get_reminders),
]

POST_ROUTES = [
    (r"^/api/readings$", api_post_reading),
    (r"^/api/plans$", api_post_plan),
    (r"^/api/plans/(\d+)/update$", api_update_plan),
    (r"^/api/scan/feeding$", api_scan_feeding),
    (r"^/api/scan/handling$", api_scan_handling),
    (r"^/api/equipment/(\d+)/status$", api_set_equipment_status),
    (r"^/api/anomalies/refusal$", api_post_refusal),
    (r"^/api/anomalies/(\d+)/resolve$", api_resolve_anomaly),
    (r"^/api/handoffs$", api_post_handoff),
    (r"^/api/reminders/read$", api_read_reminders),
]

MIME = {".html": "text/html; charset=utf-8", ".js": "application/javascript",
        ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png",
        ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
        ".webp": "image/webp"}


class Handler(BaseHTTPRequestHandler):
    server_version = "AquariumFeeding/1.0"

    def log_message(self, fmt, *args):
        sys.stderr.write("[http] " + fmt % args + "\n")

    # ---- 响应 ----
    def _json(self, obj, status=200):
        data = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _file(self, path):
        if not os.path.isfile(path):
            self._json({"error": "not found"}, 404)
            return
        ext = os.path.splitext(path)[1].lower()
        with open(path, "rb") as f:
            data = f.read()
        self.send_response(200)
        self.send_header("Content-Type", MIME.get(ext, "application/octet-stream"))
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    # ---- 分发 ----
    def do_GET(self):
        parsed = urlparse(self.path)
        path, q = parsed.path, parse_qs(parsed.query)
        if path == "/" or path == "/index.html":
            return self._file(os.path.join(STATIC_DIR, "index.html"))
        if path.startswith("/static/"):
            safe = os.path.normpath(path[len("/static/"):]).lstrip("/\\")
            return self._file(os.path.join(STATIC_DIR, safe))
        if path.startswith("/photos/"):
            name = os.path.basename(path)  # 防目录穿越
            return self._file(os.path.join(db.PHOTO_DIR, name))
        for pattern, func in GET_ROUTES:
            m = re.match(pattern, path)
            if m:
                return self._call(func, q, *m.groups())
        self._json({"error": "not found"}, 404)

    def do_POST(self):
        parsed = urlparse(self.path)
        path = parsed.path
        if path == "/api/inspections":
            return self._call_multipart(api_post_inspection)
        for pattern, func in POST_ROUTES:
            m = re.match(pattern, path)
            if m:
                return self._call(func, None, *m.groups())
        self._json({"error": "not found"}, 404)

    def _call(self, func, q, *args):
        conn = db.connect(db.DEFAULT_DB)
        try:
            if func in (f for _, f in GET_ROUTES):
                result = func(conn, q, *args)
            else:
                body = json_body(self)
                result = func(conn, body, *args)
            self._json(result)
        except ValueError as e:
            self._json({"error": str(e)}, 400)
        except KeyError as e:
            self._json({"error": f"缺少参数 {e}"}, 400)
        except Exception as e:
            self._json({"error": f"服务器错误：{e}"}, 500)
        finally:
            conn.close()

    def _call_multipart(self, func):
        conn = db.connect(db.DEFAULT_DB)
        try:
            result = func(conn, self)
            self._json(result)
        except ValueError as e:
            self._json({"error": str(e)}, 400)
        except KeyError as e:
            self._json({"error": f"缺少参数 {e}"}, 400)
        except Exception as e:
            self._json({"error": f"服务器错误：{e}"}, 500)
        finally:
            conn.close()


def main():
    ap = argparse.ArgumentParser(description="水族馆水槽投喂与设备点检系统")
    ap.add_argument("--demo", action="store_true",
                    help="重建演示数据（投喂/停机/复核样例）后启动")
    ap.add_argument("--port", type=int, default=8000)
    args = ap.parse_args()

    if args.demo:
        import seed
        path = seed.seed(reset=True)
        print(f"[demo] 演示数据已生成：{path}")
    elif not os.path.exists(db.DEFAULT_DB):
        db.init_db(db.DEFAULT_DB)
        print("[init] 已创建空数据库（可用 --demo 生成演示数据）")

    reminder.start(db.DEFAULT_DB)
    print(f"[reminder] 进程内到期提醒已启动（每 {reminder.INTERVAL_SEC}s）")

    server = ThreadingHTTPServer(("0.0.0.0", args.port), Handler)
    print(f"[server] http://localhost:{args.port}  （Ctrl+C 停止）")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[server] 已停止")


if __name__ == "__main__":
    main()
