/* 水族馆投喂与设备点检系统 —— 前端逻辑 */
"use strict";

const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
const main = $("#main");

const esc = (s) => String(s ?? "").replace(/[&<>"']/g,
  (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

async function api(path, opts = {}) {
  const res = await fetch(path, opts.body instanceof FormData ? opts : {
    headers: { "Content-Type": "application/json" },
    ...opts,
    body: opts.body && !(opts.body instanceof FormData) ? JSON.stringify(opts.body) : opts.body,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `请求失败 ${res.status}`);
  return data;
}

function toast(msg, kind = "") {
  const t = $("#toast");
  t.textContent = msg;
  t.className = `toast ${kind}`;
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.add("hidden"), 3200);
}

const STATUS_TEXT = { normal: "正常", alert: "异常", frozen: "已冻结" };
const KIND_TEXT = {
  temp: "水温异常", filter_stop: "过滤器停机", refusal: "生物拒食",
  feed_expired: "饲料过期", missed_feed: "漏投",
};
const TASK_STATUS = { pending: "待投喂", done: "已完成", missed: "漏投", cancelled: "已取消" };

/* ================= 扫码模拟 ================= */
let scanCtx = null;
function openScan(title, code, url, onDone) {
  scanCtx = { code, url, onDone };
  $("#scanTitle").textContent = title;
  $("#scanCode").textContent = code;
  $("#scanResult").textContent = "";
  $("#scanResult").className = "scan-result";
  $("#scanModal").classList.remove("hidden");
}
$("#scanCancel").onclick = () => $("#scanModal").classList.add("hidden");
$("#scanConfirm").onclick = async () => {
  if (!scanCtx) return;
  const operator = "移动端-演示员";
  try {
    const r = await api(scanCtx.url, { method: "POST", body: { code: scanCtx.code, operator } });
    const el = $("#scanResult");
    if (r.result === "ok") {
      el.textContent = "✔ " + r.message;
      el.className = "scan-result ok";
      toast(r.message, "mint");
    } else if (r.result === "duplicate") {
      el.textContent = "⚠ " + r.message;
      el.className = "scan-result duplicate";
      toast(r.message, "coral");
    } else {
      el.textContent = "✘ " + r.message;
      el.className = "scan-result error";
      toast(r.message, "coral");
    }
    setTimeout(() => { $("#scanModal").classList.add("hidden"); scanCtx.onDone && scanCtx.onDone(); }, 900);
  } catch (e) { toast(e.message, "coral"); }
};

/* ================= 视图：水槽总览 ================= */
async function viewTanks() {
  const tanks = await api("/api/tanks");
  const nodes = tanks.map((t) => {
    const temp = t.latest_temp
      ? `${t.latest_temp.value}${t.latest_temp.unit}${t.latest_temp.backfilled ? "（补录）" : ""}`
      : "—";
    const eqIcons = t.equipments.map((e) =>
      `<span title="${esc(e.name)} ${e.status === "running" ? "运行中" : "停机"}">
        ${e.kind === "filter" ? "🌀" : "🌡"}${e.status === "running" ? "" : "⛔"}</span>`).join(" ");
    return `
    <div class="tank-node ${t.status}" style="left:${t.pos_x + 22}%;top:${t.pos_y + 12}%"
         data-tank="${t.id}">
      <div class="tn-head">
        <span class="tn-code">${esc(t.code)}</span>
        <span class="status-text ${t.status}">${STATUS_TEXT[t.status]}</span>
      </div>
      <div class="tn-name">${esc(t.name)} · ${t.volume_l}L</div>
      <div class="tn-stat">
        <span>🐟 ${t.creature_count} 尾</span>
        <span>🌡 ${temp}</span>
        <span>📋 今日待投喂 ${t.pending_today}</span>
        <span>${eqIcons}</span>
      </div>
    </div>`;
  }).join("");

  main.innerHTML = `
    <div class="card">
      <h2>平面水槽图</h2>
      <div class="tank-map">${nodes}</div>
      <p class="muted">点击水槽查看详情。异常水槽以色带 + 文字双重标识；冻结水槽表示设备点检未通过，投喂计划已冻结。</p>
    </div>
    <div id="tankDetail"></div>`;

  $$(".tank-node").forEach((n) =>
    n.addEventListener("click", () => showTankDetail(tanks.find((t) => t.id == n.dataset.tank))));
}

async function showTankDetail(t) {
  const readings = await api(`/api/tanks/${t.id}/readings`);
  const readingRows = readings.slice(0, 12).map((r) => `
    <tr>
      <td>${esc(r.kind)}</td><td>${r.value}${esc(r.unit)}</td>
      <td>${esc(r.device_no)}</td>
      <td>${esc(r.collected_at.replace("T", " "))}${r.backfilled ? ' <span class="backfill-flag">补录</span>' : ""}</td>
      <td class="muted">录入 ${esc(r.recorded_at.replace("T", " "))}</td>
    </tr>`).join("");

  const plan = t.plan ? `
    <dl class="kv">
      <dt>饲料批次</dt><dd>#${t.plan.feed_batch_id}</dd>
      <dt>单次剂量</dt><dd>${t.plan.dose_g} g</dd>
      <dt>投喂时段</dt><dd>${t.plan_times.join(" / ")}</dd>
      <dt>计划状态</dt><dd>${t.plan.status === "frozen" ? "❄ 已冻结：" + esc(t.plan.frozen_reason) : "进行中"}</dd>
    </dl>` : `<p class="muted">暂无投喂计划</p>`;

  const creatures = t.creatures.map((c) =>
    `<span class="tag tag-normal">${esc(c.batch_no)} ${esc(c.species)} ×${c.quantity}</span>`).join(" ");

  const eqRows = t.equipments.map((e) => `
    <tr><td>${esc(e.code)}</td><td>${esc(e.name)}</td>
    <td>${e.status === "running" ? '<span class="tag tag-pass">运行中</span>' : '<span class="tag tag-fail">停机</span>'}</td></tr>`).join("");

  $("#tankDetail").innerHTML = `
    <div class="card">
      <h2>${esc(t.code)} ${esc(t.name)} <span class="status-text ${t.status}">${STATUS_TEXT[t.status]}</span></h2>
      <div class="grid grid-2">
        <div>
          <h3>生物批次（演示编号）</h3><p>${creatures || "—"}</p>
          <h3>当前投喂计划</h3>${plan}
          <h3>设备</h3>
          <div class="table-wrap"><table><thead><tr><th>编号</th><th>名称</th><th>状态</th></tr></thead>
          <tbody>${eqRows}</tbody></table></div>
        </div>
        <div>
          <h3>水质读数（保留采集时间与设备编号）</h3>
          <div class="table-wrap"><table>
            <thead><tr><th>项目</th><th>数值</th><th>设备编号</th><th>采集时间</th><th>录入</th></tr></thead>
            <tbody>${readingRows || '<tr><td colspan="5" class="muted">暂无读数</td></tr>'}</tbody>
          </table></div>
          <h3>补录 / 录入读数</h3>
          <form id="readingForm" class="grid grid-2">
            <label class="field">项目
              <select name="kind"><option value="temperature">水温</option><option value="ph">pH</option><option value="ammonia">氨氮</option></select>
            </label>
            <label class="field">数值<input name="value" type="number" step="0.01" required></label>
            <label class="field">单位<input name="unit" value="℃"></label>
            <label class="field">设备编号（必填）<input name="device_no" required placeholder="如 TH-01"></label>
            <label class="field">采集时间（留空=实时；早于现在为补录）
              <input name="collected_at" type="datetime-local"></label>
            <div class="field"><button class="btn btn-primary" type="submit">保存读数</button></div>
          </form>
        </div>
      </div>
    </div>`;

  $("#readingForm").onsubmit = async (ev) => {
    ev.preventDefault();
    const f = ev.target;
    try {
      const r = await api("/api/readings", {
        method: "POST",
        body: {
          tank_id: t.id, kind: f.kind.value, value: parseFloat(f.value.value),
          unit: f.unit.value, device_no: f.device_no.value,
          collected_at: f.collected_at.value ? f.collected_at.value.replace("T", "T") : null,
        },
      });
      toast(r.backfilled ? "已保存补录读数（保留采集时间与设备编号）" : "读数已保存", "mint");
      viewTanks().then(() => showTankDetail(t));
    } catch (e) { toast(e.message, "coral"); }
  };
}

/* ================= 视图：投喂日历 ================= */
let calendarDate = new Date().toISOString().slice(0, 10);

function doseScale(dose) {
  const ticks = 20, max = Math.max(40, dose * 1.25);
  const on = Math.round((dose / max) * ticks);
  let html = '<div class="dose-scale" title="剂量刻度">';
  for (let i = 1; i <= ticks; i++) {
    const h = 8 + (i / ticks) * 30;
    html += `<span class="tick ${i <= on ? "on" : ""} ${i === on ? "target" : ""}" style="height:${h}px"></span>`;
  }
  return html + `</div><div class="dose-meta">单次剂量 <b>${dose}g</b>（刻度上限 ${Math.round(max)}g）</div>`;
}

function countdownHtml(t) {
  if (t.status !== "pending") return "";
  return `<div class="countdown" data-scheduled="${t.scheduled_at}"></div>`;
}

async function viewCalendar() {
  const [tasks, plans, feeds, tanks] = await Promise.all([
    api(`/api/calendar?date=${calendarDate}`), api("/api/plans"),
    api("/api/feeds"), api("/api/tanks"),
  ]);

  const taskCards = tasks.map((t) => {
    const frozen = t.plan_status === "frozen";
    const cls = t.status === "done" ? "done" : t.status === "missed" ? "missed" : frozen ? "frozen" : "";
    const time = t.scheduled_at.slice(11, 16);
    const action = t.status === "pending"
      ? (frozen
        ? `<span class="tag tag-frozen">❄ 计划冻结中</span>`
        : `<button class="btn btn-mint btn-lg" data-scan="${esc(t.scan_code)}" data-tank="${esc(t.tank_code)}">扫码完成</button>`)
      : t.status === "done"
        ? `<span class="tag tag-done">✔ ${esc(t.completed_at?.slice(11, 16) || "")} ${esc(t.completed_by)}</span>`
        : `<span class="tag tag-missed">漏投</span>`;
    return `
    <div class="card feed-card ${cls} ${t.status === "pending" ? "due" : ""}">
      <div class="row" style="justify-content:space-between">
        <div>
          <div class="fc-time">${time}</div>
          <div><b>${esc(t.tank_code)}</b> ${esc(t.tank_name)} · ${esc(t.feed_type)}
            <span class="muted">批次 ${esc(t.batch_no)} · 计划v${t.plan_version}</span></div>
          ${doseScale(t.dose_g)}
          <div class="muted">饲料剩余 ${t.remaining_g}g · 有效期 ${esc(t.expiry_date)}</div>
          ${frozen ? `<div class="status-text frozen">❄ ${esc(t.frozen_reason)}</div>` : ""}
          ${countdownHtml(t)}
        </div>
        <div>${action}</div>
      </div>
    </div>`;
  }).join("");

  const planRows = plans.map((p) => `
    <tr>
      <td>${esc(p.tank_code)}</td>
      <td>v${p.version}</td>
      <td>${p.dose_g}g</td>
      <td>${p.times.join(" / ")}</td>
      <td>${esc(p.batch_no)} ${esc(p.feed_type)}</td>
      <td>${p.start_date} ~ ${p.end_date}</td>
      <td>${p.status === "active" ? '<span class="tag tag-normal">进行中</span>'
        : p.status === "frozen" ? `<span class="tag tag-frozen">❄ 冻结</span><br><span class="muted">${esc(p.frozen_reason)}</span>`
        : '<span class="tag tag-cancelled">历史版本</span>'}</td>
      <td>${p.status === "active" ? `<button class="btn btn-ghost btn-sm" data-edit-plan="${p.id}">变更（新版本）</button>` : ""}</td>
    </tr>`).join("");

  main.innerHTML = `
    <div class="card">
      <div class="row" style="justify-content:space-between">
        <h2 style="margin:0">投喂日历</h2>
        <label class="field" style="min-width:180px">日期
          <input type="date" id="calDate" value="${calendarDate}"></label>
      </div>
      <div id="taskList">${taskCards || '<p class="muted">当日无投喂任务</p>'}</div>
    </div>

    <div class="card">
      <h2>投喂计划（变更保留版本，已执行任务不重算）</h2>
      <div class="table-wrap"><table>
        <thead><tr><th>水槽</th><th>版本</th><th>单次剂量</th><th>时段</th><th>饲料</th><th>周期</th><th>状态</th><th></th></tr></thead>
        <tbody>${planRows}</tbody>
      </table></div>
      <h3 id="planFormTitle">新建投喂计划</h3>
      <form id="planForm" class="grid grid-3">
        <input type="hidden" name="plan_id">
        <label class="field">水槽
          <select name="tank_id">${tanks.map((t) => `<option value="${t.id}">${esc(t.code)} ${esc(t.name)}</option>`).join("")}</select></label>
        <label class="field">饲料批次
          <select name="feed_batch_id">${feeds.filter((f) => !f.expired).map((f) =>
            `<option value="${f.id}">${esc(f.batch_no)} ${esc(f.feed_type)}（余${f.remaining_g}g）</option>`).join("")}</select></label>
        <label class="field">单次剂量 g<input name="dose_g" type="number" step="0.1" min="0.1" required></label>
        <label class="field">投喂时段（逗号分隔）<input name="times" placeholder="08:30,12:30,17:30" required></label>
        <label class="field">开始日期<input name="start_date" type="date" value="${calendarDate}" required></label>
        <label class="field">结束日期<input name="end_date" type="date" required></label>
        <div class="field"><button class="btn btn-primary btn-lg" type="submit">保存计划</button></div>
      </form>
    </div>`;

  $("#calDate").onchange = (e) => { calendarDate = e.target.value; viewCalendar(); };
  $$("[data-scan]").forEach((b) => b.addEventListener("click", () =>
    openScan(`扫码完成投喂（${b.dataset.tank}）`, b.dataset.scan, "/api/scan/feeding", viewCalendar)));

  $$("[data-edit-plan]").forEach((b) => b.addEventListener("click", () => {
    const p = plans.find((x) => x.id == b.dataset.editPlan);
    const f = $("#planForm");
    f.plan_id.value = p.id;
    f.tank_id.value = p.tank_id; f.tank_id.disabled = true;
    f.feed_batch_id.value = p.feed_batch_id;
    f.dose_g.value = p.dose_g;
    f.times.value = p.times.join(",");
    f.start_date.value = p.start_date;
    f.end_date.value = p.end_date;
    $("#planFormTitle").textContent = `变更计划（当前 v${p.version}，保存后生成 v${p.version + 1}，旧版本保留）`;
    f.scrollIntoView({ behavior: "smooth" });
  }));

  $("#planForm").onsubmit = async (ev) => {
    ev.preventDefault();
    const f = ev.target;
    const times = f.times.value.split(/[,，]/).map((s) => s.trim()).filter(Boolean);
    const body = {
      tank_id: parseInt(f.tank_id.value), feed_batch_id: parseInt(f.feed_batch_id.value),
      dose_g: parseFloat(f.dose_g.value), times,
      start_date: f.start_date.value, end_date: f.end_date.value,
    };
    try {
      if (f.plan_id.value) {
        await api(`/api/plans/${f.plan_id.value}/update`, { method: "POST", body });
        toast("已生成新版本计划，旧版本保留", "mint");
      } else {
        await api("/api/plans", { method: "POST", body });
        toast("投喂计划已创建", "mint");
      }
      viewCalendar();
    } catch (e) { toast(e.message, "coral"); }
  };
}

/* ================= 视图：饲料批次 ================= */
async function viewFeeds() {
  const feeds = await api("/api/feeds");
  const rows = feeds.map((f) => `
    <tr>
      <td><b>${esc(f.batch_no)}</b></td>
      <td>${esc(f.feed_type)}</td>
      <td>${esc(f.expiry_date)} ${f.expired ? '<span class="tag tag-expired">已过期</span>' : ""}</td>
      <td><b>${f.remaining_g}</b> / ${f.initial_g} g</td>
      <td><div class="dose-scale" style="height:18px">${
        Array.from({ length: 20 }, (_, i) =>
          `<span class="tick ${i < Math.round((f.remaining_g / f.initial_g) * 20) ? "on" : ""}" style="height:${6 + i}px"></span>`).join("")
      }</div></td>
    </tr>`).join("");
  main.innerHTML = `
    <div class="card">
      <h2>饲料批次（投喂任务完成后才扣减剩余量）</h2>
      <div class="table-wrap"><table>
        <thead><tr><th>批次号</th><th>类型</th><th>有效期</th><th>剩余 / 初始</th><th>余量</th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>
    </div>`;
}

/* ================= 视图：设备点检 ================= */
async function viewEquipment() {
  const [equip, inspections] = await Promise.all([api("/api/equipment"), api("/api/inspections")]);

  const eqCards = equip.map((e) => `
    <div class="card ${e.status === "stopped" ? "anomaly-band" : ""}">
      <div class="row" style="justify-content:space-between">
        <div>
          <b>${esc(e.code)}</b> ${esc(e.name)}
          <div class="muted">${esc(e.tank_code)} ${esc(e.tank_name)} · ${e.kind === "filter" ? "过滤设备" : "恒温设备"}</div>
          <div>状态：${e.status === "running" ? '<span class="tag tag-pass">运行中</span>' : '<span class="tag tag-fail">停机</span>'}
            ${e.last_inspection ? `<span class="muted">最近点检 ${esc(e.last_inspection.created_at.slice(0, 16).replace("T", " "))} ${e.last_inspection.result === "pass" ? "✔" : "✘"}</span>` : '<span class="muted">未点检</span>'}
          </div>
        </div>
        <div class="pill-btns">
          <button class="btn btn-mint" data-insp="${e.id}" data-result="pass">点检通过</button>
          <button class="btn btn-coral" data-insp="${e.id}" data-result="fail">点检未通过</button>
          ${e.status === "running"
            ? `<button class="btn btn-ghost" data-stop="${e.id}">停机</button>`
            : `<button class="btn btn-ghost" data-start="${e.id}">复机</button>`}
        </div>
      </div>
      <form class="insp-form hidden" data-eq="${e.id}">
        <div class="row">
          <label class="field" style="flex:2">点检说明<input name="note" placeholder="点检情况说明"></label>
          <label class="field">点检人<input name="inspector" placeholder="姓名"></label>
          <label class="field">点检照片<input name="photo" type="file" accept="image/*"></label>
          <button class="btn btn-primary" type="submit">提交点检记录</button>
        </div>
      </form>
    </div>`).join("");

  const inspRows = inspections.map((i) => `
    <tr>
      <td>${esc(i.created_at.replace("T", " "))}</td>
      <td>${esc(i.equipment_code)} ${esc(i.equipment_name)}</td>
      <td>${i.result === "pass" ? '<span class="tag tag-pass">通过</span>' : '<span class="tag tag-fail">未通过</span>'}</td>
      <td>${esc(i.note)}</td>
      <td>${esc(i.inspector)}</td>
      <td>${i.photo_url ? `<a href="${i.photo_url}" target="_blank"><img class="photo-thumb" src="${i.photo_url}" alt="点检照片"></a>` : "—"}</td>
    </tr>`).join("");

  main.innerHTML = `
    <h2 class="card" style="margin-bottom:0">设备点检
      <p class="muted" style="margin:6px 0 0">点检未通过将自动停机、生成处置任务，并冻结关联水槽的投喂计划；复核通过后解冻。照片保存为本地文件。</p>
    </h2>
    ${eqCards}
    <div class="card">
      <h2>点检记录</h2>
      <div class="table-wrap"><table>
        <thead><tr><th>时间</th><th>设备</th><th>结果</th><th>说明</th><th>点检人</th><th>照片</th></tr></thead>
        <tbody>${inspRows || '<tr><td colspan="6" class="muted">暂无记录</td></tr>'}</tbody>
      </table></div>
    </div>`;

  $$("[data-insp]").forEach((b) => b.addEventListener("click", () => {
    const form = $(`.insp-form[data-eq="${b.dataset.insp}"]`);
    form.dataset.result = b.dataset.result;
    form.classList.toggle("hidden");
  }));
  $$(".insp-form").forEach((form) => form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const fd = new FormData();
    fd.append("equipment_id", form.dataset.eq);
    fd.append("result", form.dataset.result || "pass");
    fd.append("note", form.note.value);
    fd.append("inspector", form.inspector.value);
    if (form.photo.files[0]) fd.append("photo", form.photo.files[0]);
    try {
      await api("/api/inspections", { method: "POST", body: fd });
      toast(form.dataset.result === "fail" ? "已记录未通过：设备停机并冻结关联投喂计划" : "点检通过已记录", "mint");
      viewEquipment();
    } catch (e) { toast(e.message, "coral"); }
  }));
  $$("[data-stop]").forEach((b) => b.addEventListener("click", async () => {
    await api(`/api/equipment/${b.dataset.stop}/status`, { method: "POST", body: { status: "stopped", note: "手动停机" } });
    toast("设备已停机，已生成处置任务", "coral"); viewEquipment();
  }));
  $$("[data-start]").forEach((b) => b.addEventListener("click", async () => {
    await api(`/api/equipment/${b.dataset.start}/status`, { method: "POST", body: { status: "running" } });
    toast("设备已复机", "mint"); viewEquipment();
  }));
}

/* ================= 视图：异常观察 ================= */
async function viewAnomalies() {
  const [anomalies, handling, tanks] = await Promise.all([
    api("/api/anomalies"), api("/api/handling-tasks"), api("/api/tanks")]);

  const bands = anomalies.map((a) => `
    <div class="card anomaly-band kind-${a.kind}">
      <div class="row" style="justify-content:space-between">
        <div>
          <span class="tag tag-alert">${KIND_TEXT[a.kind] || a.kind}</span>
          <b style="margin-left:8px">${esc(a.title)}</b>
          <div class="muted">${esc(a.detail)} · ${esc(a.created_at.replace("T", " "))}${a.tank_code ? " · " + esc(a.tank_code) : ""}</div>
        </div>
        <div>${a.status === "resolved" ? '<span class="tag tag-done">已解决</span>'
          : `<button class="btn btn-ghost btn-sm" data-resolve="${a.id}">标记解决</button>`}</div>
      </div>
    </div>`).join("");

  const handlingRows = handling.map((h) => `
    <tr>
      <td>#${h.id}</td>
      <td><span class="tag tag-alert">${KIND_TEXT[h.anomaly_kind] || h.anomaly_kind}</span> ${esc(h.title)}</td>
      <td>${esc(h.tank_code || "—")}</td>
      <td>${h.status === "done"
        ? `<span class="tag tag-done">✔ ${esc((h.completed_at || "").slice(5, 16).replace("T", " "))} ${esc(h.completed_by)}</span>`
        : `<button class="btn btn-mint" data-hscan="${esc(h.scan_code)}">扫码完成处置</button>`}</td>
    </tr>`).join("");

  main.innerHTML = `
    <div class="card">
      <h2>异常观察（色带 + 文字双重标识）</h2>
      ${bands || '<p class="muted">暂无异常</p>'}
    </div>
    <div class="card">
      <h2>处置任务（重复扫码不会重复完成）</h2>
      <div class="table-wrap"><table>
        <thead><tr><th>#</th><th>任务</th><th>水槽</th><th>状态</th></tr></thead>
        <tbody>${handlingRows || '<tr><td colspan="4" class="muted">暂无处置任务</td></tr>'}</tbody>
      </table></div>
    </div>
    <div class="card">
      <h2>登记生物拒食</h2>
      <form id="refusalForm" class="row">
        <label class="field">水槽
          <select name="tank_id">${tanks.map((t) => `<option value="${t.id}">${esc(t.code)} ${esc(t.name)}</option>`).join("")}</select></label>
        <label class="field" style="flex:2;min-width:220px">观察详情<input name="detail" placeholder="如：投喂后集群不进食"></label>
        <button class="btn btn-coral" type="submit">登记拒食</button>
      </form>
    </div>`;

  $$("[data-resolve]").forEach((b) => b.addEventListener("click", async () => {
    await api(`/api/anomalies/${b.dataset.resolve}/resolve`, { method: "POST", body: {} });
    toast("异常已标记解决", "mint"); viewAnomalies();
  }));
  $$("[data-hscan]").forEach((b) => b.addEventListener("click", () =>
    openScan("扫码完成处置任务", b.dataset.hscan, "/api/scan/handling", viewAnomalies)));
  $("#refusalForm").onsubmit = async (ev) => {
    ev.preventDefault();
    const f = ev.target;
    await api("/api/anomalies/refusal", { method: "POST", body: { tank_id: parseInt(f.tank_id.value), detail: f.detail.value } });
    toast("已登记拒食并生成处置任务", "mint"); viewAnomalies();
  };
}

/* ================= 视图：交接日志 ================= */
async function viewHandoffs() {
  const handoffs = await api("/api/handoffs");
  const rows = handoffs.map((h) => `
    <div class="card">
      <div class="row" style="justify-content:space-between">
        <b>${esc(h.shift_date)} · ${esc(h.from_person)} → ${esc(h.to_person)}</b>
        <span class="muted">${esc(h.created_at.replace("T", " "))}</span>
      </div>
      <p style="margin:8px 0 0">${esc(h.content)}</p>
    </div>`).join("");

  main.innerHTML = `
    <div class="card">
      <h2>新增交接</h2>
      <form id="handoffForm" class="grid grid-2">
        <label class="field">班次日期<input name="shift_date" type="date" value="${new Date().toISOString().slice(0, 10)}" required></label>
        <div class="row">
          <label class="field" style="flex:1">交班人<input name="from_person" required></label>
          <label class="field" style="flex:1">接班人<input name="to_person" required></label>
        </div>
        <label class="field" style="grid-column:1/-1">交接内容<textarea name="content" required placeholder="设备状态、异常进展、投喂注意事项…"></textarea></label>
        <div><button class="btn btn-primary btn-lg" type="submit">保存交接</button></div>
      </form>
    </div>
    ${rows || '<div class="card"><p class="muted">暂无交接记录</p></div>'}`;

  $("#handoffForm").onsubmit = async (ev) => {
    ev.preventDefault();
    const f = ev.target;
    try {
      await api("/api/handoffs", {
        method: "POST",
        body: { shift_date: f.shift_date.value, from_person: f.from_person.value, to_person: f.to_person.value, content: f.content.value },
      });
      toast("交接日志已保存", "mint"); viewHandoffs();
    } catch (e) { toast(e.message, "coral"); }
  };
}

/* ================= 倒计时 & 提醒 ================= */
function tickCountdowns() {
  $$(".countdown[data-scheduled]").forEach((el) => {
    const target = new Date(el.dataset.scheduled.replace("T", " "));
    const diff = target - Date.now();
    const abs = Math.abs(diff);
    const h = Math.floor(abs / 3600000), m = Math.floor((abs % 3600000) / 60000), s = Math.floor((abs % 60000) / 1000);
    const txt = `${h ? h + "小时" : ""}${m}分${s}秒`;
    if (diff >= 0) {
      el.textContent = `⏳ 剩余 ${txt}`;
      el.classList.remove("overdue");
    } else {
      el.textContent = `⚠ 已逾期 ${txt}（超过30分钟将记为漏投）`;
      el.classList.add("overdue");
    }
  });
}
setInterval(tickCountdowns, 1000);

async function pollReminders() {
  try {
    const list = await api("/api/reminders");
    const badge = $("#reminderCount");
    badge.textContent = list.length;
    badge.classList.toggle("hidden", list.length === 0);
    $("#reminderBell").onclick = async () => {
      if (!list.length) return toast("暂无到期提醒");
      const msg = list.map((r) => `• ${r.message}（${r.fired_at.slice(11, 16)}）`).join("\n");
      alert("到期提醒：\n" + msg);
      await api("/api/reminders/read", { method: "POST", body: {} });
      pollReminders();
    };
  } catch (e) { /* 忽略轮询错误 */ }
}
setInterval(pollReminders, 20000);

/* ================= 路由 ================= */
const VIEWS = { tanks: viewTanks, calendar: viewCalendar, feeds: viewFeeds, equipment: viewEquipment, anomalies: viewAnomalies, handoffs: viewHandoffs };
$("#tabs").addEventListener("click", (e) => {
  const btn = e.target.closest(".tab");
  if (!btn) return;
  $$(".tab").forEach((t) => t.classList.toggle("active", t === btn));
  VIEWS[btn.dataset.view]();
});

viewTanks();
pollReminders();
