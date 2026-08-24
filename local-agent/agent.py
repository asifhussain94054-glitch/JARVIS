#!/usr/bin/env python3
"""
JARVIS Local Computer Agent — Phase 1
=====================================

Gives the JARVIS website on-demand "eyes" on this computer:

  • capture_screen     — one screenshot of the primary display
  • get_active_window  — focused application + window title
  • get_screen_info    — resolution and monitor list

This process MUST stay on the local machine.

  • Binds only to 127.0.0.1 (never the public internet)
  • Requires a local bearer token on every privileged request
  • Captures the screen ONLY when JARVIS asks
  • Never capture continuously and never records in the background
  • Never writes screenshots to disk
  • Never logs screen contents, passwords, or keystrokes
  • Does NOT control the mouse or keyboard (Phase 2)
  • Does NOT use, store, or need GEMINI_API_KEY

Stop with Ctrl+C, or run stop.bat on Windows.
"""

from __future__ import annotations

import base64
import hmac
import io
import json
import logging
import os
import platform
import secrets
import socket
import subprocess
import sys
import threading
import time
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, HTTPServer
from socketserver import ThreadingMixIn
from typing import Any, Optional
from urllib.parse import urlparse

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

SERVICE_NAME = "jarvis-local-agent"
VERSION = "1.0.0-phase1"
DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 18765
MAX_BODY_BYTES = 64 * 1024
MAX_IMAGE_WIDTH = 1920
JPEG_QUALITY = 70

# Hard rule: this process never listens on a public interface.
ALLOWED_BIND_HOSTS = frozenset({"127.0.0.1", "localhost"})

DIR = os.path.dirname(os.path.abspath(__file__))
TOKEN_PATH = os.path.join(DIR, ".agent-token")

log = logging.getLogger("jarvis-agent")


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def utc_now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def is_local_origin(origin: str) -> bool:
    if not origin or origin == "null":
        return True
    try:
        parsed = urlparse(origin)
    except Exception:
        return False
    host = (parsed.hostname or "").lower()
    return host in ("127.0.0.1", "localhost")


def origin_allowed(origin: str) -> bool:
    """Remote pages may call the agent only from known JARVIS origins."""
    if is_local_origin(origin):
        return True
    if not origin:
        return True
    allowed_exact = {
        "https://asifhussain94054-glitch.github.io",
    }
    if origin in allowed_exact:
        return True
    # Any GitHub Pages host for this project owner, plus localhost https.
    if origin.startswith("https://asifhussain94054-glitch.github.io"):
        return True
    return False


