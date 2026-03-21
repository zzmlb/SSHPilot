import asyncio
import os
import re
import stat
import time
from contextlib import asynccontextmanager
from functools import partial

import databases
import sqlalchemy
from fastapi import FastAPI, HTTPException, UploadFile, File, Query, Form, Request, Depends
from fastapi.responses import StreamingResponse, Response
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel
from typing import Optional
from starlette.middleware.base import BaseHTTPMiddleware

from models import metadata, nodes
from ssh_manager import pool, op_log, SSHConnection, local_conn
from security import (
    encrypt_field, decrypt_field, verify_password,
    rate_limiter, ADMIN_USER, ADMIN_PWD_HASH,
)

import logging as _logging
_log = _logging.getLogger("ssh-fm")

DATABASE_URL = "sqlite:///data/nodes.db"


def _safe_err(e: Exception) -> str:
    """Strip internal paths from error messages before returning to client."""
    msg = str(e)
    msg = re.sub(r"(/[^\s'\"]+/\.ssh/[^\s'\"]*)", "[key-path]", msg)
    msg = re.sub(r"(/home/[^\s'\"]+|/root/[^\s'\"]+|/tmp/[^\s'\"]+)", "[server-path]", msg)
    if len(msg) > 200:
        msg = msg[:200] + "…"
    return msg
database = databases.Database(DATABASE_URL)

SENSITIVE_FIELDS = {"password", "private_key"}


# ---------- Security middleware ----------

class SecurityMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        response = await call_next(request)
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["X-XSS-Protection"] = "1; mode=block"
        response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
        response.headers["Cache-Control"] = "no-store"
        response.headers["Content-Security-Policy"] = (
            "default-src 'self'; "
            "style-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com; "
            "font-src 'self' https://cdnjs.cloudflare.com; "
            "script-src 'self' 'unsafe-inline'; "
            "img-src 'self' data: blob:; "
            "media-src 'self' blob:; "
            "frame-src 'self' blob:; "
            "connect-src 'self'"
        )
        return response


class AuthMiddleware(BaseHTTPMiddleware):
    OPEN_PATHS = {"/api/login"}

    async def dispatch(self, request: Request, call_next):
        path = request.url.path
        if path in self.OPEN_PATHS or path.startswith("/static/"):
            return await call_next(request)

        token = request.cookies.get("sfm_token")
        if not token or not _verify_token(token):
            if path.startswith("/api/"):
                return JSONResponse({"detail": "Unauthorized"}, status_code=401)
            return FileResponse("static/login.html")

        return await call_next(request)


import secrets as _secrets
_active_tokens: set[str] = set()


def _make_token(username: str) -> str:
    import hashlib, hmac as _hmac
    from security import SECRET_KEY
    nonce = _secrets.token_hex(8)
    ts = str(int(time.time()))
    msg = f"{username}:{ts}:{nonce}".encode()
    sig = _hmac.new(SECRET_KEY, msg, hashlib.sha256).hexdigest()[:32]
    token = f"{username}:{ts}:{nonce}:{sig}"
    _active_tokens.add(token)
    return token


def _verify_token(token: str) -> bool:
    import hashlib, hmac as _hmac
    from security import SECRET_KEY
    if token not in _active_tokens:
        return False
    parts = token.split(":")
    if len(parts) != 4:
        return False
    username, ts_str, nonce, sig = parts
    try:
        ts = int(ts_str)
    except ValueError:
        return False
    if time.time() - ts > 86400 * 7:
        _active_tokens.discard(token)
        return False
    msg = f"{username}:{ts_str}:{nonce}".encode()
    expected = _hmac.new(SECRET_KEY, msg, hashlib.sha256).hexdigest()[:32]
    return _hmac.compare_digest(sig, expected)


def _revoke_token(token: str):
    _active_tokens.discard(token)


# ---------- App ----------

@asynccontextmanager
async def lifespan(app: FastAPI):
    engine = sqlalchemy.create_engine(DATABASE_URL)
    metadata.create_all(engine)
    await database.connect()
    yield
    await database.disconnect()


app = FastAPI(title="SSH File Manager", lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)
app.add_middleware(SecurityMiddleware)
app.add_middleware(AuthMiddleware)


# ---------- Auth endpoints ----------

class LoginRequest(BaseModel):
    username: str
    password: str


@app.post("/api/login")
async def login(body: LoginRequest, request: Request):
    client_ip = request.client.host if request.client else "unknown"
    if rate_limiter.is_limited(client_ip):
        raise HTTPException(429, "Too many attempts, try again later")
    rate_limiter.record(client_ip)

    if body.username == ADMIN_USER and verify_password(body.password, ADMIN_PWD_HASH):
        token = _make_token(body.username)
        response = JSONResponse({"ok": True})
        response.set_cookie(
            "sfm_token", token,
            httponly=True, samesite="strict", secure=False, max_age=86400 * 7,
        )
        return response
    raise HTTPException(401, "Invalid credentials")


