# Fault Report Analyzer

项目已重构为 `FastAPI + React`：
- 后端：FastAPI 提供上传分析与报告管理 API
- 前端：React 页面用于上传和选择历史分析结果

上传 `xlsx/xls/csv` 故障报表后，服务端自动按负责人和故障项统计，并保存分析历史。  
也支持上传压缩包（`.zip/.tar/.tar.gz/.tgz/.tbz2/.txz`），服务端会自动提取其中的 `alarm_local.csv`。

## 1. 安装依赖

### Python（后端）

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

### Node.js（前端）

```bash
npm install
```

## 2. 开发模式运行

### 后端启动命令（指定）

```bash
python3 -m uvicorn backend.main:app --reload --host 0.0.0.0 --port 3001
```

### 启动 FastAPI（端口 8000）

```bash
python3 -m uvicorn backend.main:app --reload --host 0.0.0.0 --port 8000
```

### 启动前端 Vite（端口 5173）

```bash
npm run dev
```

打开：
`http://localhost:5173`

说明：Vite 已配置把 `/api/*` 自动代理到 `http://127.0.0.1:8000`。

## 3. 生产模式运行（FastAPI 直出前端）

```bash
npm run build
python3 -m uvicorn backend.main:app --host 0.0.0.0 --port 3001
```

打开：
`http://localhost:8000`

## API 文档

FastAPI 自动文档：
- Swagger UI: `http://localhost:8000/docs`
- ReDoc: `http://localhost:8000/redoc`

## API 列表

Base URL: `http://localhost:8000`

### 请求者识别（IP -> 用户）

`GET /api/requester`

服务端会优先按 `x-forwarded-for`、`x-real-ip`、`client.host` 解析请求方 IP，  
并在 `backend/config/user_ip_map.json` 中匹配用户信息。

### 健康检查

`GET /api/health`

### 上传并分析报表

`POST /api/reports/analyze`

- Content-Type: `multipart/form-data`
- file 字段名必须是 `file`
- 支持 `.xlsx`、`.xls`、`.csv`
- 支持压缩包：`.zip`、`.tar`、`.tar.gz`、`.tgz`、`.tbz2`、`.txz`
- 上传压缩包时，自动提取 `alarm_local.csv` 进行分析

示例：

```bash
curl -X POST "http://localhost:8000/api/reports/analyze" \
  -F "file=/media/qzq/4t/TV/htkj_zhengxian/runs/STATUS/alarm_local.csv"
```

也支持传统文件上传方式：

```bash
curl -X POST "http://localhost:8000/api/reports/analyze" \
  -F "file=@/absolute/path/fault_report.xlsx"
```

兼容旧接口：
`POST /api/upload`（参数相同）

### 压缩包分析专用 API

`POST /api/reports/analyze-archive`

说明：
- 参数同 `POST /api/reports/analyze`
- 上传压缩包时会自动提取 `alarm_local.csv`

示例：

```bash
curl -X POST "http://localhost:8000/api/reports/analyze-archive" \
  -F "file=@/absolute/path/report_package.zip"
```

### 获取报告列表

`GET /api/reports`

返回历史报告（包含分析摘要），前端可直接用于列表展示与选择。

### 触发“所有人最新报告”汇总

`POST /api/reports/aggregate-latest`

说明：
- 以“上传者（`uploader_user`，若为空则用 `uploader_ip`）”分组
- 每组仅取最新一份报告
- 将这些最新报告的报警统计汇总成一个新报告并返回
- 汇总报告类型为 `report_type = "aggregate_latest_all"`，前端左侧以橙色加粗“汇总”显示

示例：

```bash
curl -X POST "http://localhost:8000/api/reports/aggregate-latest"
```

### 获取单个报告详情

`GET /api/reports/:id`

示例：

```bash
curl "http://localhost:8000/api/reports/1"
```

### 删除报告

`DELETE /api/reports/:id`

权限规则：
- 服务启动机器发起的请求可删除任意报告（识别为服务机本地回环 IP 与本机网卡 IP）
- 其他机器仅可删除 `uploader_ip` 与当前请求 IP 相同的报告

## Excel 字段说明

默认优先读取：
- 负责人：`pkgs`（也兼容 `owner`、`负责人`、`处理人`、`责任人`）
- 故障描述：`desc`（也兼容 `fault`、`fault_desc`、`故障`、`故障描述`、`问题描述`）

## IP 映射配置

配置文件路径：
`backend/config/user_ip_map.json`

示例结构：

```json
[
  {
    "user": "wjx",
    "uid": 1113,
    "ip": "192.168.2.23",
    "group": "algorithm",
    "note": "",
    "keycloak_id": ""
  }
]
```

说明：
- 上传接口会记录上传者信息（`uploader_user`、`uploader_uid`、`uploader_ip`）
- 前端的 “Only My Uploaded Reports” 按该上传者信息筛选报告

## 压缩包备份配置

配置文件路径：
`backend/config/app_config.json`

配置项：
- `archive_backup_enabled`: 是否启用压缩包备份
- `archive_backup_dir`: 压缩包备份目录（可用绝对路径；相对路径按项目根目录解析）
- `max_upload_size_mb`: 上传大小上限（单位 MB，默认 `500`）
- `alarm_warning_threshold`: 报警数量阈值（默认 `100`，前端用于标记“负责人下存在单个项目报警数超过该阈值”）

保存规则：
- 备份文件会按用户名称分子目录保存：
`<archive_backup_dir>/<user>/YYYYMMDD_HHMMSS_xxxxxx_report_<报告ID>_<原压缩包文件名>`

示例：

```json
{
  "archive_backup_enabled": true,
  "archive_backup_dir": "/data/fault_report_archive_backups",
  "max_upload_size_mb": 500,
  "alarm_warning_threshold": 100
}
```