def load_or_create_token(explicit: Optional[str] = None) -> str:
    if explicit:
        return explicit.strip()
    env = os.environ.get("JARVIS_AGENT_TOKEN", "").strip()
    if env:
        return env
    if os.path.isfile(TOKEN_PATH):
        try:
            existing = open(TOKEN_PATH, "r", encoding="utf-8").read().strip()
            if existing:
                return existing
        except OSError:
            pass
    token = secrets.token_urlsafe(32)
    try:
        fd = os.open(TOKEN_PATH, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(token + "\n")
    except OSError as exc:
        log.warning("Could not persist token file: %s", exc)
    return token


def refuse_public_bind(host: str) -> str:
    host = (host or DEFAULT_HOST).strip()
    if host not in ALLOWED_BIND_HOSTS:
        raise SystemExit(
            "Refusing to bind to %r. The JARVIS local agent only listens on 127.0.0.1."
            % (host,)
        )
    return "127.0.0.1" if host == "localhost" else host


# ---------------------------------------------------------------------------
# Screen / window backends
# ---------------------------------------------------------------------------

class ScreenBackend:
    """Interface used by the HTTP layer. Swap in FakeBackend during tests."""

    def capture_screen(self) -> dict:
        raise NotImplementedError

    def get_screen_info(self) -> dict:
        raise NotImplementedError

    def get_active_window(self) -> dict:
        raise NotImplementedError


class FakeBackend(ScreenBackend):
    """Deterministic backend for automated tests. Never touches the real display."""

    # Minimal valid 1x1 JPEG. Used only in tests so we do not need a display.
    TINY_JPEG = base64.b64decode(
        b"/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYI"
        b"DAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/wAALCAABAAEBAREA"
        b"/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEA"
        b"AD8AKp//2Q=="
    )

    def __init__(
        self,
        width: int = 1920,
        height: int = 1080,
        application: str = "chrome.exe",
        title: str = "YouTube",
        fail: Optional[str] = None,
    ):
        self.width = width
        self.height = height
        self.application = application
        self.title = title
        self.fail = fail  # 'permission' | 'capture' | None

    def capture_screen(self) -> dict:
        if self.fail == "permission":
            return _permission_error()
        if self.fail == "capture":
            return _capture_error()
        return {
            "ok": True,
            "width": self.width,
            "height": self.height,
            "monitor_index": 1,
            "primary": True,
            "timestamp": utc_now(),
            "mime_type": "image/jpeg",
            "image": base64.b64encode(self.TINY_JPEG).decode("ascii"),
        }

    def get_screen_info(self) -> dict:
        return {
            "ok": True,
            "width": self.width,
            "height": self.height,
            "monitor_count": 1,
            "primary": {
                "index": 1,
                "width": self.width,
                "height": self.height,
                "left": 0,
                "top": 0,
                "primary": True,
            },
            "monitors": [
                {
                    "index": 1,
                    "width": self.width,
                    "height": self.height,
                    "left": 0,
                    "top": 0,
                    "primary": True,
                }
            ],
            "timestamp": utc_now(),
        }

    def get_active_window(self) -> dict:
        return {
            "ok": True,
            "available": True,
            "application": self.application,
            "title": self.title,
            "timestamp": utc_now(),
        }


def _permission_error() -> dict:
    return {
        "ok": False,
        "error": "permission_denied",
        "message": "Sir, I don't currently have permission to access the screen.",
        "timestamp": utc_now(),
    }


def _capture_error() -> dict:
    return {
        "ok": False,
        "error": "capture_failed",
        "message": "Something went wrong while accessing the screen, sir.",
        "timestamp": utc_now(),
    }


def _unavailable(kind: str, reason: str) -> dict:
    return {
        "ok": True,
        "available": False,
        kind: None,
        "reason": reason,
        "timestamp": utc_now(),
    }


class RealBackend(ScreenBackend):
    """Windows-first backend with honest fallbacks on other platforms."""

    def capture_screen(self) -> dict:
        try:
            result = self._capture_mss()
            if result is not None:
                return result
            if sys.platform.startswith("win"):
                result = self._capture_windows_powershell()
                if result is not None:
                    return result
            return _capture_error()
        except PermissionError:
            log.info("capture_screen permission denied")
            return _permission_error()
        except Exception:
            log.exception("capture_screen failed")
            return _capture_error()

    def _encode_jpeg(self, image: Any, width: int, height: int) -> dict:
        """Resize in memory and return a JPEG payload. Never writes a file."""
        from PIL import Image as PILImage  # type: ignore

        if not isinstance(image, PILImage.Image):
            raise TypeError("expected PIL image")
        img = image
        if img.mode != "RGB":
            img = img.convert("RGB")
        w, h = img.size
        if w > MAX_IMAGE_WIDTH:
            new_h = max(1, int(h * MAX_IMAGE_WIDTH / float(w)))
            img = img.resize((MAX_IMAGE_WIDTH, new_h), PILImage.Resampling.LANCZOS)
            w, h = img.size
        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=JPEG_QUALITY, optimize=True)
        raw = buf.getvalue()
        buf.close()
        del img
        return {
            "ok": True,
            "width": w,
            "height": h,
            "source_width": width,
            "source_height": height,
            "monitor_index": 1,
            "primary": True,
            "timestamp": utc_now(),
            "mime_type": "image/jpeg",
            "image": base64.b64encode(raw).decode("ascii"),
        }

    def _capture_mss(self) -> Optional[dict]:
        try:
            import mss  # type: ignore
            from PIL import Image  # type: ignore
        except ImportError:
            return None
        try:
            with mss.mss() as sct:
                monitors = sct.monitors
                if len(monitors) < 2:
                    return None
                mon = monitors[1]  # primary (monitors[0] is the virtual union)
                raw = sct.grab(mon)
                img = Image.frombytes("RGB", raw.size, raw.bgra, "raw", "BGRX")
                return self._encode_jpeg(img, raw.size[0], raw.size[1])
        except mss.exception.ScreenShotError:
            return None

    def _capture_windows_powershell(self) -> Optional[dict]:
        """In-memory GDI capture. Output is base64 on stdout — no temp files."""
        ps = r"""
Add-Type -AssemblyName System.Windows.Forms,System.Drawing
$screen = [System.Windows.Forms.Screen]::PrimaryScreen
$b = $screen.Bounds
$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)
$g.Dispose()
$ms = New-Object System.IO.MemoryStream
$codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() |
    Where-Object { $_.MimeType -eq 'image/jpeg' }
$ep = New-Object System.Drawing.Imaging.EncoderParameters 1
$ep.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter (
    [System.Drawing.Imaging.Encoder]::Quality, [long]70)
$bmp.Save($ms, $codec, $ep)
$bmp.Dispose()
Write-Output ($b.Width.ToString() + 'x' + $b.Height.ToString())
Write-Output ([Convert]::ToBase64String($ms.ToArray()))
$ms.Dispose()
"""
        try:
            proc = subprocess.run(
                ["powershell", "-NoProfile", "-NonInteractive", "-Command", ps],
                capture_output=True,
                text=True,
                timeout=20,
            )
        except (OSError, subprocess.TimeoutExpired):
            return None
        if proc.returncode != 0:
            return None
        lines = [ln.strip() for ln in (proc.stdout or "").splitlines() if ln.strip()]
        if len(lines) < 2 or "x" not in lines[0]:
            return None
        try:
            w_s, h_s = lines[0].split("x", 1)
            width, height = int(w_s), int(h_s)
            blob = base64.b64decode(lines[1], validate=False)
        except Exception:
            return None
        if not blob:
            return None
        # Re-encode through PIL when available so oversized frames are scaled.
        try:
            from PIL import Image  # type: ignore

            img = Image.open(io.BytesIO(blob))
            return self._encode_jpeg(img, width, height)
        except Exception:
            return {
                "ok": True,
                "width": width,
                "height": height,
                "monitor_index": 1,
                "primary": True,
                "timestamp": utc_now(),
                "mime_type": "image/jpeg",
                "image": base64.b64encode(blob).decode("ascii"),
            }

    def get_screen_info(self) -> dict:
        try:
            info = self._screen_info_mss()
            if info is not None:
                return info
            if sys.platform.startswith("win"):
                info = self._screen_info_windows()
                if info is not None:
                    return info
            return {
                "ok": False,
                "error": "unavailable",
                "message": "Screen information is not available in this session.",
                "timestamp": utc_now(),
            }
        except Exception:
            log.exception("get_screen_info failed")
            return {
                "ok": False,
                "error": "unavailable",
                "message": "Screen information is not available in this session.",
                "timestamp": utc_now(),
            }

    def _screen_info_mss(self) -> Optional[dict]:
        try:
            import mss  # type: ignore
        except ImportError:
            return None
        try:
            with mss.mss() as sct:
                monitors = sct.monitors
        except Exception:
            return None
        if not monitors:
            return None
        listed = []
        for i, mon in enumerate(monitors[1:], start=1):
            listed.append({
                "index": i,
                "width": int(mon.get("width") or 0),
                "height": int(mon.get("height") or 0),
                "left": int(mon.get("left") or 0),
                "top": int(mon.get("top") or 0),
                "primary": i == 1,
            })
        if not listed:
            return None
        primary = listed[0]
        return {
            "ok": True,
            "width": primary["width"],
            "height": primary["height"],
            "monitor_count": len(listed),
            "primary": primary,
            "monitors": listed,
            "timestamp": utc_now(),
        }

    def _screen_info_windows(self) -> Optional[dict]:
        try:
            import ctypes

            user32 = ctypes.windll.user32
            width = int(user32.GetSystemMetrics(0))   # SM_CXSCREEN
            height = int(user32.GetSystemMetrics(1))  # SM_CYSCREEN
            count = int(user32.GetSystemMetrics(80))  # SM_CMONITORS
        except Exception:
            return None
        if width <= 0 or height <= 0:
            return None
        primary = {
            "index": 1,
            "width": width,
            "height": height,
            "left": 0,
            "top": 0,
            "primary": True,
        }
        return {
            "ok": True,
            "width": width,
            "height": height,
            "monitor_count": max(1, count),
            "primary": primary,
            "monitors": [primary],
            "timestamp": utc_now(),
        }

    def get_active_window(self) -> dict:
        try:
            if sys.platform.startswith("win"):
                return self._active_window_windows()
            if sys.platform.startswith("linux"):
                return self._active_window_linux()
            return {
                "ok": True,
                "available": False,
                "application": None,
                "title": None,
                "reason": "Active window information is not available on this platform.",
                "timestamp": utc_now(),
            }
        except Exception:
            log.exception("get_active_window failed")
            return {
                "ok": True,
                "available": False,
                "application": None,
                "title": None,
                "reason": "Active window information could not be read.",
                "timestamp": utc_now(),
            }

    def _active_window_windows(self) -> dict:
        import ctypes
        from ctypes import wintypes

        user32 = ctypes.windll.user32
        kernel32 = ctypes.windll.kernel32
        hwnd = user32.GetForegroundWindow()
        if not hwnd:
            return {
                "ok": True,
                "available": False,
                "application": None,
                "title": None,
                "reason": "No foreground window is available.",
                "timestamp": utc_now(),
            }

        length = user32.GetWindowTextLengthW(hwnd)
        buf = ctypes.create_unicode_buffer(length + 1)
        user32.GetWindowTextW(hwnd, buf, length + 1)
        title = buf.value or ""

        pid = wintypes.DWORD()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
        hproc = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid.value)
        application = None
        if hproc:
            try:
                size = wintypes.DWORD(32768)
                exe = ctypes.create_unicode_buffer(size.value)
                if kernel32.QueryFullProcessImageNameW(hproc, 0, exe, ctypes.byref(size)):
                    application = os.path.basename(exe.value)
            finally:
                kernel32.CloseHandle(hproc)

        return {
            "ok": True,
            "available": True,
            "application": application,
            "title": title,
            "timestamp": utc_now(),
        }

    def _active_window_linux(self) -> dict:
        """Best-effort via xdotool / xprop. Honest if the session has no display."""
        title = None
        application = None
        try:
            proc = subprocess.run(
                ["xdotool", "getactivewindow", "getwindowname"],
                capture_output=True, text=True, timeout=2,
            )
            if proc.returncode == 0:
                title = (proc.stdout or "").strip() or None
        except (OSError, subprocess.TimeoutExpired):
            pass
        try:
            proc = subprocess.run(
                ["xdotool", "getactivewindow", "getwindowpid"],
                capture_output=True, text=True, timeout=2,
            )
            if proc.returncode == 0:
                pid = (proc.stdout or "").strip()
                comm = os.path.join("/proc", pid, "comm")
                if pid.isdigit() and os.path.isfile(comm):
                    application = open(comm, "r", encoding="utf-8").read().strip()
        except (OSError, subprocess.TimeoutExpired):
            pass
        if title is None and application is None:
            return {
                "ok": True,
                "available": False,
                "application": None,
                "title": None,
                "reason": "Active window information is not available in this session.",
                "timestamp": utc_now(),
            }
        return {
            "ok": True,
            "available": True,
            "application": application,
            "title": title,
            "timestamp": utc_now(),
        }