@app.post("/api/logout")
async def logout(request: Request):
    token = request.cookies.get("sfm_token", "")
    _revoke_token(token)
    response = JSONResponse({"ok": True})
    response.delete_cookie("sfm_token")
    return response


# ---------- Pydantic Models ----------

class NodeCreate(BaseModel):
    name: str
    host: str
    port: int = 22
    username: str
    auth_type: str = "password"
    password: str = ""
    private_key: str = ""
    key_file: str = ""
    country: str = ""
    provider: str = ""
    business: str = ""
    expire_date: str = ""
    cost: str = ""


class NodeUpdate(BaseModel):
    name: Optional[str] = None
    host: Optional[str] = None
    port: Optional[int] = None
    username: Optional[str] = None
    auth_type: Optional[str] = None
    password: Optional[str] = None
    private_key: Optional[str] = None
    key_file: Optional[str] = None
    country: Optional[str] = None
    provider: Optional[str] = None
    business: Optional[str] = None
    expire_date: Optional[str] = None
    cost: Optional[str] = None


class FileAction(BaseModel):
    path: str
    dest: str = ""


class CompressAction(BaseModel):
    paths: list[str]
    archive_name: str
    cwd: str


class DecompressAction(BaseModel):
    path: str
    cwd: str


class MkdirAction(BaseModel):
    path: str


class RenameAction(BaseModel):
    old_path: str
    new_path: str


class TrashRestoreAction(BaseModel):
    trash_path: str
    original_path: str


class FileWriteAction(BaseModel):
    path: str
    content: str


class FileCreateAction(BaseModel):
    path: str
    content: str = ""


class TransferAction(BaseModel):
    src_node_id: int
    src_path: str
    dst_node_id: int
    dst_path: str


# ---------- Helpers ----------

def sanitize_filename(name: str) -> str:
    return re.sub(r'[^\w\.\-\u4e00-\u9fff\u3000-\u303f]', '_', name)


def _validate_path(path: str) -> str:
    """Normalize and validate remote path to prevent path traversal."""
    if not path:
        raise HTTPException(400, "路径不能为空")
    normed = os.path.normpath(path)
    if not normed.startswith("/"):
        raise HTTPException(400, "路径必须是绝对路径")
    if "\x00" in path:
        raise HTTPException(400, "路径包含非法字符")
    return normed


MAX_UPLOAD_SIZE = 500 * 1024 * 1024   # 500 MB
MAX_TRANSFER_SIZE = 2 * 1024 * 1024 * 1024  # 2 GB

_hw_cache: dict[int, dict] = {}


def mask_node(row: dict) -> dict:
    """Strip sensitive fields before sending to client."""
    r = dict(row)
    for f in SENSITIVE_FIELDS:
        if f in r and r[f]:
            r[f] = "••••••"
    return r


# ---------- Node CRUD ----------

@app.get("/api/nodes")
async def list_nodes():
    rows = await database.fetch_all(nodes.select())
    result = []
    for r in rows:
        n = mask_node(dict(r._mapping))
        n["hw"] = _hw_cache.get(n["id"])
        result.append(n)
    return result


@app.get("/api/nodes/{node_id}")
async def get_node(node_id: int):
    row = await database.fetch_one(nodes.select().where(nodes.c.id == node_id))
    if not row:
        raise HTTPException(404, "Node not found")
    r = dict(row._mapping)
    has_pw = bool(r.get("password"))
    has_pk = bool(r.get("private_key"))
    r["password"] = "••••••" if has_pw else ""
    r["private_key"] = "••••••" if has_pk else ""
    return r


@app.post("/api/nodes")
async def create_node(node: NodeCreate):
    data = node.model_dump()
    data["password"] = encrypt_field(data["password"])
    data["private_key"] = encrypt_field(data["private_key"])
    query = nodes.insert().values(**data)
    last_id = await database.execute(query)
    return {"id": last_id, **mask_node(node.model_dump())}


@app.put("/api/nodes/{node_id}")
async def update_node(node_id: int, node: NodeUpdate):
    values = {k: v for k, v in node.model_dump().items() if v is not None}
    if not values:
        raise HTTPException(400, "No fields to update")
    if "password" in values and values["password"] != "••••••":
        values["password"] = encrypt_field(values["password"])
    elif "password" in values:
        del values["password"]
    if "private_key" in values and values["private_key"] != "••••••":
        values["private_key"] = encrypt_field(values["private_key"])
    elif "private_key" in values:
        del values["private_key"]
    if values:
        query = nodes.update().where(nodes.c.id == node_id).values(**values)
        await database.execute(query)
    conn_fields = {"host", "port", "username", "auth_type", "password", "private_key", "key_file"}
    if conn_fields & values.keys():
        pool.remove(node_id)
    return {"ok": True}


@app.delete("/api/nodes/{node_id}")
async def delete_node(node_id: int):
    pool.remove(node_id)
    query = nodes.delete().where(nodes.c.id == node_id)
    await database.execute(query)
    return {"ok": True}


# ---------- SSH connect helper ----------

