'use strict';
/* 水族馆运维台前端：六个交付页面，零依赖 vanilla JS */

// ---------- 基础 ----------
const $ = (sel, el = document) => el.querySelector(sel);
const main = $('#main');

const KIND_TEXT = { temp: '水温异常', filter_stop: '过滤器停机', refusal: '生物拒食', feed_expired: '饲料过期', missed_feeding: '漏投' };
const KIND_ICON = { temp: '🌡️', filter_stop: '🛑', refusal: '🐟', feed_expired: '📦', missed_feeding: '⏰' };
const TASK_TEXT = { pending: '待执行', completed: '已完成', missed: '已漏投', frozen: '已冻结', cancelled: '已取消' };
const TASK_BADGE = { pending: 'sea', completed: 'mint', missed: 'coral', frozen: 'amber', cancelled: 'gray' };
const EQ_KIND = { filter: '滤', pump: '泵', heater: '热' };
const EQ_KIND_TEXT = { filter: '过滤器', pump: '水泵', heater: '加热棒' };
const FEED_STATUS = { active: '在库', expired: '已过期', depleted: '已用尽' };

const state = {
  tab: 'overview',
  calDate: todayStr(),
  calTank: '',
  overview: null,
  grace: 30,
  operator: localStorage.getItem('operator') || '',
};

function todayStr(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function fmtTime(iso) { return iso ? iso.slice(5, 16).replace('T', ' ') : '—'; }
function fmtHM(iso) { return iso ? iso.slice(11, 16) : '—'; }

async function api(path, opts = {}) {
  const init = { method: opts.method || 'GET', headers: {} };
  if (opts.json !== undefined) {
    init.method = init.method === 'GET' ? 'POST' : init.method;
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(opts.json);
  } else if (opts.body !== undefined) {
    init.method = 'POST';
    init.body = opts.body;
    if (opts.filename) init.headers['X-Filename'] = opts.filename;
  }
  const r = await fetch(path, init);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.message || `请求失败 (${r.status})`);
  return data.data;
}

function toast(msg, type = 'info') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  $('#toast-root').appendChild(el);
  setTimeout(() => el.remove(), 3600);
}

function openModal(html) {
  const root = $('#modal-root');
  root.innerHTML = `<div class="modal-mask" data-action="modal-mask"><div class="modal">${html}</div></div>`;
}
function closeModal() { $('#modal-root').innerHTML = ''; }

function operatorName() {
  return state.operator || '未署名';
}

// ---------- 渲染入口 ----------
async function render() {
  try {
    if (state.tab === 'overview') await renderOverview();
    else if (state.tab === 'calendar') await renderCalendar();
    else if (state.tab === 'feeds') await renderFeeds();
    else if (state.tab === 'equipment') await renderEquipment();
    else if (state.tab === 'anomalies') await renderAnomalies();
    else if (state.tab === 'handover') await renderHandover();
  } catch (e) {
    main.innerHTML = `<div class="card">加载失败：${esc(e.message)} <button class="sm" data-action="reload">重试</button></div>`;
  }
}

// ---------- 水槽总览 ----------
async function renderOverview() {
  const data = await api('/api/overview');
  state.overview = data.tanks;
  main.innerHTML = `
    <div class="section-title"><h2>水槽总览</h2><span class="hint">平面水槽图定位设备 · 异常水槽色带+文字双标识 · ${esc(fmtTime(data.now))}</span></div>
    <div class="grid">
      ${data.tanks.map(tankCard).join('')}
    </div>`;
}

