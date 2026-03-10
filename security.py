import base64
import hashlib
import hmac
import os
import secrets
import time
from collections import defaultdict

SECRET_KEY_FILE = "data/.secret_key"
CONFIG_FILE = "data/auth.conf"


def get_secret_key() -> bytes:
    if os.path.exists(SECRET_KEY_FILE):
        with open(SECRET_KEY_FILE, "rb") as f:
            return f.read()
    key = secrets.token_bytes(32)
    os.makedirs("data", exist_ok=True)
    with open(SECRET_KEY_FILE, "wb") as f:
        f.write(key)
    os.chmod(SECRET_KEY_FILE, 0o600)
    return key


SECRET_KEY = get_secret_key()


def encrypt_field(plaintext: str) -> str:
    """Simple HMAC-based obfuscation for stored credentials.
    Uses XOR with key-derived pad. Not military-grade but prevents plain-text storage."""
    if not plaintext:
        return ""
    data = plaintext.encode("utf-8")
    nonce = secrets.token_bytes(16)
    pad = _derive_pad(nonce, len(data))
    encrypted = bytes(a ^ b for a, b in zip(data, pad))
    return "ENC:" + base64.b64encode(nonce + encrypted).decode("ascii")


def decrypt_field(stored: str) -> str:
    if not stored or not stored.startswith("ENC:"):
        return stored
    raw = base64.b64decode(stored[4:])
    nonce = raw[:16]
    encrypted = raw[16:]
    pad = _derive_pad(nonce, len(encrypted))
    decrypted = bytes(a ^ b for a, b in zip(encrypted, pad))
    return decrypted.decode("utf-8")


def _derive_pad(nonce: bytes, length: int) -> bytes:
    pad = b""
    counter = 0
    while len(pad) < length:
        pad += hashlib.sha256(SECRET_KEY + nonce + counter.to_bytes(4, "big")).digest()
        counter += 1
    return pad[:length]


def hash_password(password: str) -> str:
    salt = secrets.token_hex(16)
    h = hashlib.pbkdf2_hmac("sha256", password.encode(), salt.encode(), 100000)
    return f"{salt}:{h.hex()}"


def verify_password(password: str, stored: str) -> bool:
    if ":" not in stored:
        return hmac.compare_digest(password, stored)
    salt, h = stored.split(":", 1)
    computed = hashlib.pbkdf2_hmac("sha256", password.encode(), salt.encode(), 100000)
    return hmac.compare_digest(computed.hex(), h)


def get_admin_credentials() -> tuple[str, str]:
    """Read admin credentials from auth.conf. Auto-generate if not exist."""
    if os.path.exists(CONFIG_FILE):
        saved_pwd_hint = ""
        with open(CONFIG_FILE, "r") as f:
            for line in f:
                stripped = line.strip()
                if stripped.startswith("# Default auto-generated password:"):
                    saved_pwd_hint = stripped.split(":", 1)[1].strip()
                if stripped and ":" in stripped and not stripped.startswith("#"):
                    user, pwd_hash = stripped.split(":", 1)
                    print(f"\n{'='*50}")
                    print(f"  SSH File Manager 登录信息")
                    print(f"  用户名: {user.strip()}")
                    if saved_pwd_hint:
                        print(f"  密  码: {saved_pwd_hint}")
                    else:
                        print(f"  密  码: (见 {CONFIG_FILE})")
                    print(f"{'='*50}\n")
                    return user.strip(), pwd_hash.strip()
    auto_pwd = secrets.token_urlsafe(16)
    pwd_hash = hash_password(auto_pwd)
    os.makedirs("data", exist_ok=True)
    with open(CONFIG_FILE, "w") as f:
        f.write(f"# SSH File Manager admin credentials\n")
        f.write(f"# Username:PasswordHash\n")
        f.write(f"# Default auto-generated password: {auto_pwd}\n")
        f.write(f"# To change password, delete this file and restart\n")
        f.write(f"admin:{pwd_hash}\n")
    os.chmod(CONFIG_FILE, 0o600)
    print(f"\n{'='*50}")
    print(f"  SSH File Manager 首次启动")
    print(f"  已自动生成管理员账号:")
    print(f"  用户名: admin")
    print(f"  密  码: {auto_pwd}")
    print(f"  (保存在 {CONFIG_FILE})")
    print(f"{'='*50}\n")
    return "admin", pwd_hash


class RateLimiter:
    def __init__(self, max_attempts: int = 10, window_seconds: int = 60):
        self.max_attempts = max_attempts
        self.window = window_seconds
        self._attempts: dict[str, list[float]] = defaultdict(list)
        self._last_cleanup = time.time()

    def _cleanup(self):
        now = time.time()
        if now - self._last_cleanup < 300:
            return
        self._last_cleanup = now
        empty_keys = [k for k, v in self._attempts.items() if not v or now - v[-1] > self.window]
        for k in empty_keys:
            del self._attempts[k]

    def is_limited(self, key: str) -> bool:
        now = time.time()
        attempts = self._attempts[key]
        self._attempts[key] = [t for t in attempts if now - t < self.window]
        self._cleanup()
        return len(self._attempts[key]) >= self.max_attempts

    def record(self, key: str):
        self._attempts[key].append(time.time())


rate_limiter = RateLimiter()
ADMIN_USER, ADMIN_PWD_HASH = get_admin_credentials()