async def get_conn(node_id: int):
    if node_id == 0:
        return local_conn
    row = await database.fetch_one(nodes.select().where(nodes.c.id == node_id))
    if not row:
        raise HTTPException(404, "Node not found")
    r = dict(row._mapping)
    try:
        return pool.get(
            node_id,
            host=r["host"], port=r["port"], username=r["username"],
            password=decrypt_field(r.get("password", "")),
            private_key=decrypt_field(r.get("private_key", "")),
            auth_type=r["auth_type"],
        )
    except Exception as e:
        _log.warning("SSH connect failed node=%s: %s", node_id, e)
        raise HTTPException(502, f"SSH connection failed: {_safe_err(e)}")


async def run_sync(fn, *args, **kwargs):
    """Run blocking function in thread pool to avoid blocking the event loop."""
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, partial(fn, *args, **kwargs))


@app.post("/api/connect/{node_id}")
async def test_connect(node_id: int):
    conn = await get_conn(node_id)
    if node_id == 0:
        return {"status": "connected", "echo": "ok"}
    try:
        out, _ = await run_sync(conn.exec_command, "echo ok")
    except Exception:
        pool.remove(node_id)
        conn = await get_conn(node_id)
        out, _ = await run_sync(conn.exec_command, "echo ok")
    asyncio.ensure_future(_cache_hw_info(node_id, conn))
    return {"status": "connected", "echo": out.strip()}


async def _cache_hw_info(node_id: int, conn):
    try:
        combined, _ = await run_sync(conn.exec_command,
            "nproc 2>/dev/null || grep -c ^processor /proc/cpuinfo 2>/dev/null || echo 0; "
            "echo '___'; "
            "free -b 2>/dev/null | awk 'NR==2{print $2}'; "
            "echo '___'; "
            "df -B1 / 2>/dev/null | awk 'NR==2{print $2}'"
        )
        parts = combined.split("___\n")
        cpu = int(parts[0].strip().split("\n")[0]) if parts[0].strip() else 0
        mem = int(parts[1].strip()) if len(parts) > 1 and parts[1].strip().isdigit() else 0
        disk = int(parts[2].strip()) if len(parts) > 2 and parts[2].strip().isdigit() else 0
        _hw_cache[node_id] = {"cpu": cpu, "mem_total": mem, "disk_total": disk}
    except Exception:
        pass


# ---------- File operations ----------

@app.get("/api/files/{node_id}")
async def list_files(node_id: int, path: str = "/"):
    path = _validate_path(path)
    conn = await get_conn(node_id)
    try:
        entries = await run_sync(conn.list_dir, path)
        return {"path": path, "entries": entries}
    except FileNotFoundError:
        raise HTTPException(404, "Path not found")
    except PermissionError:
        raise HTTPException(403, "Permission denied")
    except Exception as e:
        raise HTTPException(500, _safe_err(e))


@app.get("/api/files/{node_id}/download")
async def download_file(node_id: int, path: str = Query(...)):
    path = _validate_path(path)
    conn = await get_conn(node_id)
    try:
        st = await run_sync(conn.get_stat, path)
        if stat.S_ISDIR(st.st_mode):
            raise HTTPException(400, "Cannot download a directory directly, compress it first")
        data = await run_sync(conn.read_file, path)
        filename = sanitize_filename(os.path.basename(path))
        return StreamingResponse(
            iter([data]),
            media_type="application/octet-stream",
            headers={"Content-Disposition": f'attachment; filename="{filename}"'},
        )
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(500, _safe_err(e))


MAX_PREVIEW_SIZE = 20 * 1024 * 1024  # 20MB

MIME_MAP = {
    ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
    ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml",
    ".bmp": "image/bmp", ".ico": "image/x-icon",
    ".mp4": "video/mp4", ".webm": "video/webm",
    ".mp3": "audio/mpeg", ".wav": "audio/wav", ".ogg": "audio/ogg",
    ".pdf": "application/pdf",
}


@app.get("/api/files/{node_id}/preview")
async def preview_file(node_id: int, path: str = Query(...)):
    path = _validate_path(path)
    conn = await get_conn(node_id)
    try:
        st = await run_sync(conn.get_stat, path)
        if stat.S_ISDIR(st.st_mode):
            raise HTTPException(400, "Cannot preview a directory")
        if st.st_size > MAX_PREVIEW_SIZE:
            raise HTTPException(413, "文件过大，无法预览")
        ext = os.path.splitext(path)[1].lower()
        mime = MIME_MAP.get(ext)
        if not mime:
            raise HTTPException(415, "不支持预览该文件类型")
        data = await run_sync(conn.read_file, path)
        return Response(content=data, media_type=mime)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(500, _safe_err(e))


@app.post("/api/files/{node_id}/upload")
async def upload_file(node_id: int, path: str = Form(...), file: UploadFile = File(...)):
    path = _validate_path(path)
    safe_name = os.path.basename(file.filename or "upload")
    if not safe_name or safe_name.startswith("."):
        safe_name = "upload"
    conn = await get_conn(node_id)
    try:
        content = await file.read()
        if len(content) > MAX_UPLOAD_SIZE:
            raise HTTPException(413, f"文件过大 ({len(content)} bytes, 上限 {MAX_UPLOAD_SIZE})")
        remote_path = path.rstrip("/") + "/" + safe_name
        await run_sync(conn.write_file, remote_path, content)
        return {"ok": True, "path": remote_path}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(500, _safe_err(e))


