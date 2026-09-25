# 水族馆水槽投喂与设备点检系统

纯 Python 标准库实现（无第三方依赖），SQLite 持久化计划与读数，点检照片保存为本地文件，
进程内后台线程处理到期提醒与漏投检测。

## 快速开始（单条命令）

```bash
python3 app.py --demo
```

一条命令完成：重建演示数据（投喂 / 停机 / 复核样例）→ 启动到期提醒进程 → 启动 Web 服务。
浏览器打开 <http://localhost:8000>。

其他用法：

```bash
python3 app.py --demo --port 8080   # 指定端口
python3 app.py                      # 不重置数据，直接启动
python3 seed.py                     # 仅重建演示数据
python3 -m unittest -v              # 运行全部测试（25 个）
```

## 演示数据包含

| 样例 | 内容 |
|---|---|
| 投喂 | T-01 计划 v1→v2→v3 版本链；已完成 / 到期（触发提醒）/ 漏投任务 |
| 停机 | F-02 点检未通过 → 停机 + 处置任务 + 冻结 T-02 投喂计划 |
| 复核 | F-01 先未通过、复核通过的点检记录（含本地照片文件） |
| 异常 | 水温异常（T-03）、生物拒食（T-04）、饲料过期（FB-2508）、漏投（T-04） |
| 读数 | 含补录读数（保留采集时间与设备编号 `TH-01-BACKUP`） |

## 业务规则

- **剂量边界**：单次剂量 ≥ 0.1g，且不得超过饲料批次剩余量；过期批次禁止用于新计划与投喂。
- **饲料扣减**：仅在投喂任务扫码完成时扣减剩余量；漏投 / 取消 / 冻结不扣减。
- **计划版本**：计划变更新增版本（v+1，同一 `lineage_id`），旧版本保留为 `replaced`；
  已执行任务的剂量快照不随计划变更重算；旧版本未执行任务取消，按新版本重新生成。
- **重复扫码**：同一二维码重复扫描返回 `duplicate`，不重复完成、不重复扣减，扫码事件留痕。
- **异常处置**：水温异常 / 过滤器停机 / 生物拒食 / 饲料过期 / 漏投 各生成异常 + 处置任务（同类未关闭去重）。
- **点检冻结**：点检未通过 → 设备停机 + 冻结关联水槽全部投喂计划（含冻结期间新建计划）；
  复核通过 → 解冻并重新生成任务。
- **补录读数**：设备编号必填；采集时间早于录入时间超过 5 分钟标记为补录，采集时间与设备编号原样保留。
- **漏投**：超过计划时间 30 分钟未完成 → 任务记 `missed` 并生成异常与处置任务。

## 架构

```
app.py        HTTP 服务（http.server，路由 + JSON API + 静态资源 + 照片上传）
service.py    全部业务规则（剂量、扣减、版本、冻结、扫码幂等、异常、读数）
db.py         SQLite 建表与连接（data/aquarium.db）
seed.py       演示数据生成
reminder.py   进程内后台线程：到期提醒 / 漏投检测 / 任务滚动生成 / 饲料过期巡检
static/       单页前端（原生 HTML/CSS/JS，海蓝 + 薄荷绿 + 珊瑚配色）
data/photos/  点检照片本地文件
test_system.py  25 个规则测试
```

## 界面

- **水槽总览**：平面水槽图定位设备（🌀 过滤器 / 🌡 恒温机），异常水槽色带 + 文字双重标识；
- **投喂日历**：任务卡显示剂量刻度与实时剩余时间倒计时，扫码完成；
- **饲料批次**：有效期与剩余量（余量刻度）；
- **设备点检**：通过 / 未通过 / 停机 / 复机，照片上传本地保存；
- **异常观察**：五类异常色带卡 + 处置任务扫码；
- **交接日志**：班次交接记录。
- 移动端：按钮与标签 ≥ 46px 大触控区，单列自适应布局。

## 主要 API

```
GET  /api/tanks                     水槽总览（含设备定位、最新水温、计划状态）
GET  /api/calendar?date=YYYY-MM-DD  投喂日历任务
POST /api/scan/feeding              扫码完成投喂（幂等）
POST /api/scan/handling             扫码完成处置任务（幂等）
GET/POST /api/plans                 计划查询 / 新建
POST /api/plans/<id>/update         计划变更（生成新版本）
GET  /api/feeds                     饲料批次
GET  /api/equipment                 设备列表
POST /api/equipment/<id>/status     停机 / 复机
GET/POST /api/inspections           点检记录 / 提交（multipart 照片）
POST /api/readings                  录入 / 补录水质读数
GET  /api/tanks/<id>/readings       水槽读数
GET  /api/anomalies                 异常列表
POST /api/anomalies/refusal         登记拒食
POST /api/anomalies/<id>/resolve    标记解决
GET/POST /api/handoffs              交接日志
GET  /api/reminders                 未读到期提醒
GET  /photos/<name>                 点检照片
```
