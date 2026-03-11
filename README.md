# SSHPilot

基于 Web 的 SSH 远程文件管理器，支持多节点管理、双面板跨服务器传输、资源监控与费用统计。

![Python](https://img.shields.io/badge/Python-3.11+-blue)
![FastAPI](https://img.shields.io/badge/FastAPI-green)
![License](https://img.shields.io/badge/License-MIT-yellow)

## 功能

### 文件管理
- **多节点管理** — 添加、编辑、删除 SSH 服务器节点，支持密码 / 密钥文件 / 粘贴私钥（RSA/Ed25519/ECDSA/DSS）三种认证方式
- **双面板模式** — 同时打开两台服务器，左右拖拽跨服务器传输文件
- **本机文件管理** — 本机作为特殊节点，与远程服务器统一操作体验
- **文件操作** — 浏览、上传、下载、重命名、复制、移动、压缩 / 解压、新建文件 / 目录
- **在线编辑器** — 直接编辑远程文本文件，支持行号显示、Ctrl+S 保存
- **列表 / 图标视图** — 文件展示支持表格和图标两种视图切换
- **隐藏文件切换** — 一键显示 / 隐藏以 `.` 开头的文件
- **分页浏览** — 每页最多显示 10 个文件，支持翻页导航
- **回收站 & 撤销** — 删除文件进回收站，支持恢复和 Ctrl+Z 撤销操作

### 监控 & 统计
- **资源监控** — 实时查看所有服务器（含本机）的 CPU、内存、磁盘使用率和负载
- **费用统计** — 月费合计、年费估算、均价，按厂商 / 国家 / 业务多维度费用分布
- **到期时间表** — 可视化展示各节点到期倒计时，自动高亮即将过期节点
- **硬件信息** — 连接后自动探测并显示 CPU 核心数、内存、磁盘容量

### 节点信息
- **丰富元数据** — 每个节点可设置国家、厂商、业务、到期时间、费用标签
- **SSH 密钥扫描** — 自动读取本机 `~/.ssh/` 配置，一键扫描可免密直连的服务器
- **本机出口 IP** — 自动探测并显示本机公网出口 IP

### 安全机制
- 凭据加密存储（XOR + HMAC-SHA256 密钥派生）
- HMAC Token 认证 + 服务端令牌吊销
- PBKDF2 密码哈希（100,000 轮）
- 登录 IP 限速（每分钟 10 次）
- Content-Security-Policy / X-Frame-Options / X-Content-Type-Options 等安全头
- CDN 资源 SRI 完整性校验
- 错误信息脱敏，不泄漏服务器内部路径
- API 文档端点已禁用

## 快速部署

### Docker（推荐）

```bash
git clone https://github.com/zzmlb/SSHPilot.git
cd SSHPilot
docker compose up -d
```

启动后访问 `http://your-ip:8899`，首次启动会自动生成管理员密码，查看日志获取：

```bash
docker compose logs sshpilot
```

### 手动部署

```bash
git clone https://github.com/zzmlb/SSHPilot.git
cd SSHPilot
pip install -r requirements.txt
uvicorn app:app --host 0.0.0.0 --port 8899
```

## 默认账号

首次启动自动生成管理员凭据并输出到控制台，**仅首次显示明文密码**：

```
==================================================
  SSH File Manager 首次启动
  已自动生成管理员账号:
  用户名: admin
  密  码: xxxxxxxxxxxxxxxx
  (保存在 data/auth.conf)
==================================================
```

后续启动不再回显密码。如需重置，删除 `data/auth.conf` 后重启即可。

## 技术栈

| 组件 | 技术 |
|---|---|
| 后端 | Python, FastAPI, Paramiko, SQLAlchemy |
| 前端 | 原生 HTML/CSS/JS, Font Awesome |
| 数据库 | SQLite |
| 部署 | Docker, Uvicorn |

## 目录结构

```
SSHPilot/
├── app.py              # FastAPI 主应用 & API 路由
├── security.py         # 加密、认证、限速、密码管理
├── ssh_manager.py      # SSH/本地连接池 & 文件操作
├── models.py           # SQLAlchemy 数据模型 & 动态迁移
├── requirements.txt    # Python 依赖
├── Dockerfile
├── docker-compose.yml
├── static/
│   ├── index.html      # 主界面（文件管理 + 监控）
│   ├── login.html      # 登录页
│   ├── app.js          # 前端逻辑
│   └── style.css       # 样式
└── data/               # 运行时数据（已 gitignore）
    ├── .secret_key     # 加密密钥
    ├── auth.conf       # 管理员凭据（哈希）
    ├── local_meta.json # 本机节点元数据
    └── nodes.db        # 节点数据库
```

## License

MIT
