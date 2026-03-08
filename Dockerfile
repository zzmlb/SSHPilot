FROM python:3.11-slim

WORKDIR /app

# 安装系统依赖（openssh-client 用于 SSH 扫描功能）
RUN apt-get update && \
    apt-get install -y --no-install-recommends openssh-client && \
    rm -rf /var/lib/apt/lists/*

# 安装 Python 依赖
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# 复制应用代码
COPY . .

# 创建数据持久化目录
RUN mkdir -p /app/data

EXPOSE 8888

CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8888"]