function tankCard(t) {
  const alerts = t.anomalies || [];
  const kinds = [...new Set(alerts.map((a) => KIND_TEXT[a.kind] || a.kind))];
  const band = alerts.length
    ? `<div class="alert-band">⚠ 异常：${esc(kinds.join(' · '))}（${alerts.length} 项未结）</div>` : '';
  const eq = (t.equipment || []).map((e) => `
    <button class="eq-dot ${e.status}" style="left:${e.pos_x}%;top:${e.pos_y}%"
      data-action="inspect-open" data-id="${e.id}"
      title="${esc(e.device_code)} ${EQ_KIND_TEXT[e.kind] || e.kind} · ${e.status === 'running' ? '运行中' : '已停机'}">
      ${EQ_KIND[e.kind] || '设'}</button>`).join('');
  const plan = t.plan
    ? `<div class="tank-stats">
        <span>计划 <b>v${t.plan.version}</b>${t.plan.status === 'frozen' ? ' <span class="badge amber">❄ 已冻结</span>' : ''}</span>
        <span>单次 <b>${t.plan.dose_g}g</b></span>
        <span>时段 <b>${t.plan.slots.join(' / ')}</b></span>
      </div>`
    : '<div class="muted">暂无生效计划</div>';
  const reading = t.last_reading
    ? `<span>水温 <b>${t.last_reading.temp_c}℃</b>（${esc(fmtHM(t.last_reading.collected_at))}）</span>` : '';
  const today = t.tasks || [];
  const doneCount = today.filter((x) => x.status === 'completed').length;
  return `
  <div class="card tank-card ${alerts.length ? 'has-alert' : ''}">
    ${band}
    <div class="tank-head">
      <div><h3>${esc(t.name)}</h3><div class="tank-meta">${esc(t.species)} · ${t.bio_count} 尾 · 饲料「${esc(t.feed_type)}」</div></div>
      <span class="code">${esc(t.code)}</span>
    </div>
    <div class="tank-map">
      ${eq}
      <span class="map-label">俯视设备布置图</span>
    </div>
    <div class="map-legend">
      <span class="ok"><i></i>运行中</span><span class="bad"><i></i>已停机</span>
      <span>滤=过滤器 泵=水泵 热=加热棒（点击圆点点检）</span>
    </div>
    ${plan}
    <div class="tank-stats">
      ${reading}
      <span>今日投喂 <b>${doneCount}/${today.length}</b></span>
      <span>剂量上限 <b>${t.max_dose_g}g</b></span>
    </div>
    ${alerts.length ? `<div class="anomaly-tags">${alerts.map((a) => `<span class="badge coral">${KIND_ICON[a.kind] || '⚠'} ${KIND_TEXT[a.kind] || a.kind}</span>`).join('')}</div>` : ''}
    <div class="row mt12">
      <button class="sm" data-action="reading-open" data-id="${t.id}" data-code="${esc(t.code)}">补录读数</button>
      <button class="sm" data-action="plan-open" data-id="${t.id}" data-code="${esc(t.code)}">调整计划</button>
      <button class="sm ghost" data-action="refusal-open" data-id="${t.id}" data-code="${esc(t.code)}">记录拒食</button>
    </div>
  </div>`;
}

// ---------- 投喂日历 ----------
async function renderCalendar() {
  const data = await api(`/api/calendar?date=${state.calDate}`);
  state.grace = data.grace_minutes;
  const tanks = [...new Map(data.tasks.map((t) => [t.tank_id, t.tank_code])).entries()];
  const tasks = data.tasks.filter((t) => !state.calTank || String(t.tank_id) === state.calTank);
  const groups = {};
  for (const t of tasks) (groups[t.slot] = groups[t.slot] || []).push(t);
  const slots = Object.keys(groups).sort();
  main.innerHTML = `
    <div class="section-title"><h2>投喂日历</h2><span class="hint">剂量刻度 · 剩余时间 · 扫码完成（重复扫码幂等）</span></div>
    <div class="cal-toolbar">
      <div class="date-nav">
        <button class="sm" data-action="cal-prev">← 前一天</button>
        <span class="date-label">${esc(data.date)}${data.date === todayStr() ? '（今天）' : ''}</span>
        <button class="sm" data-action="cal-next">后一天 →</button>
      </div>
      <select id="cal-tank" data-action-change="cal-tank" style="width:auto">
        <option value="">全部水槽</option>
        ${tanks.map(([id, code]) => `<option value="${id}" ${String(id) === state.calTank ? 'selected' : ''}>${esc(code)}</option>`).join('')}
      </select>
    </div>
    <div class="card">
      <div class="row">
        <input id="scan-input" placeholder="扫码 / 输入任务令牌，如 SCAN-1-2026-09-25-0830" style="flex:2;min-width:220px">
        <input id="operator-input" placeholder="操作员" value="${esc(state.operator)}" style="flex:1;min-width:110px">
        <button class="primary" data-action="scan-complete">完成投喂</button>
      </div>
      <div class="muted mt8">完成时才扣减饲料批次余量；同一令牌重复扫码不会重复完成。</div>
    </div>
    ${slots.length === 0 ? '<div class="card muted mt12">当日暂无投喂任务</div>' : ''}
    ${slots.map((slot) => `
      <div class="section-title mt16"><h2>🕐 ${slot}</h2></div>
      <div class="grid">${groups[slot].map(taskCard).join('')}</div>`).join('')}`;
}