MAX_EDIT_SIZE = 2 * 1024 * 1024  # 2MB


@app.get("/api/files/{node_id}/content")
async def read_file_content(node_id: int, path: str = Query(...)):
    path = _validate_path(path)
    conn = await get_conn(node_id)
    try:
        st = await run_sync(conn.get_stat, path)
        if stat.S_ISDIR(st.st_mode):
            raise HTTPException(400, "Cannot read a directory")
        if st.st_size > MAX_EDIT_SIZE:
            raise HTTPException(413, f"File too large to edit ({st.st_size} bytes, max {MAX_EDIT_SIZE})")
        data = await run_sync(conn.read_file, path)
        try:
            text = data.decode("utf-8")
        except UnicodeDecodeError:
            raise HTTPException(415, "File is not a text file (binary content)")
        return {"path": path, "content": text, "size": st.st_size}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(500, _safe_err(e))


@app.post("/api/files/{node_id}/content")
async def write_file_content(node_id: int, body: FileWriteAction):
    path = _validate_path(body.path)
    conn = await get_conn(node_id)
    try:
        await run_sync(conn.write_file, path, body.content.encode("utf-8"))
        return {"ok": True, "path": path}
    except Exception as e:
        raise HTTPException(500, _safe_err(e))


@app.post("/api/files/{node_id}/create")
async def create_file(node_id: int, body: FileCreateAction):
    path = _validate_path(body.path)
    conn = await get_conn(node_id)
    try:
        await run_sync(conn.write_file, path, body.content.encode("utf-8"))
        return {"ok": True, "path": path}
    except Exception as e:
        raise HTTPException(500, _safe_err(e))


@app.post("/api/files/{node_id}/mkdir")
async def mkdir(node_id: int, body: MkdirAction):
    path = _validate_path(body.path)
    conn = await get_conn(node_id)
    try:
        await run_sync(conn.mkdir, path)
        return {"ok": True}
    except Exception as e:
        raise HTTPException(500, _safe_err(e))


@app.post("/api/files/{node_id}/rename")
async def rename_file(node_id: int, body: RenameAction):
    old_path = _validate_path(body.old_path)
    new_path = _validate_path(body.new_path)
    conn = await get_conn(node_id)
    try:
        await run_sync(conn.rename, old_path, new_path)
        op_log.push(node_id, {
            "type": "rename", "time": time.time(),
            "old_path": old_path, "new_path": new_path,
        })
        return {"ok": True}
    except Exception as e:
        raise HTTPException(500, _safe_err(e))


@app.post("/api/files/{node_id}/copy")
async def copy_file(node_id: int, body: FileAction):
    src = _validate_path(body.path)
    dest = _validate_path(body.dest)
    conn = await get_conn(node_id)
    try:
        await run_sync(conn.copy_file, src, dest)
        return {"ok": True}
    except Exception as e:
        raise HTTPException(500, _safe_err(e))


@app.post("/api/files/{node_id}/move")
async def move_file(node_id: int, body: FileAction):
    src = _validate_path(body.path)
    dest = _validate_path(body.dest)
    conn = await get_conn(node_id)
    try:
        await run_sync(conn.move_file, src, dest)
        op_log.push(node_id, {
            "type": "move", "time": time.time(),
            "src": src, "dest": dest,
        })
        return {"ok": True}
    except Exception as e:
        raise HTTPException(500, _safe_err(e))


@app.delete("/api/files/{node_id}")
async def delete_file(node_id: int, path: str = Query(...)):
    path = _validate_path(path)
    conn = await get_conn(node_id)
    try:
        trash_path = await run_sync(conn.trash, path)
        op_log.push(node_id, {
            "type": "delete", "time": time.time(),
            "original_path": path, "trash_path": trash_path,
        })
        return {"ok": True}
    except Exception as e:
        raise HTTPException(500, _safe_err(e))


@app.post("/api/files/{node_id}/compress")
async def compress_files(node_id: int, body: CompressAction):
    cwd = _validate_path(body.cwd)
    paths = [_validate_path(p) for p in body.paths]
    archive = body.archive_name
    if "/" in archive or "\\" in archive or ".." in archive:
        raise HTTPException(400, "压缩文件名不合法")
    conn = await get_conn(node_id)
    try:
        await run_sync(conn.compress, paths, archive, cwd)
        return {"ok": True}
    except Exception as e:
        raise HTTPException(500, _safe_err(e))


@app.post("/api/files/{node_id}/decompress")
async def decompress_file(node_id: int, body: DecompressAction):
    path = _validate_path(body.path)
    cwd = _validate_path(body.cwd)
    conn = await get_conn(node_id)
    try:
        await run_sync(conn.decompress, path, cwd)
        return {"ok": True}
    except Exception as e:
        raise HTTPException(500, _safe_err(e))


