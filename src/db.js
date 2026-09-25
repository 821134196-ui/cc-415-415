'use strict';

const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');

const DATA_DIR = path.join(__dirname, '..', 'data');

const SCHEMA = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS tanks (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  code        TEXT NOT NULL UNIQUE,          -- 水槽编号 T-01
  name        TEXT NOT NULL,
  species     TEXT NOT NULL DEFAULT '',      -- 生物种类（演示数据）
  bio_count   INTEGER NOT NULL DEFAULT 0,    -- 生物数量
  feed_type   TEXT NOT NULL DEFAULT '',      -- 配置饲料类型
  temp_min    REAL NOT NULL DEFAULT 24,      -- 水温正常区间
  temp_max    REAL NOT NULL DEFAULT 28
);

CREATE TABLE IF NOT EXISTS bio_batches (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_code   TEXT NOT NULL UNIQUE,         -- 生物编号 BIO-2026-xxx（演示数据）
  tank_id      INTEGER NOT NULL REFERENCES tanks(id),
  species      TEXT NOT NULL,
  count        INTEGER NOT NULL,
  introduced_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS feed_batches (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_code      TEXT NOT NULL UNIQUE,      -- 饲料批次号
  feed_type       TEXT NOT NULL,
  expiry_date     TEXT NOT NULL,             -- 有效期 YYYY-MM-DD
  initial_qty_g   REAL NOT NULL,
  remaining_qty_g REAL NOT NULL,             -- 剩余量，仅在投喂任务完成后扣减
  status          TEXT NOT NULL DEFAULT 'active'  -- active / expired / depleted
);

CREATE TABLE IF NOT EXISTS feeding_plans (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  tank_id       INTEGER NOT NULL REFERENCES tanks(id),
  version       INTEGER NOT NULL,            -- 计划版本，变更保留历史
  feed_batch_id INTEGER NOT NULL REFERENCES feed_batches(id),
  dose_g        REAL NOT NULL,               -- 单次剂量
  slots         TEXT NOT NULL,               -- JSON 数组 ["08:30","12:30"]
  status        TEXT NOT NULL DEFAULT 'active',  -- active / frozen / superseded
  created_at    TEXT NOT NULL,
  created_by    TEXT NOT NULL DEFAULT '',
  UNIQUE (tank_id, version)
);

CREATE TABLE IF NOT EXISTS feeding_tasks (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_id        INTEGER NOT NULL REFERENCES feeding_plans(id),
  plan_version   INTEGER NOT NULL,           -- 快照：已执行任务不能重算
  tank_id        INTEGER NOT NULL REFERENCES tanks(id),
  feed_batch_id  INTEGER NOT NULL REFERENCES feed_batches(id),  -- 快照
  dose_g         REAL NOT NULL,              -- 快照
  slot           TEXT NOT NULL,
  scheduled_date TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'pending',  -- pending/completed/missed/frozen/cancelled
  scan_token     TEXT NOT NULL UNIQUE,       -- 扫码令牌，重复扫码幂等
  completed_at   TEXT,
  completed_by   TEXT,
  UNIQUE (scheduled_date, plan_id, slot)
);

CREATE TABLE IF NOT EXISTS equipment (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  tank_id     INTEGER NOT NULL REFERENCES tanks(id),
  device_code TEXT NOT NULL UNIQUE,          -- 设备编号 FLT-T01-1
  kind        TEXT NOT NULL,                 -- filter / pump / heater
  pos_x       REAL NOT NULL DEFAULT 50,      -- 平面图定位（百分比）
  pos_y       REAL NOT NULL DEFAULT 50,
  status      TEXT NOT NULL DEFAULT 'running'  -- running / stopped
);

CREATE TABLE IF NOT EXISTS inspections (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  equipment_id INTEGER NOT NULL REFERENCES equipment(id),
  inspected_at TEXT NOT NULL,
  inspector    TEXT NOT NULL DEFAULT '',
  result       TEXT NOT NULL,                -- pass / fail
  photo_path   TEXT,                         -- 点检照片（本地文件）
  notes        TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS water_readings (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  tank_id      INTEGER NOT NULL REFERENCES tanks(id),
  device_id    TEXT NOT NULL,                -- 采集设备编号（补录必填）
  temp_c       REAL NOT NULL,
  ph           REAL,
  do_mg_l      REAL,
  collected_at TEXT NOT NULL,                -- 采集时间（补录必填）
  recorded_at  TEXT NOT NULL,                -- 系统录入时间
  source       TEXT NOT NULL DEFAULT 'live', -- live / backfill
  operator     TEXT
);

CREATE TABLE IF NOT EXISTS anomalies (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  kind        TEXT NOT NULL,                 -- temp/filter_stop/refusal/feed_expired/missed_feeding
  tank_id     INTEGER REFERENCES tanks(id),
  ref_key     TEXT NOT NULL DEFAULT '',      -- 归组键（设备/水槽/批次）
  status      TEXT NOT NULL DEFAULT 'open',  -- open / acked / resolved
  detail      TEXT NOT NULL DEFAULT '',
  dedupe_key  TEXT UNIQUE,                   -- 防重复生成
  created_at  TEXT NOT NULL,
  resolved_at TEXT
);

CREATE TABLE IF NOT EXISTS handling_tasks (   -- 处置任务
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  anomaly_id INTEGER NOT NULL REFERENCES anomalies(id),
  title      TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'open',   -- open / done
  due_at     TEXT,
  done_at    TEXT,
  done_by    TEXT
);

CREATE TABLE IF NOT EXISTS handovers (        -- 交接日志
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  shift      TEXT NOT NULL,
  from_user  TEXT NOT NULL,
  to_user    TEXT NOT NULL,
  summary    TEXT NOT NULL DEFAULT '',
  digest     TEXT NOT NULL DEFAULT '',       -- 交接时点的运营摘要
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS reminders (        -- 进程内到期提醒
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  dedupe_key TEXT NOT NULL UNIQUE,
  kind       TEXT NOT NULL,                  -- feeding_due / handling_due / feed_expiring
  message    TEXT NOT NULL,
  created_at TEXT NOT NULL,
  acked      INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_tasks_date    ON feeding_tasks(scheduled_date, status);
CREATE INDEX IF NOT EXISTS idx_readings_tank ON water_readings(tank_id, collected_at);
CREATE INDEX IF NOT EXISTS idx_anom_status   ON anomalies(status);
`;

function open(dbPath) {
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  if (dbPath !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);
  return db;
}

function defaultDbPath() { return path.join(DATA_DIR, 'aquarium.db'); }

module.exports = { open, defaultDbPath, DATA_DIR };
