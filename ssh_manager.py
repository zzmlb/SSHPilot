import io
import os
import stat
import threading
import time
from collections import defaultdict
from typing import Optional

import paramiko

TRASH_DIR = "~/.ssh-fm-trash"


class SSHConnection:
    def __init__(self, host: str, port: int, username: str,
                 password: str = "", private_key: str = "", auth_type: str = "password",
                 key_file: str = ""):
        self.host = host
        self.port = port
        self.username = username
        self.password = password
        self.private_key = private_key
        self.auth_type = auth_type
        self.key_file = key_file
        self.client: Optional[paramiko.SSHClient] = None
        self.sftp: Optional[paramiko.SFTPClient] = None
        self.last_active = time.time()
        self._lock = threading.Lock()
        self._trash_dir: Optional[str] = None

    def connect(self):
        self.client = paramiko.SSHClient()
        self.client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
        kwargs = {
            "hostname": self.host,
            "port": self.port,
            "username": self.username,
            "timeout": 10,
        }
        if self.auth_type == "key_file":
            key_path = os.path.expanduser(self.key_file or "~/.ssh/id_rsa")
            kwargs["key_filename"] = key_path
        elif self.auth_type == "key" and self.private_key:
            pkey = paramiko.RSAKey.from_private_key(io.StringIO(self.private_key))
            kwargs["pkey"] = pkey
        else:
            kwargs["password"] = self.password
        self.client.connect(**kwargs)
        self.sftp = self.client.open_sftp()
        self.last_active = time.time()

    def ensure_connected(self):
        with self._lock:
            if self.client is None or self.client.get_transport() is None or not self.client.get_transport().is_active():
                self.connect()
            self.last_active = time.time()

    def exec_command(self, cmd: str) -> tuple[str, str]:
        self.ensure_connected()
        _, stdout, stderr = self.client.exec_command(cmd, timeout=30)
        return stdout.read().decode("utf-8", errors="replace"), stderr.read().decode("utf-8", errors="replace")

    def list_dir(self, path: str) -> list[dict]:
        self.ensure_connected()
        entries = []
        for attr in self.sftp.listdir_attr(path):
            is_dir = stat.S_ISDIR(attr.st_mode) if attr.st_mode else False
            is_link = stat.S_ISLNK(attr.st_mode) if attr.st_mode else False
            entries.append({
                "name": attr.filename,
                "size": attr.st_size or 0,
                "mtime": attr.st_mtime or 0,
                "is_dir": is_dir,
                "is_link": is_link,
                "permissions": oct(attr.st_mode & 0o777) if attr.st_mode else "0o000",
            })
        entries.sort(key=lambda e: (not e["is_dir"], e["name"].lower()))
        return entries

    def read_file(self, path: str) -> bytes:
        self.ensure_connected()
        with self.sftp.open(path, "rb") as f:
            return f.read()

    def write_file(self, path: str, data: bytes):
        self.ensure_connected()
        with self.sftp.open(path, "wb") as f:
            f.write(data)

    def mkdir(self, path: str):
        self.ensure_connected()
        self.sftp.mkdir(path)

    def remove(self, path: str):
        self.ensure_connected()
        try:
            self.sftp.remove(path)
        except IOError:
            self.exec_command(f"rm -rf {self._quote(path)}")

    def trash(self, path: str) -> str:
        """Move file/dir to trash instead of deleting. Returns trash path."""
        self.ensure_connected()
        trash_base = self._resolve_trash_dir()
        ts = int(time.time() * 1000)
        basename = os.path.basename(path)
        trash_path = f"{trash_base}/{ts}_{basename}"
        self.exec_command(f"mv {self._quote(path)} {self._quote(trash_path)}")
        return trash_path

    def restore_from_trash(self, trash_path: str, original_path: str):
        """Restore a file from trash to its original location."""
        parent = os.path.dirname(original_path)
        self.exec_command(f"mkdir -p {self._quote(parent)}")
        out, err = self.exec_command(f"mv {self._quote(trash_path)} {self._quote(original_path)}")
        if err.strip():
            raise RuntimeError(err.strip())

    def list_trash(self) -> list[dict]:
        """List items in trash directory."""
        trash_base = self._resolve_trash_dir()
        try:
            entries = self.list_dir(trash_base)
        except Exception:
            return []
        result = []
        for e in entries:
            name = e["name"]
            sep = name.find("_")
            if sep > 0:
                ts_str = name[:sep]
                original_name = name[sep + 1:]
                try:
                    ts = int(ts_str) / 1000
                except ValueError:
                    ts = e["mtime"]
                    original_name = name
            else:
                ts = e["mtime"]
                original_name = name
            result.append({
                **e,
                "original_name": original_name,
                "trash_path": f"{trash_base}/{name}",
                "deleted_at": ts,
            })
        result.sort(key=lambda x: x["deleted_at"], reverse=True)
        return result

    def empty_trash(self):
        trash_base = self._resolve_trash_dir()
        self.exec_command(f"rm -rf {self._quote(trash_base)}")
        self.exec_command(f"mkdir -p {self._quote(trash_base)}")

    def delete_trash_item(self, trash_path: str):
        self.exec_command(f"rm -rf {self._quote(trash_path)}")

    def _resolve_trash_dir(self) -> str:
        if self._trash_dir:
            return self._trash_dir
        out, _ = self.exec_command(f"mkdir -p {TRASH_DIR} && echo $HOME/.ssh-fm-trash")
        self._trash_dir = out.strip() or "/tmp/.ssh-fm-trash"
        return self._trash_dir

    def rename(self, old: str, new: str):
        self.ensure_connected()
        self.sftp.rename(old, new)

    def copy_file(self, src: str, dst: str):
        out, err = self.exec_command(f"cp -r {self._quote(src)} {self._quote(dst)}")
        if err.strip():
            raise RuntimeError(err.strip())

    def move_file(self, src: str, dst: str):
        out, err = self.exec_command(f"mv {self._quote(src)} {self._quote(dst)}")
        if err.strip():
            raise RuntimeError(err.strip())

    def compress(self, paths: list[str], archive_name: str, cwd: str):
        quoted = " ".join(self._quote(os.path.basename(p)) for p in paths)
        if archive_name.endswith(".zip"):
            cmd = f"cd {self._quote(cwd)} && zip -r {self._quote(archive_name)} {quoted}"
        else:
            cmd = f"cd {self._quote(cwd)} && tar czf {self._quote(archive_name)} {quoted}"
        out, err = self.exec_command(cmd)
        if err.strip() and "tar:" not in err:
            raise RuntimeError(err.strip())

    def decompress(self, path: str, cwd: str):
        if path.endswith(".zip"):
            cmd = f"cd {self._quote(cwd)} && unzip -o {self._quote(path)}"
        elif path.endswith(".tar.gz") or path.endswith(".tgz"):
            cmd = f"cd {self._quote(cwd)} && tar xzf {self._quote(path)}"
        elif path.endswith(".tar"):
            cmd = f"cd {self._quote(cwd)} && tar xf {self._quote(path)}"
        else:
            raise RuntimeError(f"Unsupported archive format: {path}")
        out, err = self.exec_command(cmd)
        if err.strip():
            raise RuntimeError(err.strip())

    def get_stat(self, path: str):
        self.ensure_connected()
        return self.sftp.stat(path)

    def close(self):
        if self.sftp:
            self.sftp.close()
        if self.client:
            self.client.close()

    @staticmethod
    def _quote(s: str) -> str:
        return "'" + s.replace("'", "'\\''") + "'"