# ---------- Cross-server Transfer ----------

@app.post("/api/transfer")
async def transfer_file(body: TransferAction):
    src_path = _validate_path(body.src_path)
    dst_path = _validate_path(body.dst_path)
    src_conn = await get_conn(body.src_node_id)
    dst_conn = await get_conn(body.dst_node_id)
    try:
        st = await run_sync(src_conn.get_stat, src_path)
        basename_name = os.path.basename(src_path)
        if stat.S_ISDIR(st.st_mode):
            tmp_name = f"/tmp/.sfm_xfer_{int(time.time()*1000)}.tar.gz"
            parent = os.path.dirname(src_path)
            q = SSHConnection._quote
            _, err = await run_sync(
                src_conn.exec_command,
                f"cd {q(parent)} && tar czf {q(tmp_name)} {q(basename_name)}"
            )
            if err.strip() and "tar:" not in err:
                raise RuntimeError(f"源压缩失败: {err.strip()}")
            try:
                data = await run_sync(src_conn.read_file, tmp_name)
                _log.info("transfer dir %s (%d bytes tar) -> node %s:%s",
                           src_path, len(data), body.dst_node_id, dst_path)
                if len(data) > MAX_TRANSFER_SIZE:
                    raise HTTPException(413, f"目录过大 ({len(data)} bytes), 超出传输限制")
                await run_sync(dst_conn.write_file, tmp_name, data)
                _, err2 = await run_sync(
                    dst_conn.exec_command,
                    f"cd {q(dst_path)} && tar xzf {q(tmp_name)}"
                )
                if err2.strip() and "tar:" not in err2:
                    _log.warning("transfer untar stderr: %s", err2.strip())
                    raise RuntimeError(f"目标解压失败: {err2.strip()}")
            finally:
                await run_sync(src_conn.exec_command, f"rm -f {q(tmp_name)}")
                await run_sync(dst_conn.exec_command, f"rm -f {q(tmp_name)}")
            return {"ok": True, "type": "directory", "name": basename_name}
        else:
            if st.st_size > MAX_TRANSFER_SIZE:
                raise HTTPException(413, f"文件过大 ({st.st_size} bytes), 超出传输限制")
            data = await run_sync(src_conn.read_file, src_path)
            dst_full = dst_path.rstrip("/") + "/" + basename_name
            _log.info("transfer file %s (%d bytes) -> node %s:%s",
                       src_path, len(data), body.dst_node_id, dst_full)
            await run_sync(dst_conn.write_file, dst_full, data)
            try:
                dst_st = await run_sync(dst_conn.get_stat, dst_full)
                _log.info("transfer verify: dst size=%d, src size=%d", dst_st.st_size, len(data))
            except Exception as ve:
                _log.warning("transfer verify failed: %s", ve)
            return {"ok": True, "type": "file", "name": basename_name, "size": len(data)}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(500, _safe_err(e))


# ---------- Undo ----------

@app.get("/api/undo/{node_id}")
async def get_undo_stack(node_id: int):
    history = op_log.list(node_id)
    last = op_log.peek(node_id)
    return {"last": last, "history": history}


@app.post("/api/undo/{node_id}")
async def undo_last(node_id: int):
    op = op_log.pop(node_id)
    if not op:
        raise HTTPException(404, "没有可撤销的操作")
    conn = await get_conn(node_id)
    try:
        if op["type"] == "delete":
            await run_sync(conn.restore_from_trash, op["trash_path"], op["original_path"])
            return {"ok": True, "undone": "delete", "restored": op["original_path"]}
        elif op["type"] == "move":
            await run_sync(conn.move_file, op["dest"], op["src"])
            return {"ok": True, "undone": "move", "restored": op["src"]}
        elif op["type"] == "rename":
            await run_sync(conn.rename, op["new_path"], op["old_path"])
            return {"ok": True, "undone": "rename", "restored": op["old_path"]}
        else:
            raise HTTPException(400, f"Unknown operation type: {op['type']}")
    except Exception as e:
        op_log.push(node_id, op)
        raise HTTPException(500, f"Undo failed: {_safe_err(e)}")


# ---------- Trash ----------

@app.get("/api/trash/{node_id}")
async def list_trash(node_id: int):
    conn = await get_conn(node_id)
    return await run_sync(conn.list_trash)


@app.post("/api/trash/{node_id}/restore")
async def restore_trash(node_id: int, body: TrashRestoreAction):
    tp = _validate_path(body.trash_path)
    op = _validate_path(body.original_path)
    conn = await get_conn(node_id)
    try:
        await run_sync(conn.restore_from_trash, tp, op)
        return {"ok": True}
    except Exception as e:
        raise HTTPException(500, _safe_err(e))


@app.delete("/api/trash/{node_id}")
async def empty_trash(node_id: int):
    conn = await get_conn(node_id)
    try:
        await run_sync(conn.empty_trash)
        return {"ok": True}
    except Exception as e:
        raise HTTPException(500, _safe_err(e))