def choose_backend() -> ScreenBackend:
    mode = os.environ.get("JARVIS_AGENT_BACKEND", "real").strip().lower()
    if mode == "fake":
        return FakeBackend()
    return RealBackend()


# ---------------------------------------------------------------------------
# HTTP server
# ---------------------------------------------------------------------------

class AgentHTTPServer(ThreadingMixIn, HTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, server_address, handler, token: str, backend: ScreenBackend):
        super().__init__(server_address, handler)
        self.agent_token = token
        self.backend = backend
        self.started_at = utc_now()


class AgentHandler(BaseHTTPRequestHandler):
    server_version = SERVICE_NAME + "/" + VERSION
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt: str, *args: Any) -> None:
        # Never log bodies (they could theoretically contain tokens).
        log.info("%s - %s", self.address_string(), fmt % args)

    def _origin(self) -> str:
        return (self.headers.get("Origin") or "").strip()

    def _send(self, code: int, payload: Any, content_type: str = "application/json") -> None:
        origin = self._origin()
        if isinstance(payload, (dict, list)):
            body = json.dumps(payload, ensure_ascii=True).encode("utf-8")
        elif isinstance(payload, str):
            body = payload.encode("utf-8")
        else:
            body = bytes(payload)
        self.send_response(code)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        # Pairing HTML is never readable from a remote page.
        if content_type.startswith("text/html"):
            if origin and not is_local_origin(origin):
                # Should not reach here; guard anyway.
                pass
            else:
                pass
        elif origin_allowed(origin):
            self.send_header("Access-Control-Allow-Origin", origin or "*")
            self.send_header("Vary", "Origin")
            self.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type, X-Jarvis-Token")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.end_headers()
        self.wfile.write(body)

    def _reject_remote_html(self) -> bool:
        origin = self._origin()
        if origin and not is_local_origin(origin):
            self._send(403, {"ok": False, "error": "forbidden"})
            return True
        return False

    def _authorized(self) -> bool:
        header = self.headers.get("Authorization") or ""
        token = ""
        if header.lower().startswith("bearer "):
            token = header[7:].strip()
        if not token:
            token = (self.headers.get("X-Jarvis-Token") or "").strip()
        expected = self.server.agent_token  # type: ignore[attr-defined]
        if not token or not expected:
            return False
        if len(token) != len(expected):
            # compare_digest requires equal length; still do a dummy compare
            hmac.compare_digest(expected, expected)
            return False
        return hmac.compare_digest(token, expected)

    def _need_auth(self) -> bool:
        if self._authorized():
            return True
        self._send(401, {
            "ok": False,
            "error": "unauthorized",
            "message": "Sir, I don't currently have permission to access the screen.",
        })
        return False

    def _read_body(self) -> Optional[bytes]:
        try:
            length = int(self.headers.get("Content-Length") or "0")
        except ValueError:
            self._send(400, {"ok": False, "error": "malformed_request"})
            return None
        if length < 0 or length > MAX_BODY_BYTES:
            self._send(400, {"ok": False, "error": "malformed_request"})
            return None
        if length == 0:
            return b""
        return self.rfile.read(length)

    def do_OPTIONS(self) -> None:  # noqa: N802
        origin = self._origin()
        if origin and not origin_allowed(origin):
            self._send(403, {"ok": False, "error": "forbidden"})
            return
        self._send(204, b"", "text/plain")

    def do_GET(self) -> None:  # noqa: N802
        self._dispatch("GET")

    def do_POST(self) -> None:  # noqa: N802
        self._dispatch("POST")

    def _dispatch(self, method: str) -> None:
        origin = self._origin()
        if origin and not origin_allowed(origin) and self.path != "/":
            self._send(403, {"ok": False, "error": "forbidden"})
            return

        parsed = urlparse(self.path)
        path = parsed.path.rstrip("/") or "/"

        if path == "/" and method == "GET":
            if self._reject_remote_html():
                return
            self._send(200, pairing_page(self.server.agent_token), "text/html; charset=utf-8")  # type: ignore[attr-defined]
            return

        if path == "/health":
            self._send(200, {
                "ok": True,
                "service": SERVICE_NAME,
                "version": VERSION,
                "phase": 1,
            })
            return

        if path == "/ready":
            if not self._need_auth():
                return
            self._send(200, {
                "ok": True,
                "authenticated": True,
                "service": SERVICE_NAME,
                "version": VERSION,
                "started_at": self.server.started_at,  # type: ignore[attr-defined]
            })
            return

        if path == "/capture_screen":
            if not self._need_auth():
                return
            if method not in ("GET", "POST"):
                self._send(405, {"ok": False, "error": "method_not_allowed"})
                return
            if method == "POST":
                body = self._read_body()
                if body is None:
                    return
                if body.strip() and not _is_json_object(body):
                    self._send(400, {"ok": False, "error": "malformed_request"})
                    return
            result = self.server.backend.capture_screen()  # type: ignore[attr-defined]
            # Log only metadata — never the image bytes.
            if result.get("ok"):
                log.info("capture_screen ok %sx%s", result.get("width"), result.get("height"))
            else:
                log.info("capture_screen error %s", result.get("error"))
            self._send(200 if result.get("ok") else 500, result)
            return

        if path == "/active_window":
            if not self._need_auth():
                return
            result = self.server.backend.get_active_window()  # type: ignore[attr-defined]
            log.info("get_active_window %s", "ok" if result.get("ok") else "error")
            self._send(200, result)
            return

        if path == "/screen_info":
            if not self._need_auth():
                return
            result = self.server.backend.get_screen_info()  # type: ignore[attr-defined]
            log.info("get_screen_info %s", "ok" if result.get("ok") else "error")
            self._send(200, result)
            return

        self._send(404, {"ok": False, "error": "not_found"})


