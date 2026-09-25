"""SQLite 数据层：连接与建表。

所有时间统一使用本地 ISO 字符串（YYYY-MM-DDTHH:MM:SS），便于排序与比较。
"""
import os
import sqlite3

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(BASE_DIR, "data")
PHOTO_DIR = os.path.join(DATA_DIR, "photos")
DEFAULT_DB = os.path.join(DATA_DIR, "aquarium.db")

SCHEMA = """
CREATE TABLE IF NOT EXISTS tanks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT NOT NULL UNIQUE,          -- 水槽编号，如 T-01
    name TEXT NOT NULL,
    volume_l REAL NOT NULL,             -- 水体容积（升）
    temp_min REAL NOT NULL,             -- 水温正常下限
    temp_max REAL NOT NULL,             -- 水温正常上限
    pos_x REAL NOT NULL DEFAULT 0,      -- 平面水槽图坐标（百分比）
    pos_y REAL NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'normal'   -- normal / frozen / alert
);

CREATE TABLE IF NOT EXISTS creature_batches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tank_id INTEGER NOT NULL REFERENCES tanks(id),
    batch_no TEXT NOT NULL UNIQUE,      -- 生物编号（演示数据）
    species TEXT NOT NULL,
    quantity INTEGER NOT NULL,
    note TEXT DEFAULT ''
);

CREATE TABLE IF NOT EXISTS feed_batches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    batch_no TEXT NOT NULL UNIQUE,      -- 饲料批次号
    feed_type TEXT NOT NULL,            -- 饲料类型
    expiry_date TEXT NOT NULL,          -- 有效期 YYYY-MM-DD
    remaining_g REAL NOT NULL,          -- 剩余量（克）
    initial_g REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS feeding_plans (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tank_id INTEGER NOT NULL REFERENCES tanks(id),
    feed_batch_id INTEGER NOT NULL REFERENCES feed_batches(id),
    dose_g REAL NOT NULL,               -- 单次剂量（克）
    times TEXT NOT NULL,                -- 投喂时段 JSON 数组 ["08:00","14:00"]
    start_date TEXT NOT NULL,
    end_date TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1, -- 计划版本（同一 lineage 递增）
    lineage_id INTEGER,                 -- 版本链：首版指向自身 id，变更时沿用
    status TEXT NOT NULL DEFAULT 'active',  -- active / frozen / replaced / archived
    frozen_reason TEXT DEFAULT '',
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS feeding_tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    plan_id INTEGER NOT NULL REFERENCES feeding_plans(id),
    plan_version INTEGER NOT NULL,      -- 生成任务时的计划版本（快照）
    tank_id INTEGER NOT NULL REFERENCES tanks(id),
    feed_batch_id INTEGER NOT NULL REFERENCES feed_batches(id),
    dose_g REAL NOT NULL,               -- 任务剂量快照，已执行任务不可重算
    scheduled_at TEXT NOT NULL,         -- 计划时间
    status TEXT NOT NULL DEFAULT 'pending',  -- pending / done / missed / cancelled
    scan_code TEXT NOT NULL UNIQUE,     -- 扫码完成用唯一码
    completed_at TEXT,
    completed_by TEXT DEFAULT '',
    UNIQUE(plan_id, scheduled_at)       -- 同一计划同一时刻只生成一次任务
);

CREATE TABLE IF NOT EXISTS equipment (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tank_id INTEGER NOT NULL REFERENCES tanks(id),
    code TEXT NOT NULL UNIQUE,          -- 设备编号
    kind TEXT NOT NULL,                 -- filter / heater / pump ...
    name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'running'  -- running / stopped
);

CREATE TABLE IF NOT EXISTS inspections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    equipment_id INTEGER NOT NULL REFERENCES equipment(id),
    result TEXT NOT NULL,               -- pass / fail
    note TEXT DEFAULT '',
    photo_path TEXT DEFAULT '',         -- 本地文件路径（点检照片）
    inspector TEXT DEFAULT '',
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS water_readings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tank_id INTEGER NOT NULL REFERENCES tanks(id),
    kind TEXT NOT NULL,                 -- temperature / ph / ammonia ...
    value REAL NOT NULL,
    unit TEXT DEFAULT '',
    device_no TEXT NOT NULL,            -- 采集设备编号（必填）
    collected_at TEXT NOT NULL,         -- 采集时间（必填，补录保留原值）
    recorded_at TEXT NOT NULL,          -- 录入系统时间
    backfilled INTEGER NOT NULL DEFAULT 0   -- 1 = 补录
);

CREATE TABLE IF NOT EXISTS anomalies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tank_id INTEGER REFERENCES tanks(id),
    kind TEXT NOT NULL,   -- temp / filter_stop / refusal / feed_expired / missed_feed
    title TEXT NOT NULL,
    detail TEXT DEFAULT '',
    status TEXT NOT NULL DEFAULT 'open',   -- open / handling / resolved
    created_at TEXT NOT NULL,
    dedupe_key TEXT UNIQUE              -- 未关闭同类异常去重
);

CREATE TABLE IF NOT EXISTS handling_tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    anomaly_id INTEGER NOT NULL REFERENCES anomalies(id),
    title TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open',   -- open / done
    scan_code TEXT NOT NULL UNIQUE,
    assignee TEXT DEFAULT '',
    created_at TEXT NOT NULL,
    completed_at TEXT,
    completed_by TEXT DEFAULT ''
);

CREATE TABLE IF NOT EXISTS handoffs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    shift_date TEXT NOT NULL,
    from_person TEXT NOT NULL,
    to_person TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS scan_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT NOT NULL,
    task_type TEXT NOT NULL,            -- feeding / handling
    task_id INTEGER NOT NULL,
    result TEXT NOT NULL,               -- ok / duplicate / invalid
    scanned_at TEXT NOT NULL,
    operator TEXT DEFAULT ''
);

CREATE TABLE IF NOT EXISTS reminders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,                 -- feeding_due / feeding_missed / inspection_due
    ref_id INTEGER NOT NULL,
    message TEXT NOT NULL,
    fired_at TEXT NOT NULL,
    read INTEGER NOT NULL DEFAULT 0,
    UNIQUE(kind, ref_id)
);

CREATE INDEX IF NOT EXISTS idx_tasks_time ON feeding_tasks(scheduled_at);
CREATE INDEX IF NOT EXISTS idx_readings_tank ON water_readings(tank_id, collected_at);
"""


def connect(db_path=DEFAULT_DB):
    os.makedirs(os.path.dirname(db_path), exist_ok=True)
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init_db(db_path=DEFAULT_DB):
    os.makedirs(PHOTO_DIR, exist_ok=True)
    conn = connect(db_path)
    conn.executescript(SCHEMA)
    conn.commit()
    return conn