@app.delete("/api/trash/{node_id}/item")
async def delete_trash_item(node_id: int, path: str = Query(...)):
    path = _validate_path(path)
    conn = await get_conn(node_id)
    try:
        await run_sync(conn.delete_trash_item, path)
        return {"ok": True}
    except Exception as e:
        raise HTTPException(500, _safe_err(e))


# ---------- Monitor ----------

import shutil as _shutil
import socket as _socket


async def _get_local_stats() -> dict:
    cpu = os.cpu_count() or 0
    loads: list[str] = []
    mem_total = mem_used = 0
    try:
        with open("/proc/loadavg") as f:
            loads = f.read().strip().split()[:3]
    except Exception:
        pass
    try:
        with open("/proc/meminfo") as f:
            info = {}
            for line in f:
                p = line.split()
                if len(p) >= 2:
                    info[p[0].rstrip(":")] = int(p[1]) * 1024
            mem_total = info.get("MemTotal", 0)
            mem_used = mem_total - info.get("MemAvailable", 0)
    except Exception:
        pass
    try:
        du = _shutil.disk_usage("/")
        disk_total, disk_used = du.total, du.used
    except Exception:
        disk_total = disk_used = 0
    uptime_str = ""
    try:
        with open("/proc/uptime") as f:
            secs = int(float(f.read().split()[0]))
            d, r = divmod(secs, 86400)
            h = r // 3600
            uptime_str = f"up {d}d {h}h"
    except Exception:
        pass
    return {"cpu": cpu, "load": loads, "mem_total": mem_total, "mem_used": mem_used,
            "disk_total": disk_total, "disk_used": disk_used, "uptime": uptime_str}


async def _fetch_node_stats(conn) -> dict:
    combined, _ = await run_sync(conn.exec_command,
        "nproc 2>/dev/null || echo 0; echo '___'; "
        "cat /proc/loadavg 2>/dev/null; echo '___'; "
        "free -b 2>/dev/null | awk 'NR==2{print $2,$3}'; echo '___'; "
        "df -B1 / 2>/dev/null | awk 'NR==2{print $2,$3}'; echo '___'; "
        "uptime -p 2>/dev/null || uptime 2>/dev/null"
    )
    s = combined.split("___\n")
    cpu = int(s[0].strip().split("\n")[0]) if s[0].strip().split("\n")[0].isdigit() else 0
    loads = s[1].strip().split()[:3] if len(s) > 1 else []
    mp = s[2].strip().split() if len(s) > 2 else []
    mem_total = int(mp[0]) if mp and mp[0].isdigit() else 0
    mem_used = int(mp[1]) if len(mp) > 1 and mp[1].isdigit() else 0
    dp = s[3].strip().split() if len(s) > 3 else []
    disk_total = int(dp[0]) if dp and dp[0].isdigit() else 0
    disk_used = int(dp[1]) if len(dp) > 1 and dp[1].isdigit() else 0
    uptime = s[4].strip() if len(s) > 4 else ""
    return {"cpu": cpu, "load": loads, "mem_total": mem_total, "mem_used": mem_used,
            "disk_total": disk_total, "disk_used": disk_used, "uptime": uptime}


@app.get("/api/monitor")
async def get_monitor():
    results = []
    local = await _get_local_stats()
    local["node_id"] = 0
    lm = _read_local_meta()
    local["name"] = lm.get("name", "本机")
    local["country"] = lm.get("country", "")
    local["provider"] = lm.get("provider", "")
    local["expire_date"] = lm.get("expire_date", "")
    local["cost"] = lm.get("cost", "")
    results.append(local)

    rows = await database.fetch_all(nodes.select())
    node_info = {}
    for r in rows:
        d = dict(r._mapping)
        node_info[d["id"]] = d

    connected_ids = set()
    for node_id, conn in list(pool._pool.items()):
        connected_ids.add(node_id)
        info = node_info.get(node_id, {})
        try:
            st = await _fetch_node_stats(conn)
            st["node_id"] = node_id
            st["name"] = info.get("name", f"Node {node_id}")
            st["expire_date"] = info.get("expire_date", "")
            st["cost"] = info.get("cost", "")
            st["country"] = info.get("country", "")
            st["provider"] = info.get("provider", "")
            results.append(st)
        except Exception:
            results.append({"node_id": node_id, "name": info.get("name", ""),
                            "expire_date": info.get("expire_date", ""),
                            "cost": info.get("cost", ""), "error": True})

    for nid, info in node_info.items():
        if nid not in connected_ids:
            results.append({
                "node_id": nid, "name": info.get("name", ""),
                "expire_date": info.get("expire_date", ""),
                "cost": info.get("cost", ""),
                "country": info.get("country", ""),
                "provider": info.get("provider", ""),
                "offline": True,
            })

    all_nodes = []
    for d in node_info.values():
        all_nodes.append({
            "id": d["id"], "name": d["name"],
            "expire_date": d.get("expire_date", ""),
            "cost": d.get("cost", ""),
            "country": d.get("country", ""),
            "provider": d.get("provider", ""),
        })

    return {"stats": results, "nodes": all_nodes}