def _is_json_object(body: bytes) -> bool:
    try:
        data = json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return False
    return isinstance(data, dict)


def pairing_page(token: str) -> str:
    # Token is shown only on this localhost page (no CORS for remote origins).
    safe = (
        token.replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
    )
    return f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>JARVIS Local Agent</title>
<style>
  :root {{ --bg:#03060d; --cyan:#38e8ff; --text:#dff3fa; --muted:#6f8b98; }}
  * {{ box-sizing:border-box; }}
  body {{
    margin:0; min-height:100vh; background:var(--bg); color:var(--text);
    font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
    display:flex; align-items:center; justify-content:center; padding:32px 16px;
  }}
  .card {{
    width:min(520px,100%); padding:28px 26px 24px;
    border:1px solid rgba(56,232,255,.22); border-radius:16px;
    background:rgba(8,16,28,.85);
  }}
  h1 {{ margin:0; font-weight:200; letter-spacing:.45em; font-size:22px; }}
  .ok {{ margin:10px 0 18px; color:#3dff9a; letter-spacing:.18em;
         font-size:11px; text-transform:uppercase; }}
  p {{ color:var(--muted); line-height:1.55; font-size:14px; }}
  code, .token {{
    display:block; margin:12px 0; padding:12px 12px; border-radius:8px;
    background:#071018; color:var(--cyan); word-break:break-all;
    font-size:13px; letter-spacing:.02em;
  }}
  button {{
    background:transparent; color:var(--cyan); border:1px solid rgba(56,232,255,.4);
    padding:8px 14px; border-radius:8px; letter-spacing:.16em; text-transform:uppercase;
    font-size:11px; cursor:pointer;
  }}
  .meta {{ margin-top:18px; font-size:12px; color:var(--muted); }}
</style>
</head>
<body>
  <div class="card">
    <h1>JARVIS</h1>
    <div class="ok">Local agent running</div>
    <p>This program is listening only on this computer
       (<code style="display:inline;padding:2px 6px">127.0.0.1:18765</code>).
       It is not on the public internet.</p>
    <p>Copy the token below and paste it into the JARVIS website
       under <strong style="color:var(--text)">LOCAL AGENT</strong>.</p>
    <div class="token" id="tok">{safe}</div>
    <button type="button" id="copy">Copy token</button>
    <p class="meta">Phase 1 — screen, active window, and display info only.
       No mouse, keyboard, or background recording.</p>
  </div>
  <script>
    document.getElementById('copy').onclick = async () => {{
      const t = document.getElementById('tok').textContent;
      try {{ await navigator.clipboard.writeText(t); }} catch (e) {{}}
      document.getElementById('copy').textContent = 'Copied';
    }};
  </script>
</body>
</html>
"""


def make_server(
    host: str = DEFAULT_HOST,
    port: int = DEFAULT_PORT,
    token: Optional[str] = None,
    backend: Optional[ScreenBackend] = None,
) -> AgentHTTPServer:
    host = refuse_public_bind(host)
    token = load_or_create_token(token)
    backend = backend or choose_backend()
    return AgentHTTPServer((host, int(port)), AgentHandler, token, backend)


def serve_forever_in_thread(server: AgentHTTPServer) -> threading.Thread:
    thread = threading.Thread(target=server.serve_forever, name="jarvis-agent", daemon=True)
    thread.start()
    return thread


def main() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(message)s",
        datefmt="%H:%M:%S",
    )
    host = refuse_public_bind(os.environ.get("JARVIS_AGENT_HOST", DEFAULT_HOST))
    try:
        port = int(os.environ.get("JARVIS_AGENT_PORT", str(DEFAULT_PORT)))
    except ValueError:
        raise SystemExit("JARVIS_AGENT_PORT must be an integer.")

    # Fail early if the port is already taken so the user gets a clear message.
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        sock.bind((host, port))
    except OSError:
        sock.close()
        raise SystemExit(
            "Port %s is already in use on %s. Stop the other program (or run stop.bat) and try again."
            % (port, host)
        )
    sock.close()

    server = make_server(host=host, port=port)
    url = "http://%s:%s" % (host, port)
    print()
    print("  ============================================")
    print("   JARVIS Local Agent  —  Phase 1")
    print("  ============================================")
    print("   Listening : %s" % url)
    print("   Bound to  : %s  (this computer only)" % host)
    print("   Token     : %s" % server.agent_token)
    print("  --------------------------------------------")
    print("   Open the URL above to copy the token into")
    print("   the JARVIS website (LOCAL AGENT).")
    print("   Leave this window open. Press Ctrl+C to stop.")
    print("  ============================================")
    print()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n  Stopping local agent.")
    finally:
        server.shutdown()
        server.server_close()


if __name__ == "__main__":
    main()