class OperationLog:
    """Per-node undo stack for reversible operations."""

    def __init__(self, max_size: int = 50):
        self._stacks: dict[int, list[dict]] = defaultdict(list)
        self.max_size = max_size

    def push(self, node_id: int, op: dict):
        stack = self._stacks[node_id]
        stack.append(op)
        if len(stack) > self.max_size:
            stack.pop(0)

    def pop(self, node_id: int) -> Optional[dict]:
        stack = self._stacks[node_id]
        return stack.pop() if stack else None

    def peek(self, node_id: int) -> Optional[dict]:
        stack = self._stacks[node_id]
        return stack[-1] if stack else None

    def list(self, node_id: int) -> list[dict]:
        return list(reversed(self._stacks.get(node_id, [])))


op_log = OperationLog()


class ConnectionPool:
    def __init__(self, idle_timeout: int = 600):
        self._pool: dict[int, SSHConnection] = {}
        self._lock = threading.Lock()
        self.idle_timeout = idle_timeout
        self._cleaner = threading.Thread(target=self._cleanup_loop, daemon=True)
        self._cleaner.start()

    def get(self, node_id: int, **kwargs) -> SSHConnection:
        with self._lock:
            conn = self._pool.get(node_id)
            if conn is not None:
                conn.ensure_connected()
                return conn
        new_conn = SSHConnection(**kwargs)
        new_conn.connect()
        with self._lock:
            existing = self._pool.get(node_id)
            if existing is not None:
                new_conn.close()
                existing.ensure_connected()
                return existing
            self._pool[node_id] = new_conn
            return new_conn

    def remove(self, node_id: int):
        with self._lock:
            conn = self._pool.pop(node_id, None)
            if conn:
                conn.close()

    def _cleanup_loop(self):
        while True:
            time.sleep(60)
            now = time.time()
            with self._lock:
                expired = [nid for nid, c in self._pool.items()
                           if now - c.last_active > self.idle_timeout]
                for nid in expired:
                    self._pool.pop(nid, None).close()


pool = ConnectionPool()
