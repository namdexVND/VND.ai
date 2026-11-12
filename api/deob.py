"""POST /api/deob?mode=full|fast|detect  (body = Lua source, text/plain)
GET  /api/deob                          -> {"ok": true, "luau": bool}

Runs deobf/deob.py (the full Luau-VM based pipeline) in a subprocess.
Vercel's filesystem is read-only except /tmp, so the tool is copied to /tmp once per cold start.
"""
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from http.server import BaseHTTPRequestHandler
from urllib.parse import parse_qs, urlparse

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "deobf")
RUN = "/tmp/deobf_run"
MAX_BODY = 4_000_000            # Vercel rejects request bodies over 4.5 MB
TIMEOUT = int(os.environ.get("DEOB_TIMEOUT", "240"))   # deob.py --timeout (function limit is 300 s)
PLUGINS = {"luraph_v15", "ironbrew1", "generic"}


def prepare():
    """Copy the tool to /tmp (keeps exec bits reliable); returns True when luau exists."""
    if not os.path.exists(os.path.join(RUN, ".ready")):
        shutil.rmtree(RUN, ignore_errors=True)
        shutil.copytree(SRC, RUN, ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
        for n in ("luau", "luau-ast"):
            p = os.path.join(RUN, "bin", n)
            if os.path.exists(p):
                os.chmod(p, 0o755)
        open(os.path.join(RUN, ".ready"), "w").close()
    return os.path.exists(os.path.join(RUN, "bin", "luau"))


def read_text(path):
    data = open(path, "rb").read()
    try:
        return data.decode("utf-8")
    except UnicodeDecodeError:
        return data.decode("latin-1")


class handler(BaseHTTPRequestHandler):
    def _send(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        try:
            self._send(200, {"ok": True, "luau": prepare()})
        except Exception as e:
            self._send(200, {"ok": True, "luau": False, "error": str(e)})

    def do_POST(self):
        t0 = time.time()
        q = parse_qs(urlparse(self.path).query)
        mode = (q.get("mode") or ["full"])[0]
        obf = (q.get("obf") or [""])[0]
        n = int(self.headers.get("Content-Length") or 0)
        if n <= 0 or n > MAX_BODY:
            return self._send(413, {"ok": False, "error": "File rỗng hoặc lớn hơn 4 MB (giới hạn của Vercel)."})
        body = self.rfile.read(n)
        try:
            has_luau = prepare()
        except Exception as e:
            return self._send(500, {"ok": False, "error": "Không chuẩn bị được engine: %s" % e})
        work = tempfile.mkdtemp(prefix="job_", dir="/tmp")
        try:
            inp, out = os.path.join(work, "script.lua"), os.path.join(work, "result.lua")
            with open(inp, "wb") as f:
                f.write(body)
            deob = os.path.join(RUN, "deob.py")
            if mode == "detect":
                r = subprocess.run([sys.executable, deob, inp, "--detect"], capture_output=True, text=True, timeout=30)
                return self._send(200, {"ok": True, "detect": r.stdout.strip()})
            if not has_luau:
                return self._send(503, {"ok": False, "error": "Chưa có deobf/bin/luau (build bằng GitHub Actions, xem README)."})
            cmd = [sys.executable, deob, inp, "-o", out, "--no-pypy", "--timeout", str(TIMEOUT)]
            if mode == "fast":
                cmd.append("--no-devirt")
            if obf in PLUGINS:
                cmd += ["--obfuscator", obf]
            try:
                r = subprocess.run(cmd, capture_output=True, text=True, timeout=TIMEOUT + 30, cwd=work)
            except subprocess.TimeoutExpired:
                return self._send(504, {"ok": False, "error": "Hết thời gian xử lý. Thử chế độ nhanh (chỉ trace)."})
            log = (r.stderr or "")[-4000:]
            if r.returncode != 0 or not os.path.exists(out):
                return self._send(500, {"ok": False, "error": "deob.py thất bại (mã %s)." % r.returncode, "log": log})
            m = re.search(r"obfuscator: (.+?)(?: \(detected|\s*$)", log, re.M)
            self._send(200, {"ok": True, "text": read_text(out), "log": log,
                             "obfuscator": m.group(1).strip() if m else "", "ms": int((time.time() - t0) * 1000)})
        except Exception as e:
            self._send(500, {"ok": False, "error": str(e)})
        finally:
            shutil.rmtree(work, ignore_errors=True)
