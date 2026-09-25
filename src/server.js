'use strict';
/**
 * 零依赖 HTTP 服务：JSON API + 静态页面 + 点检照片本地文件存储。
 * 启动：node src/server.js [--port 8080] [--reseed] [--no-seed] [--db <path>]
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { open, defaultDbPath } = require('./db');
const D = require('./domain');
const scheduler = require('./scheduler');
const seed = require('./seed');
const { iso, dateStr } = require('./util');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const UPLOAD_DIR = path.join(__dirname, '..', 'uploads');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

// ---------- 小工具 ----------

function num(v) {
  if (v === '' || v === null || v === undefined) return NaN;
  return Number(v);
}
function int(v) {
  const n = Number(v);
  return Number.isInteger(n) ? n : NaN;
}

function readBody(req, limit = 12 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function sendError(res, err) {
  if (err && err.name === 'DomainError') {
    sendJson(res, err.status, { ok: false, code: err.code, message: err.message });
  } else {
    console.error('[server]', err);
    sendJson(res, 500, { ok: false, code: 'INTERNAL', message: '服务器内部错误' });
  }
}

// ---------- 路由 ----------

const routes = [];
function route(method, pattern, handler) { routes.push({ method, pattern, handler }); }

function matchRoute(method, pathname) {
  for (const r of routes) {
    if (r.method !== method) continue;
    const p = r.pattern.split('/');
    const a = pathname.split('/');
    if (p.length !== a.length) continue;
    const params = {};
    let ok = true;
    for (let i = 0; i < p.length; i++) {
      if (p[i].startsWith(':')) params[p[i].slice(1)] = decodeURIComponent(a[i]);
      else if (p[i] !== a[i]) { ok = false; break; }
    }
    if (ok) return { handler: r.handler, params };
  }
  return null;
}

function serveStatic(res, filePath) {
  fs.readFile(filePath, (err, data) => {
    if (err) { sendJson(res, 404, { ok: false, message: 'Not Found' }); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream' });
    res.end(data);
  });
}

function safeJoin(base, rel) {
  const p = path.normalize(path.join(base, rel));
  return p.startsWith(base) ? p : null;
}

// ---------- 服务工厂 ----------

function createApp(db) {
  // 健康与总览
  route('GET', '/api/health', () => ({ ok: true, now: iso(new Date()) }));
  route('GET', '/api/overview', () => ({ now: iso(new Date()), tanks: D.overview(db) }));

  // 投喂日历与扫码完成
  route('GET', '/api/calendar', ({ query }) => {
    const date = query.date || dateStr();
    return { date, grace_minutes: D.GRACE_MINUTES, tasks: D.listCalendar(db, date) };
  });
  route('POST', '/api/tasks/complete', ({ body }) =>
    D.completeTaskByToken(db, body.scan_token, body.operator));

  // 投喂计划（版本化）
  route('GET', '/api/plans', ({ query }) => D.listPlans(db, query.tank_id ? int(query.tank_id) : null));
  route('POST', '/api/plans', ({ body }) => D.createPlan(db, {
    tankId: int(body.tank_id),
    feedBatchId: int(body.feed_batch_id),
    doseG: num(body.dose_g),
    slots: body.slots,
    operator: body.operator,
  }));

  // 饲料批次
  route('GET', '/api/feeds', () => D.listFeeds(db));
  route('POST', '/api/feeds', ({ body }) => D.createFeedBatch(db, {
    batchCode: body.batch_code, feedType: body.feed_type,
    expiryDate: body.expiry_date, initialQtyG: body.initial_qty_g,
  }));

  // 设备与点检
  route('GET', '/api/equipment', () => D.listEquipment(db));
  route('GET', '/api/inspections', ({ query }) => D.listInspections(db, int(query.equipment_id)));
  route('POST', '/api/inspections', ({ body }) => D.recordInspection(db, {
    equipmentId: int(body.equipment_id),
    result: body.result,
    inspector: body.inspector,
    notes: body.notes,
    photoPath: body.photo_path || null,
    inspectedAt: body.inspected_at || null,
  }));

  // 点检照片：二进制上传，保存为本地文件
  route('POST', '/api/uploads', async ({ req }) => {
    const buf = await readBody(req);
    if (!buf.length) throw new D.DomainError(422, 'EMPTY_FILE', '上传内容为空');
    const raw = String(req.headers['x-filename'] || 'photo.jpg');
    const ext = (path.extname(raw) || '.jpg').toLowerCase().replace(/[^.a-z0-9]/g, '');
    const name = `ins-${dateStr()}-${crypto.randomBytes(4).toString('hex')}${ext || '.jpg'}`;
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
    fs.writeFileSync(path.join(UPLOAD_DIR, name), buf);
    return { path: `/uploads/${name}`, bytes: buf.length };
  });

  // 水质读数（含补录）
  route('GET', '/api/readings', ({ query }) => D.listReadings(db, query.tank_id ? int(query.tank_id) : null));
  route('POST', '/api/readings', ({ body }) => D.recordReading(db, {
    tankId: int(body.tank_id),
    deviceId: body.device_id,
    tempC: num(body.temp_c),
    ph: body.ph === '' || body.ph == null ? null : num(body.ph),
    doMgL: body.do_mg_l === '' || body.do_mg_l == null ? null : num(body.do_mg_l),
    collectedAt: body.collected_at,
    source: body.source || 'live',
    operator: body.operator || null,
  }));

  // 异常观察与处置
  route('GET', '/api/anomalies', ({ query }) => D.listAnomalies(db, query.status || 'open'));
  route('POST', '/api/anomalies/:id/ack', ({ params }) => D.ackAnomaly(db, int(params.id)));
  route('POST', '/api/anomalies/:id/resolve', ({ params, body }) => D.resolveAnomaly(db, int(params.id), body.operator));
  route('POST', '/api/handling/:id/done', ({ params, body }) => D.completeHandling(db, int(params.id), body.operator));
  route('POST', '/api/observations/refusal', ({ body }) => D.recordRefusal(db, {
    tankId: int(body.tank_id), note: body.note, operator: body.operator,
  }));

  // 交接日志
  route('GET', '/api/handovers', () => D.listHandovers(db));
  route('GET', '/api/handovers/digest', () => ({ digest: D.digest(db) }));
  route('POST', '/api/handovers', ({ body }) => D.createHandover(db, {
    shift: body.shift, fromUser: body.from_user, toUser: body.to_user, summary: body.summary,
  }));

  // 进程内提醒
  route('GET', '/api/reminders', () => D.listReminders(db));
  route('POST', '/api/reminders/:id/ack', ({ params }) => D.ackReminder(db, int(params.id)));

  return async function handle(req, res) {
    const u = new URL(req.url, 'http://localhost');
    const pathname = u.pathname;
    try {
      if (pathname.startsWith('/api/')) {
        const m = matchRoute(req.method, pathname);
        if (!m) { sendJson(res, 404, { ok: false, code: 'NOT_FOUND', message: '接口不存在' }); return; }
        const query = Object.fromEntries(u.searchParams.entries());
        let body = {};
        if (req.method === 'POST' || req.method === 'PUT') {
          const ct = String(req.headers['content-type'] || '');
          if (ct.includes('application/json')) {
            const buf = await readBody(req);
            body = buf.length ? JSON.parse(buf.toString('utf8')) : {};
          }
        }
        const result = await m.handler({ req, res, params: m.params, query, body });
        if (!res.writableEnded) sendJson(res, 200, { ok: true, data: result });
        return;
      }
      // 静态资源
      if (req.method !== 'GET') { sendJson(res, 405, { ok: false, message: 'Method Not Allowed' }); return; }
      if (pathname.startsWith('/uploads/')) {
        const p = safeJoin(UPLOAD_DIR, pathname.slice('/uploads/'.length));
        if (p && fs.existsSync(p) && fs.statSync(p).isFile()) { serveStatic(res, p); return; }
        sendJson(res, 404, { ok: false, message: 'Not Found' }); return;
      }
      const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
      const p = safeJoin(PUBLIC_DIR, rel);
      if (p && fs.existsSync(p) && fs.statSync(p).isFile()) { serveStatic(res, p); return; }
      serveStatic(res, path.join(PUBLIC_DIR, 'index.html')); // SPA 回退
    } catch (err) {
      sendError(res, err);
    }
  };
}

// ---------- 启动 ----------

function parseArgs(argv) {
  const opts = { port: Number(process.env.PORT) || 8080, reseed: false, seed: true, db: defaultDbPath() };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port') opts.port = Number(argv[++i]);
    else if (a === '--reseed') opts.reseed = true;
    else if (a === '--no-seed') opts.seed = false;
    else if (a === '--db') opts.db = argv[++i];
  }
  return opts;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.reseed && opts.db !== ':memory:' && fs.existsSync(opts.db)) {
    fs.rmSync(opts.db);
    for (const suffix of ['-wal', '-shm']) { try { fs.rmSync(opts.db + suffix); } catch { /* 不存在则忽略 */ } }
  }
  const db = open(opts.db);
  let seeded = false;
  if (opts.seed) seeded = seed.seedIfEmpty(db);
  const sched = scheduler.start(db, { intervalMs: 15000 });
  const app = createApp(db);
  const server = http.createServer(app);
  server.listen(opts.port, () => {
    console.log('');
    console.log('  🐠 水族馆水槽投喂与设备点检系统');
    console.log(`  ➜  http://localhost:${opts.port}`);
    console.log(`  数据库: ${opts.db}${seeded ? '（已生成演示数据：投喂 / 停机 / 复核样例）' : ''}`);
    const pending = db.prepare(
      `SELECT scan_token FROM feeding_tasks WHERE status = 'pending' AND scheduled_date = ? ORDER BY slot LIMIT 3`,
    ).all(dateStr());
    if (pending.length) {
      console.log('  今日待投喂扫码令牌（演示重复扫码幂等）:');
      for (const r of pending) console.log(`    ${r.scan_token}`);
    }
    console.log('');
  });
  const shutdown = () => { sched.stop(); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 500); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (require.main === module) main();

module.exports = { createApp };