LOCAL_META_FILE = "data/local_meta.json"

import json as _json


def _read_local_meta() -> dict:
    defaults = {"name": "本机", "country": "", "provider": "", "business": "",
                "expire_date": "", "cost": ""}
    try:
        with open(LOCAL_META_FILE, "r") as f:
            d = _json.load(f)
            defaults.update(d)
    except (FileNotFoundError, _json.JSONDecodeError):
        pass
    return defaults


def _write_local_meta(data: dict):
    os.makedirs("data", exist_ok=True)
    with open(LOCAL_META_FILE, "w") as f:
        _json.dump(data, f, ensure_ascii=False, indent=2)


@app.get("/api/local/meta")
async def get_local_meta():
    return _read_local_meta()


class LocalMetaUpdate(BaseModel):
    name: Optional[str] = None
    country: Optional[str] = None
    provider: Optional[str] = None
    business: Optional[str] = None
    expire_date: Optional[str] = None
    cost: Optional[str] = None


@app.put("/api/local/meta")
async def update_local_meta(body: LocalMetaUpdate):
    meta = _read_local_meta()
    for k, v in body.model_dump().items():
        if v is not None:
            meta[k] = v
    _write_local_meta(meta)
    return {"ok": True}


@app.get("/api/local/info")
async def get_local_info():
    hostname = _socket.gethostname()
    loop = asyncio.get_event_loop()
    try:
        r = await loop.run_in_executor(None, lambda: subprocess.run(
            ["curl", "-s", "--connect-timeout", "3", "ifconfig.me"],
            capture_output=True, text=True, timeout=5))
        exit_ip = r.stdout.strip() if r.returncode == 0 else ""
    except Exception:
        exit_ip = ""
    cpu = os.cpu_count() or 0
    mem_total = 0
    try:
        with open("/proc/meminfo") as f:
            for line in f:
                if line.startswith("MemTotal:"):
                    mem_total = int(line.split()[1]) * 1024
                    break
    except Exception:
        pass
    try:
        du = _shutil.disk_usage("/")
        disk_total = du.total
    except Exception:
        disk_total = 0
    return {"hostname": hostname, "exit_ip": exit_ip, "cpu": cpu,
            "mem_total": mem_total, "disk_total": disk_total}


# ---------- Local SSH Info ----------

@app.get("/api/local-ssh")
async def get_local_ssh_info():
    """Scan local ~/.ssh/ to show key files, known_hosts, ssh config."""
    ssh_dir = os.path.expanduser("~/.ssh")
    result = {"keys": [], "known_hosts": [], "configs": []}
    if not os.path.isdir(ssh_dir):
        return result

    for fname in sorted(os.listdir(ssh_dir)):
        fpath = os.path.join(ssh_dir, fname)
        if not os.path.isfile(fpath):
            continue
        if fname.endswith(".pub"):
            priv = fname[:-4]
            has_priv = os.path.isfile(os.path.join(ssh_dir, priv))
            try:
                with open(fpath, "r") as f:
                    pub_content = f.read().strip()
                parts = pub_content.split()
                key_type = parts[0] if parts else ""
                comment = parts[2] if len(parts) >= 3 else ""
            except Exception:
                key_type, comment = "", ""
            result["keys"].append({
                "name": priv, "pub_file": fname,
                "has_private": has_priv, "type": key_type, "comment": comment,
            })

    kh_path = os.path.join(ssh_dir, "known_hosts")
    hashed_count = 0
    if os.path.isfile(kh_path):
        seen = set()
        try:
            with open(kh_path, "r") as f:
                for line in f:
                    line = line.strip()
                    if not line or line.startswith("#") or line.startswith("@"):
                        continue
                    parts = line.split()
                    if len(parts) < 3:
                        continue
                    hosts_field = parts[0]
                    key_type = parts[1]
                    for h in hosts_field.split(","):
                        h = h.strip().strip("[]")
                        if h.startswith("|1|"):
                            hashed_count += 1
                            continue
                        if h and h not in seen:
                            seen.add(h)
                            port = 22
                            if ":" in h and not h.startswith("["):
                                hp = h.rsplit(":", 1)
                                if hp[1].isdigit():
                                    h, port = hp[0], int(hp[1])
                            result["known_hosts"].append({
                                "host": h, "port": port, "key_type": key_type,
                            })
        except Exception:
            pass
    result["known_hosts_hashed"] = hashed_count

    cfg_path = os.path.join(ssh_dir, "config")
    if os.path.isfile(cfg_path):
        try:
            current = None
            with open(cfg_path, "r") as f:
                for line in f:
                    stripped = line.strip()
                    if not stripped or stripped.startswith("#"):
                        continue
                    if stripped.lower().startswith("host ") and "*" not in stripped:
                        if current:
                            result["configs"].append(current)
                        alias = stripped.split(None, 1)[1].strip()
                        current = {"alias": alias, "hostname": "", "user": "", "port": 22, "identity_file": ""}
                    elif current:
                        key, _, val = stripped.partition(" ")
                        key = key.lower().strip()
                        val = val.strip()
                        if key == "hostname":
                            current["hostname"] = val
                        elif key == "user":
                            current["user"] = val
                        elif key == "port" and val.isdigit():
                            current["port"] = int(val)
                        elif key == "identityfile":
                            current["identity_file"] = val
            if current:
                result["configs"].append(current)
        except Exception:
            pass

    return result


