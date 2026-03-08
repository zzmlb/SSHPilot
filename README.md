# SSHPilot

基于 Web 的 SSH 远程文件管理器，支持多节点管理、双面板跨服务器传输。

![Python](https://img.shields.io/badge/Python-3.11+-blue)
![FastAPI](https://img.shields.io/badge/FastAPI-green)
![License](https://img.shields.io/badge/License-MIT-yellow)

## 功能

- **多节点管理** — 添加、编辑、删除 SSH 服务器节点，支持密码 / 密钥文件 / 粘贴私钥三种认证方式
- **双面板模式** — 同时打开两台服务器，左右拖拽跨服务器传输文件
- **文件操作** — 浏览、上传、下载、重命名、复制、移动、压缩 / 解压
- **在线编辑器** — 直接编辑远程文本文件，支持语法高亮行号、Ctrl+S 保存
- **回收站 & 撤销** — 删除文件进回收站，支持恢复和撤销操作
- **SSH 密钥扫描** — 自动读取本机 `~/.ssh/` 配置，一键扫描可免密直连的服务器
- **安全机制** — 凭据加密存储、HMAC Token 认证、登录限速、安全响应头

## 截图预览

| 登录页 | 双面板文件管理 |
|:---:|:---:|
| 暗色主题登录界面 | 左右面板跨服务器操作 |

## 快速部署

### Docker（推荐）

```bash
git clone https://github.com/zzmlb/SSHPilot.git
cd SSHPilot
docker compose up -d
```

启动后访问 `http://your-ip:8888`，首次启动会自动生成管理员密码，查看日志获取：

```bash
docker compose logs sshpilot
```

### 手动部署

```bash
git clone https://github.com/zzmlb/SSHPilot.git
cd SSHPilot
pip install -r requirements.txt
uvicorn app:app --host 0.0.0.0 --port 8888
```

## 默认账号

首次启动会自动生成管理员凭据并输出到控制台日志，格式如下：

```
==================================================
  Auto-generated admin credentials:
  Username: admin
  Password: xxxxxxxxxxxxxxxx
  (Saved in data/auth.conf)
==================================================
```

如需重置密码，删除 `data/auth.conf` 后重启即可。

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
├── app.py              # FastAPI 主应用 & 路由
├── security.py         # 加密、认证、限速
├── ssh_manager.py      # SSH 连接池 & 文件操作
├── models.py           # SQLAlchemy 数据模型
├── requirements.txt    # Python 依赖
├── Dockerfile
├── docker-compose.yml
├── static/
│   ├── index.html      # 主界面
│   ├── login.html      # 登录页
│   ├── app.js          # 前端逻辑
│   └── style.css       # 样式
└── data/               # 运行时数据（不入库）
    ├── .secret_key     # 加密密钥
    ├── auth.conf       # 管理员凭据
    └── nodes.db        # 节点数据库
```

## License

MIT
