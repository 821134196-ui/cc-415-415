#!/usr/bin/env bash
# 水族馆水槽投喂与设备点检系统 —— 单条本地启动命令
# 首次启动自动生成演示数据（投喂、停机、复核样例），随后启动 Web 服务。
# 用法: ./run.sh [--port 8080] [--reseed]
set -euo pipefail
cd "$(dirname "$0")"
exec node --disable-warning=ExperimentalWarning src/server.js "$@"