function taskCard(t) {
  const pct = Math.min(100, Math.round((t.dose_g / t.max_dose_g) * 100));
  const canComplete = t.status === 'pending';
  const slotAt = `${t.scheduled_date}T${t.slot}:00`;
  return `
  <div class="card task-card">
    <div class="task-top">
      <div><span class="slot">${esc(t.slot)}</span> <span class="tank">${esc(t.tank_code)} ${esc(t.tank_name)}</span></div>
      <span class="badge ${TASK_BADGE[t.status]}">${TASK_TEXT[t.status]}</span>
    </div>
    <div>
      <div class="gauge"><div class="fill" style="width:${pct}%"></div><div class="ticks"></div></div>
      <div class="gauge-label"><span>单次剂量 <b>${t.dose_g}g</b>（${esc(t.feed_batch_code)}）</span><span>上限 ${t.max_dose_g}g</span></div>
    </div>
    <div class="countdown" data-countdown data-slot-at="${slotAt}" data-status="${t.status}"
      ${t.completed_at ? `data-completed="${esc(t.completed_at)}"` : ''}></div>
    <div class="row">
      <code class="token">${esc(t.scan_token)}</code>
      <button class="sm ghost" data-action="copy-token" data-token="${esc(t.scan_token)}">复制</button>
    </div>
    ${canComplete ? `<button class="mint big" data-action="complete-task" data-token="${esc(t.scan_token)}">扫码完成（扣减 ${t.dose_g}g）</button>` : ''}
    ${t.status === 'completed' ? `<div class="muted">✓ ${esc(fmtTime(t.completed_at))} 由 ${esc(t.completed_by || '—')} 完成</div>` : ''}
    ${t.status === 'frozen' ? '<div class="muted">❄ 设备点检未通过，计划冻结中</div>' : ''}
  </div>`;
}