import subprocess

def _test_ssh_conn(host: str, port: int, user: str) -> dict:
    """Test if we can SSH into host using local keys (BatchMode=no password prompt)."""
    try:
        r = subprocess.run(
            ["ssh", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=no",
             "-o", "ConnectTimeout=5", "-o", "LogLevel=ERROR",
             "-p", str(port), f"{user}@{host}", "echo", "__SSH_OK__"],
            capture_output=True, text=True, timeout=8,
        )
        ok = "__SSH_OK__" in r.stdout
        return {"host": host, "port": port, "user": user, "ok": ok,
                "error": "" if ok else (r.stderr.strip() or "连接失败")}
    except subprocess.TimeoutExpired:
        return {"host": host, "port": port, "user": user, "ok": False, "error": "连接超时"}
    except Exception as e:
        return {"host": host, "port": port, "user": user, "ok": False, "error": str(e)}


@app.post("/api/local-ssh/scan")
async def scan_ssh_reachable():
    """Collect hosts from ssh config + existing nodes (key_file auth), test connectivity."""
    targets: dict[str, dict] = {}

    ssh_dir = os.path.expanduser("~/.ssh")
    cfg_path = os.path.join(ssh_dir, "config")
    if os.path.isfile(cfg_path):
        try:
            current = None
            with open(cfg_path, "r") as f:
                for line in f:
                    s = line.strip()
                    if not s or s.startswith("#"):
                        continue
                    if s.lower().startswith("host ") and "*" not in s:
                        if current and current.get("hostname"):
                            key = f"{current['user']}@{current['hostname']}:{current['port']}"
                            targets[key] = {**current, "source": "ssh_config"}
                        alias = s.split(None, 1)[1].strip()
                        current = {"alias": alias, "hostname": "", "user": "root", "port": 22}
                    elif current:
                        k, _, v = s.partition(" ")
                        k = k.lower().strip()
                        v = v.strip()
                        if k == "hostname": current["hostname"] = v
                        elif k == "user": current["user"] = v
                        elif k == "port" and v.isdigit(): current["port"] = int(v)
            if current and current.get("hostname"):
                key = f"{current['user']}@{current['hostname']}:{current['port']}"
                targets[key] = {**current, "source": "ssh_config"}
        except Exception:
            pass

    # All nodes (not just key_file — the server may have deployed keys to any host)
    rows = await database.fetch_all(nodes.select())
    for r in rows:
        row = dict(r._mapping)
        key = f"{row['username']}@{row['host']}:{row['port']}"
        if key not in targets:
            targets[key] = {
                "hostname": row["host"], "port": row["port"],
                "user": row["username"], "alias": row["name"],
                "source": "node",
            }

    # Non-hashed known_hosts entries
    kh_path = os.path.join(ssh_dir, "known_hosts")
    if os.path.isfile(kh_path):
        try:
            with open(kh_path, "r") as f:
                for line in f:
                    line = line.strip()
                    if not line or line.startswith("#") or line.startswith("@"):
                        continue
                    parts = line.split()
                    if len(parts) < 3:
                        continue
                    for h in parts[0].split(","):
                        h = h.strip().strip("[]")
                        if h.startswith("|1|") or not h:
                            continue
                        port = 22
                        if ":" in h and not h.startswith("["):
                            hp = h.rsplit(":", 1)
                            if hp[1].isdigit():
                                h, port = hp[0], int(hp[1])
                        key = f"root@{h}:{port}"
                        if key not in targets:
                            targets[key] = {
                                "hostname": h, "port": port,
                                "user": "root", "alias": h,
                                "source": "known_hosts",
                            }
        except Exception:
            pass

    loop = asyncio.get_event_loop()
    tasks = []
    for info in targets.values():
        tasks.append(loop.run_in_executor(
            None, _test_ssh_conn, info["hostname"], info["port"], info["user"]
        ))

    raw_results = await asyncio.gather(*tasks, return_exceptions=True)
    results = []
    for info, res in zip(targets.values(), raw_results):
        if isinstance(res, Exception):
            res = {"host": info["hostname"], "port": info["port"], "user": info["user"],
                   "ok": False, "error": str(res)}
        res["alias"] = info.get("alias", "")
        res["source"] = info.get("source", "")
        results.append(res)

    results.sort(key=lambda x: (not x["ok"], x["host"]))
    return results


# ---------- Static files ----------

app.mount("/static", StaticFiles(directory="static"), name="static")


@app.get("/")
async def index():
    return FileResponse("static/index.html")