// 倒计时刷新（每秒）
setInterval(() => {
  document.querySelectorAll('[data-countdown]').forEach((el) => {
    const status = el.dataset.status;
    if (status === 'completed') { el.className = 'countdown done'; el.textContent = `已完成 ${fmtHM(el.dataset.completed)}`; return; }
    if (status === 'missed') { el.className = 'countdown done'; el.textContent = '已漏投（超过宽限期）'; return; }
    if (status === 'frozen') { el.className = 'countdown done'; el.textContent = '已冻结'; return; }
    if (status === 'cancelled') { el.className = 'countdown done'; el.textContent = '已取消'; return; }
    const at = new Date(el.dataset.slotAt).getTime();
    const diff = at - Date.now();
    const fmt = (ms) => {
      const s = Math.max(0, Math.floor(ms / 1000));
      return `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
    };
    if (diff > 0) {
      el.className = `countdown ${diff < 15 * 60000 ? 'soon' : 'ok'}`;
      el.textContent = `⏳ 距投喂时段还有 ${fmt(diff)}`;
    } else {
      const left = diff + state.grace * 60000;
      if (left > 0) {
        el.className = 'countdown soon';
        el.textContent = `⚠ 已过时段，宽限剩余 ${fmt(left)}`;
      } else {
        el.className = 'countdown soon';
        el.textContent = '⚠ 已超宽限期，等待系统记漏投';
      }
    }
  });
}, 1000);

// ---------- 饲料批次 ----------
async function renderFeeds() {
  const feeds = await api('/api/feeds');
  main.innerHTML = `
    <div class="section-title"><h2>饲料批次</h2><span class="hint">按批次记录有效期与剩余量 · 投喂完成后才扣减</span></div>
    <div class="card table-wrap">
      <table>
        <thead><tr><th>批次号</th><th>类型</th><th>剩余量</th><th>有效期</th><th>状态</th></tr></thead>
        <tbody>
          ${feeds.map((f) => {
            const pct = Math.round((f.remaining_qty_g / f.initial_qty_g) * 100);
            const expired = f.status === 'expired';
            const expSoon = !expired && (new Date(f.expiry_date) - Date.now()) / 86400000 <= 7;
            return `<tr>
              <td><b>${esc(f.batch_code)}</b></td>
              <td>${esc(f.feed_type)}</td>
              <td><div class="qty-bar ${pct <= 20 ? 'low' : ''}"><i style="width:${pct}%"></i></div>
                  <span class="muted">${f.remaining_qty_g} / ${f.initial_qty_g}g</span></td>
              <td>${esc(f.expiry_date)} ${expired ? '<span class="badge coral">已过期</span>' : expSoon ? '<span class="badge amber">临期 ≤7天</span>' : '<span class="badge mint">正常</span>'}</td>
              <td><span class="badge ${f.status === 'active' ? 'sea' : 'gray'}">${FEED_STATUS[f.status] || f.status}</span></td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>
    <div class="card mt12">
      <h3 style="margin-top:0">登记新批次</h3>
      <div class="inline-form">
        <label class="field"><span>批次号</span><input id="fb-code" placeholder="FEED-XXX-0000"></label>
        <label class="field"><span>饲料类型</span>
          <select id="fb-type"><option>磷虾颗粒</option><option>丰年虾</option><option>藻片</option></select></label>
        <label class="field"><span>有效期</span><input id="fb-expiry" type="date"></label>
        <label class="field"><span>初始数量(g)</span><input id="fb-qty" type="number" min="1" placeholder="1000"></label>
        <button class="primary" data-action="feed-create">登记</button>
      </div>
    </div>`;
}

// ---------- 设备点检 ----------
async function renderEquipment() {
  const list = await api('/api/equipment');
  const byTank = {};
  for (const e of list) (byTank[e.tank_code] = byTank[e.tank_code] || { name: e.tank_name, items: [] }).items.push(e);
  main.innerHTML = `
    <div class="section-title"><h2>设备点检</h2><span class="hint">点检未通过将停机并冻结关联投喂计划 · 照片保存为本地文件</span></div>
    ${Object.entries(byTank).map(([code, g]) => `
      <div class="card mt12">
        <h3 style="margin:0 0 6px">${esc(code)} ${esc(g.name)}</h3>
        ${g.items.map((e) => `
          <div class="eq-row">
            <span class="eq-status ${e.status}"></span>
            <div class="eq-info">
              <div class="code">${esc(e.device_code)} <span class="muted">${EQ_KIND_TEXT[e.kind] || e.kind}</span></div>
              <div class="sub">${e.status === 'running' ? '运行中' : '已停机'} · 最近点检：${e.last_inspection ? `${e.last_inspection.result === 'pass' ? '✔ 通过' : '✖ 未通过'} ${fmtTime(e.last_inspection.inspected_at)} ${esc(e.last_inspection.inspector || '')}` : '暂无'}</div>
            </div>
            ${e.last_inspection && e.last_inspection.photo_path ? `<img class="eq-photo" src="${esc(e.last_inspection.photo_path)}" alt="点检照片" data-action="photo-view" data-src="${esc(e.last_inspection.photo_path)}">` : ''}
            <button class="sm ${e.status === 'stopped' ? 'coral' : ''}" data-action="inspect-open" data-id="${e.id}">点检</button>
          </div>`).join('')}
      </div>`).join('')}`;
}

// ---------- 异常观察 ----------
async function renderAnomalies() {
  const [open, tanks] = await Promise.all([
    api('/api/anomalies?status=open'),
    api('/api/anomalies?status=acked'),
    ]);
  const items = [...open, ...tanks];
  const ov = state.overview || (await api('/api/overview')).tanks;
  state.overview = ov;
  main.innerHTML = `
    <div class="section-title"><h2>异常观察</h2><span class="hint">五类异常各自生成处置任务 · ${items.length} 项未结</span></div>
    <div class="card">
      <h3 style="margin:0 0 8px">记录拒食观察</h3>
      <div class="inline-form">
        <label class="field"><span>水槽</span>
          <select id="refusal-tank">${ov.map((t) => `<option value="${t.id}">${esc(t.code)} ${esc(t.name)}</option>`).join('')}</select></label>
        <label class="field" style="flex:2"><span>观察说明</span><input id="refusal-note" placeholder="如：晨投后残饵约八成"></label>
        <button class="coral" data-action="refusal-submit">生成拒食异常</button>
      </div>
    </div>
    <div class="grid mt12">
      ${items.length === 0 ? '<div class="card muted">当前没有未结异常 🎉</div>' : ''}
      ${items.map(anomalyCard).join('')}
    </div>`;
}

function anomalyCard(a) {
  const hs = (a.handling || []).map((h) => `
    <div class="handling-row ${h.status === 'done' ? 'done' : ''}">
      <span>${h.status === 'done' ? '✔' : '▸'} ${esc(h.title)} <span class="muted">（限 ${fmtTime(h.due_at)}）</span></span>
      ${h.status !== 'done' ? `<button class="sm mint" data-action="handling-done" data-id="${h.id}">完成处置</button>` : `<span class="muted">${esc(h.done_by || '')} ${fmtHM(h.done_at)}</span>`}
    </div>`).join('');
  return `
  <div class="card anomaly-card ${a.status}">
    <div class="anomaly-head">
      <span class="anomaly-kind">${KIND_ICON[a.kind] || '⚠'} ${KIND_TEXT[a.kind] || a.kind}</span>
      <span class="badge ${a.status === 'acked' ? 'amber' : 'coral'}">${a.status === 'acked' ? '已知晓' : '待处理'}</span>
    </div>
    <div class="anomaly-detail">${esc(a.detail)}</div>
    <div class="muted">${a.tank_code ? `水槽 ${esc(a.tank_code)} · ` : ''}${fmtTime(a.created_at)}</div>
    ${hs}
    <div class="row mt8">
      ${a.status === 'open' ? `<button class="sm" data-action="anomaly-ack" data-id="${a.id}">知晓</button>` : ''}
      <button class="sm primary" data-action="anomaly-resolve" data-id="${a.id}">解除异常</button>
    </div>
  </div>`;
}

// ---------- 交接日志 ----------
async function renderHandover() {
  const list = await api('/api/handovers');
  main.innerHTML = `
    <div class="section-title"><h2>交接日志</h2><span class="hint">交接时自动附带运营摘要</span></div>
    <div class="card">
      <div class="form-row">
        <label class="field"><span>班次</span>
          <select id="ho-shift"><option>早班 → 中班</option><option>中班 → 晚班</option><option>晚班 → 早班</option></select></label>
        <label class="field"><span>交班人</span><input id="ho-from" value="${esc(state.operator)}" placeholder="姓名"></label>
      </div>
      <div class="form-row">
        <label class="field"><span>接班人</span><input id="ho-to" placeholder="姓名"></label>
        <label class="field"><span>&nbsp;</span><button class="sm" data-action="digest-fill" type="button">填入当前运营摘要</button></label>
      </div>
      <label class="field"><span>交接事项</span><textarea id="ho-summary" placeholder="重点设备、异常、投喂注意事项…"></textarea></label>
      <button class="primary big" data-action="handover-submit" style="width:100%">提交交接</button>
    </div>
    <div class="card mt12">
      ${list.length === 0 ? '<div class="muted">暂无交接记录</div>' : list.map((h) => `
        <div class="handover-item">
          <div><b>${esc(h.shift)}</b>　${esc(h.from_user)} → ${esc(h.to_user)}</div>
          <div class="meta">${fmtTime(h.created_at)}</div>
          ${h.summary ? `<div class="mt8">${esc(h.summary)}</div>` : ''}
          ${h.digest ? `<div class="digest">📋 ${esc(h.digest)}</div>` : ''}
        </div>`).join('')}
    </div>`;
}

// ---------- 弹窗 ----------

async function openInspectionModal(equipmentId) {
  const list = await api('/api/equipment');
  const eq = list.find((e) => e.id === Number(equipmentId));
  if (!eq) { toast('设备不存在', 'err'); return; }
  openModal(`
    <h3>点检 ${esc(eq.device_code)}</h3>
    <div class="muted">${esc(eq.tank_code)} ${esc(eq.tank_name)} · ${EQ_KIND_TEXT[eq.kind] || eq.kind} · 当前${eq.status === 'running' ? '运行中' : '已停机'}</div>
    <div class="result-toggle">
      <button type="button" data-action="insp-result" data-r="pass" id="insp-pass">✔ 通过</button>
      <button type="button" data-action="insp-result" data-r="fail" id="insp-fail">✖ 未通过</button>
    </div>
    <div class="warn-box" id="insp-warn" hidden>未通过将<b>停机</b>并<b>冻结该水槽的投喂计划</b>，复检通过后自动解冻。</div>
    <label class="field"><span>点检人</span><input id="insp-inspector" value="${esc(state.operator)}" placeholder="姓名"></label>
    <label class="field"><span>备注</span><textarea id="insp-notes" placeholder="运行状况、异响、滤材状态…"></textarea></label>
    <label class="field"><span>点检照片（保存为本地文件）</span><input id="insp-photo" type="file" accept="image/*"></label>
    <div class="modal-actions">
      <button class="ghost" data-action="modal-close">取消</button>
      <button class="primary" data-action="insp-submit" data-id="${eq.id}" disabled id="insp-submit">提交点检</button>
    </div>`);
  $('#modal-root').dataset.result = '';
}

async function openReadingModal(tankId, code) {
  openModal(`
    <h3>补录水质读数 · ${esc(code)}</h3>
    <div class="muted">补录必须保留<b>采集时间</b>与<b>设备编号</b>；水温越界将自动生成异常与复核任务。</div>
    <input type="hidden" id="rd-tank" value="${tankId}">
    <div class="form-row">
      <label class="field"><span>采集设备编号 *</span><input id="rd-device" placeholder="PROBE-T01-1"></label>
      <label class="field"><span>采集时间 *</span><input id="rd-collected" type="datetime-local"></label>
    </div>
    <div class="form-row">
      <label class="field"><span>水温 ℃ *</span><input id="rd-temp" type="number" step="0.1" placeholder="26.0"></label>
      <label class="field"><span>pH</span><input id="rd-ph" type="number" step="0.1" placeholder="8.1"></label>
    </div>
    <div class="form-row">
      <label class="field"><span>溶解氧 mg/L</span><input id="rd-do" type="number" step="0.1" placeholder="7.0"></label>
      <label class="field"><span>记录人</span><input id="rd-operator" value="${esc(state.operator)}"></label>
    </div>
    <div class="modal-actions">
      <button class="ghost" data-action="modal-close">取消</button>
      <button class="primary" data-action="reading-submit">提交补录</button>
    </div>`);
  const now = new Date();
  now.setSeconds(0, 0);
  $('#rd-collected').value = new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}

async function openPlanModal(tankId, code) {
  const [plans, feeds] = await Promise.all([api(`/api/plans?tank_id=${tankId}`), api('/api/feeds')]);
  const cur = plans.find((p) => p.status === 'active' || p.status === 'frozen');
  const tank = (state.overview || []).find((t) => t.id === Number(tankId));
  const usable = feeds.filter((f) => f.status === 'active' && (!tank || f.feed_type === tank.feed_type));
  openModal(`
    <h3>调整投喂计划 · ${esc(code)}</h3>
    <div class="muted">变更将生成新版本（当前 ${cur ? `v${cur.version}` : '无'}），历史版本保留；已执行任务按原快照结算，不会重算。</div>
    ${tank ? `<div class="muted mt8">生物 ${tank.bio_count} 尾 · 剂量上限 <b>${tank.max_dose_g}g</b> · 饲料类型「${esc(tank.feed_type)}」</div>` : ''}
    <input type="hidden" id="pl-tank" value="${tankId}">
    <div class="form-row">
      <label class="field"><span>单次剂量 (g)</span><input id="pl-dose" type="number" step="0.1" min="0" value="${cur ? cur.dose_g : ''}"></label>
      <label class="field"><span>投喂时段（逗号分隔）</span><input id="pl-slots" value="${cur ? cur.slots.join(', ') : '08:30, 17:30'}"></label>
    </div>
    <label class="field"><span>饲料批次</span>
      <select id="pl-feed">${usable.map((f) => `<option value="${f.id}" ${cur && cur.feed_batch_id === f.id ? 'selected' : ''}>${esc(f.batch_code)} · ${esc(f.feed_type)} · 余 ${f.remaining_qty_g}g</option>`).join('')}</select></label>
    <label class="field"><span>操作人</span><input id="pl-operator" value="${esc(state.operator)}"></label>
    <div class="modal-actions">
      <button class="ghost" data-action="modal-close">取消</button>
      <button class="primary" data-action="plan-submit">保存为新版本</button>
    </div>`);
}

// ---------- 事件委托 ----------
document.addEventListener('click', async (ev) => {
  const el = ev.target.closest('[data-action]');
  if (!el) return;
  const act = el.dataset.action;
  try {
    if (act === 'modal-close' || (act === 'modal-mask' && ev.target.classList.contains('modal-mask'))) { closeModal(); return; }
    if (act === 'reload') { render(); return; }

    // 日历
    if (act === 'cal-prev' || act === 'cal-next') {
      const d = new Date(`${state.calDate}T12:00:00`);
      d.setDate(d.getDate() + (act === 'cal-next' ? 1 : -1));
      state.calDate = todayStr(d);
      render(); return;
    }
    if (act === 'copy-token') {
      await navigator.clipboard.writeText(el.dataset.token).catch(() => {});
      toast('令牌已复制', 'ok'); return;
    }
    if (act === 'complete-task') {
      await completeByToken(el.dataset.token); return;
    }
    if (act === 'scan-complete') {
      const token = $('#scan-input').value.trim();
      if (!token) { toast('请先扫码或输入令牌', 'err'); return; }
      await completeByToken(token); return;
    }

    // 弹窗入口
    if (act === 'inspect-open') { await openInspectionModal(el.dataset.id); return; }
    if (act === 'reading-open') { await openReadingModal(el.dataset.id, el.dataset.code); return; }
    if (act === 'plan-open') { await openPlanModal(el.dataset.id, el.dataset.code); return; }
    if (act === 'refusal-open') { state.tab = 'anomalies'; syncTabs(); render(); return; }
    if (act === 'photo-view') { openModal(`<img src="${esc(el.dataset.src)}" style="width:100%;border-radius:10px" alt="点检照片"><div class="modal-actions"><button class="ghost" data-action="modal-close">关闭</button></div>`); return; }

    // 点检
    if (act === 'insp-result') {
      $('#modal-root').dataset.result = el.dataset.r;
      $('#insp-pass').className = el.dataset.r === 'pass' ? 'sel-pass' : '';
      $('#insp-fail').className = el.dataset.r === 'fail' ? 'sel-fail' : '';
      $('#insp-warn').hidden = el.dataset.r !== 'fail';
      $('#insp-submit').disabled = false;
      return;
    }
    if (act === 'insp-submit') {
      const result = $('#modal-root').dataset.result;
      const file = $('#insp-photo').files[0];
      let photoPath = null;
      if (file) {
        const up = await api('/api/uploads', { body: file, filename: file.name });
        photoPath = up.path;
      }
      saveOperator($('#insp-inspector').value);
      const r = await api('/api/inspections', { json: {
        equipment_id: Number(el.dataset.id), result,
        inspector: operatorName(), notes: $('#insp-notes').value, photo_path: photoPath,
      } });
      closeModal();
      toast(result === 'fail' ? '已记录未通过：设备停机，关联投喂计划已冻结' : '点检通过，设备运行中', result === 'fail' ? 'err' : 'ok');
      if (result === 'fail' && r) { /* 异常由后端生成 */ }
      render(); return;
    }

    // 读数
    if (act === 'reading-submit') {
      saveOperator($('#rd-operator').value);
      const r = await api('/api/readings', { json: {
        tank_id: Number($('#rd-tank').value),
        device_id: $('#rd-device').value.trim(),
        collected_at: $('#rd-collected').value,
        temp_c: $('#rd-temp').value === '' ? null : Number($('#rd-temp').value),
        ph: $('#rd-ph').value, do_mg_l: $('#rd-do').value,
        source: 'backfill', operator: operatorName(),
      } });
      closeModal();
      toast(r.anomaly ? '读数已补录，水温越界 → 已生成异常与复核任务' : '读数已补录', r.anomaly ? 'err' : 'ok');
      render(); return;
    }

    // 计划
    if (act === 'plan-submit') {
      saveOperator($('#pl-operator').value);
      const p = await api('/api/plans', { json: {
        tank_id: Number($('#pl-tank').value),
        dose_g: Number($('#pl-dose').value),
        slots: $('#pl-slots').value,
        feed_batch_id: Number($('#pl-feed').value),
        operator: operatorName(),
      } });
      closeModal();
      toast(`已保存为计划 v${p.version}，旧版本保留`, 'ok');
      render(); return;
    }

    // 饲料
    if (act === 'feed-create') {
      await api('/api/feeds', { json: {
        batch_code: $('#fb-code').value.trim(), feed_type: $('#fb-type').value,
        expiry_date: $('#fb-expiry').value, initial_qty_g: Number($('#fb-qty').value),
      } });
      toast('批次已登记', 'ok'); render(); return;
    }

    // 异常与处置
    if (act === 'anomaly-ack') { await api(`/api/anomalies/${el.dataset.id}/ack`, { json: {} }); toast('已知晓', 'ok'); render(); return; }
    if (act === 'anomaly-resolve') { await api(`/api/anomalies/${el.dataset.id}/resolve`, { json: { operator: operatorName() } }); toast('异常已解除', 'ok'); render(); return; }
    if (act === 'handling-done') { await api(`/api/handling/${el.dataset.id}/done`, { json: { operator: operatorName() } }); toast('处置完成', 'ok'); render(); return; }
    if (act === 'refusal-submit') {
      const note = $('#refusal-note').value.trim();
      await api('/api/observations/refusal', { json: { tank_id: Number($('#refusal-tank').value), note, operator: operatorName() } });
      toast('已生成拒食异常与处置任务', 'ok'); render(); return;
    }

    // 交接
    if (act === 'digest-fill') {
      const d = await api('/api/handovers/digest');
      const ta = $('#ho-summary');
      ta.value = ta.value ? `${ta.value}\n${d.digest}` : d.digest;
      return;
    }
    if (act === 'handover-submit') {
      saveOperator($('#ho-from').value);
      await api('/api/handovers', { json: {
        shift: $('#ho-shift').value, from_user: $('#ho-from').value.trim(),
        to_user: $('#ho-to').value.trim(), summary: $('#ho-summary').value.trim(),
      } });
      toast('交接已记录', 'ok'); render(); return;
    }

    // 提醒
    if (act === 'reminder-ack') { await api(`/api/reminders/${el.dataset.id}/ack`, { json: {} }); loadReminders(); return; }
  } catch (e) {
    toast(e.message, 'err');
  }
});

document.addEventListener('change', (ev) => {
  const el = ev.target.closest('[data-action-change]');
  if (!el) return;
  if (el.dataset.actionChange === 'cal-tank') { state.calTank = el.value; render(); }
});

async function completeByToken(token) {
  saveOperator(($('#operator-input') || {}).value ?? state.operator);
  const r = await api('/api/tasks/complete', { json: { scan_token: token, operator: operatorName() } });
  if (r.idempotent) {
    toast(`该任务此前已完成（${fmtTime(r.task.completed_at)}），本次扫码未重复扣减`, 'info');
  } else {
    toast(`投喂完成 ✓ 批次 ${r.feed.batch_code} 剩余 ${r.feed.remaining_qty_g}g`, 'ok');
  }
  if (state.tab === 'calendar') render();
}

function saveOperator(v) {
  if (v && v.trim()) { state.operator = v.trim(); localStorage.setItem('operator', state.operator); }
}

// ---------- 提醒轮询 ----------
async function loadReminders() {
  try {
    const list = await api('/api/reminders');
    const bar = $('#reminder-bar');
    if (!list.length) { bar.hidden = true; bar.innerHTML = ''; return; }
    bar.hidden = false;
    bar.innerHTML = list.map((r) => `
      <span class="reminder-chip">🔔 ${esc(r.message)}
        <button class="ack" data-action="reminder-ack" data-id="${r.id}" title="知道了">✕</button>
      </span>`).join('');
  } catch { /* 提醒失败不阻塞 */ }
}

// ---------- 导航 ----------
function syncTabs() {
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === state.tab));
}
$('#tabs').addEventListener('click', (ev) => {
  const b = ev.target.closest('button[data-tab]');
  if (!b) return;
  state.tab = b.dataset.tab;
  syncTabs();
  render();
});

// 启动
syncTabs();
render();
loadReminders();
setInterval(loadReminders, 15000);
