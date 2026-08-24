#!/usr/bin/env python3
"""
JARVIS Local Agent — Phase 1 tests
==================================

Covers:
  - local agent starts
  - local-only binding
  - authentication
  - screen capture
  - screen dimensions
  - active window response
  - malformed requests
  - unauthorized requests
  - screenshot is not permanently stored

Run from the repo root or from local-agent/:

    python3 local-agent/tests/test_agent.py
"""

from __future__ import annotations

import json
import os
import socket
import sys
import tempfile
import time
import urllib.error
import urllib.request

DIR = os.path.dirname(os.path.abspath(__file__))
AGENT_DIR = os.path.dirname(DIR)
REPO = os.path.dirname(AGENT_DIR)
sys.path.insert(0, AGENT_DIR)

import agent as jarvis_agent  # noqa: E402


passed = 0
failed = 0
results = []


def test(name):
    def deco(fn):
        global passed, failed
        try:
            fn()
            passed += 1
            results.append((name, "PASS", None))
            print("  ✓ " + name)
        except Exception as exc:
            failed += 1
            results.append((name, "FAIL", str(exc)))
            print("  ✗ " + name + "  →  " + str(exc))
        return fn
    return deco


class AgentFixture:
    def __init__(self, backend=None, token="test-token-phase1"):
        self.token = token
        self.backend = backend or jarvis_agent.FakeBackend()
        self.server = None
        self.thread = None
        self.port = None
        self.base = None

    def start(self):
        self.server = jarvis_agent.make_server(
            host="127.0.0.1",
            port=0,
            token=self.token,
            backend=self.backend,
        )
        self.thread = jarvis_agent.serve_forever_in_thread(self.server)
        self.port = self.server.server_address[1]
        self.base = "http://127.0.0.1:%s" % self.port
        # Wait until the port accepts connections.
        deadline = time.time() + 3
        last = None
        while time.time() < deadline:
            try:
                socket.create_connection(("127.0.0.1", self.port), 0.2).close()
                return self
            except OSError as exc:
                last = exc
                time.sleep(0.02)
        raise RuntimeError("agent did not start: %s" % last)

    def stop(self):
        if self.server is not None:
            self.server.shutdown()
            self.server.server_close()
        if self.thread is not None:
            self.thread.join(2)

    def request(self, path, method="GET", token=None, body=None, headers=None, origin=None):
        data = None
        hdrs = {}
        if origin is not None:
            hdrs["Origin"] = origin
        if token is not None:
            hdrs["Authorization"] = "Bearer " + token
        if body is not None:
            if isinstance(body, (dict, list)):
                data = json.dumps(body).encode("utf-8")
                hdrs["Content-Type"] = "application/json"
            elif isinstance(body, str):
                data = body.encode("utf-8")
            else:
                data = body
        if headers:
            hdrs.update(headers)
        req = urllib.request.Request(self.base + path, data=data, headers=hdrs, method=method)
        try:
            with urllib.request.urlopen(req, timeout=5) as resp:
                raw = resp.read()
                ctype = resp.headers.get("Content-Type", "")
                parsed = json.loads(raw.decode("utf-8")) if "json" in ctype or raw[:1] in (b"{", b"[") else raw
                return resp.status, parsed, dict(resp.headers)
        except urllib.error.HTTPError as exc:
            raw = exc.read()
            try:
                parsed = json.loads(raw.decode("utf-8"))
            except Exception:
                parsed = raw
            return exc.code, parsed, dict(exc.headers)


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

print("\n=== Local agent starts ===")


@test("local agent starts and answers /health")
def _():
    fx = AgentFixture().start()
    try:
        status, body, _ = fx.request("/health")
        assert status == 200, status
        assert body["ok"] is True
        assert body["service"] == "jarvis-local-agent"
        assert body["phase"] == 1
    finally:
        fx.stop()


@test("health does not require a token")
def _():
    fx = AgentFixture().start()
    try:
        status, body, _ = fx.request("/health")
        assert status == 200
        assert "token" not in json.dumps(body).lower()
    finally:
        fx.stop()


print("\n=== Local-only binding ===")


@test("server binds to 127.0.0.1")
def _():
    fx = AgentFixture().start()
    try:
        host, port = fx.server.server_address
        assert host == "127.0.0.1", host
        assert isinstance(port, int) and port > 0
    finally:
        fx.stop()


@test("refuse_public_bind rejects 0.0.0.0")
def _():
    try:
        jarvis_agent.refuse_public_bind("0.0.0.0")
        raise AssertionError("should have refused 0.0.0.0")
    except SystemExit:
        pass
    try:
        jarvis_agent.refuse_public_bind("192.168.1.10")
        raise AssertionError("should have refused LAN bind")
    except SystemExit:
        pass
    assert jarvis_agent.refuse_public_bind("127.0.0.1") == "127.0.0.1"
    assert jarvis_agent.refuse_public_bind("localhost") == "127.0.0.1"


@test("source hard-codes local bind only")
def _():
    src = open(os.path.join(AGENT_DIR, "agent.py"), encoding="utf-8").read()
    assert 'DEFAULT_HOST = "127.0.0.1"' in src
    assert "ALLOWED_BIND_HOSTS" in src
    assert "refuse_public_bind" in src


print("\n=== Authentication ===")


@test("authorized /ready succeeds")
def _():
    fx = AgentFixture().start()
    try:
        status, body, _ = fx.request("/ready", token=fx.token)
        assert status == 200, (status, body)
        assert body["ok"] is True
        assert body["authenticated"] is True
    finally:
        fx.stop()


@test("unauthorized /ready is rejected")
def _():
    fx = AgentFixture().start()
    try:
        status, body, _ = fx.request("/ready")
        assert status == 401, status
        assert body["ok"] is False
        assert body["error"] == "unauthorized"
        status, body, _ = fx.request("/ready", token="wrong-token-value-xxx")
        assert status == 401
        assert body["error"] == "unauthorized"
    finally:
        fx.stop()


@test("unauthorized capture_screen is rejected")
def _():
    fx = AgentFixture().start()
    try:
        status, body, _ = fx.request("/capture_screen", method="POST")
        assert status == 401
        assert body["ok"] is False
        assert "permission" in body["message"].lower()
    finally:
        fx.stop()


print("\n=== Screen capture ===")


@test("capture_screen returns image and dimensions")
def _():
    fx = AgentFixture().start()
    try:
        status, body, _ = fx.request("/capture_screen", method="POST", token=fx.token)
        assert status == 200, (status, body)
        assert body["ok"] is True
        assert body["width"] == 1920
        assert body["height"] == 1080
        assert body["mime_type"] == "image/jpeg"
        assert isinstance(body["image"], str) and len(body["image"]) > 20
        assert body["timestamp"]
    finally:
        fx.stop()


@test("capture_screen GET also works")
def _():
    fx = AgentFixture().start()
    try:
        status, body, _ = fx.request("/capture_screen", token=fx.token)
        assert status == 200
        assert body["ok"] is True
        assert body["width"] > 0 and body["height"] > 0
    finally:
        fx.stop()


@test("permission failure is honest and structured")
def _():
    fx = AgentFixture(backend=jarvis_agent.FakeBackend(fail="permission")).start()
    try:
        status, body, _ = fx.request("/capture_screen", token=fx.token)
        assert body["ok"] is False
        assert body["error"] == "permission_denied"
        assert "permission" in body["message"].lower()
    finally:
        fx.stop()


@test("capture failure is honest and structured")
def _():
    fx = AgentFixture(backend=jarvis_agent.FakeBackend(fail="capture")).start()
    try:
        status, body, _ = fx.request("/capture_screen", token=fx.token)
        assert body["ok"] is False
        assert body["error"] == "capture_failed"
        assert "went wrong" in body["message"].lower()
    finally:
        fx.stop()


print("\n=== Screen dimensions ===")


@test("get_screen_info returns width, height, monitors")
def _():
    fx = AgentFixture().start()
    try:
        status, body, _ = fx.request("/screen_info", token=fx.token)
        assert status == 200, body
        assert body["ok"] is True
        assert body["width"] == 1920
        assert body["height"] == 1080
        assert body["monitor_count"] == 1
        assert body["primary"]["width"] == 1920
        assert body["primary"]["primary"] is True
        assert isinstance(body["monitors"], list) and body["monitors"]
    finally:
        fx.stop()


print("\n=== Active window ===")


@test("get_active_window returns application and title")
def _():
    fx = AgentFixture().start()
    try:
        status, body, _ = fx.request("/active_window", token=fx.token)
        assert status == 200, body
        assert body["ok"] is True
        assert body["application"] == "chrome.exe"
        assert body["title"] == "YouTube"
        assert body["timestamp"]
    finally:
        fx.stop()


print("\n=== Malformed and unknown requests ===")


@test("unknown path returns 404")
def _():
    fx = AgentFixture().start()
    try:
        status, body, _ = fx.request("/delete_files", token=fx.token)
        assert status == 404
        assert body["error"] == "not_found"
    finally:
        fx.stop()


@test("malformed JSON body is rejected")
def _():
    fx = AgentFixture().start()
    try:
        status, body, _ = fx.request(
            "/capture_screen",
            method="POST",
            token=fx.token,
            body="this is not json {{{",
            headers={"Content-Type": "application/json"},
        )
        assert status == 400, (status, body)
        assert body["error"] == "malformed_request"
    finally:
        fx.stop()


@test("oversized body is rejected")
def _():
    fx = AgentFixture().start()
    try:
        status, body, _ = fx.request(
            "/capture_screen",
            method="POST",
            token=fx.token,
            body=b"x" * (jarvis_agent.MAX_BODY_BYTES + 8),
            headers={"Content-Type": "application/json", "Content-Length": str(jarvis_agent.MAX_BODY_BYTES + 8)},
        )
        assert status == 400
        assert body["error"] == "malformed_request"
    finally:
        fx.stop()


print("\n=== Unauthorized requests ===")


@test("missing token is rejected on every privileged route")
def _():
    fx = AgentFixture().start()
    try:
        for path in ("/ready", "/capture_screen", "/active_window", "/screen_info"):
            status, body, _ = fx.request(path)
            assert status == 401, (path, status)
            assert body["ok"] is False
            assert body["error"] == "unauthorized"
    finally:
        fx.stop()


@test("remote origin cannot read the pairing page token")
def _():
    fx = AgentFixture().start()
    try:
        status, body, _ = fx.request("/", origin="https://evil.example")
        assert status == 403
    finally:
        fx.stop()


print("\n=== Screenshot is not permanently stored ===")


@test("capture does not write image files to disk")
def _():
    tmp = tempfile.mkdtemp(prefix="jarvis-agent-")
    before = set()
    for root, dirs, files in os.walk(AGENT_DIR):
        if ".venv" in root or "__pycache__" in root:
            continue
        for name in files:
            before.add(os.path.join(root, name))
    fx = AgentFixture().start()
    try:
        status, body, _ = fx.request("/capture_screen", token=fx.token)
        assert status == 200 and body["ok"] is True
        after = set()
        for root, dirs, files in os.walk(AGENT_DIR):
            if ".venv" in root or "__pycache__" in root:
                continue
            for name in files:
                after.add(os.path.join(root, name))
        created = after - before
        image_like = [
            p for p in created
            if p.lower().endswith((".png", ".jpg", ".jpeg", ".bmp", ".gif", ".webp"))
        ]
        assert image_like == [], "screenshot was written to disk: %s" % image_like
    finally:
        fx.stop()
        try:
            os.rmdir(tmp)
        except OSError:
            pass


@test("agent source never writes screenshot bytes to a file")
def _():
    src = open(os.path.join(AGENT_DIR, "agent.py"), encoding="utf-8").read()
    assert "Never writes screenshots to disk" in src or "never writes" in src.lower()
    # PowerShell fallback uses MemoryStream, not a file path.
    assert "MemoryStream" in src
    assert "BytesIO" in src
    # No obvious save-to-path of the capture.
    assert "img.save(" not in src.replace("img.save(buf", "")
    assert ".png\"" not in src and ".jpg\"" not in src


print("\n=== Privacy / Phase 1 limits ===")


@test("no GEMINI_API_KEY in the local agent")
def _():
    src = open(os.path.join(AGENT_DIR, "agent.py"), encoding="utf-8").read()
    req = open(os.path.join(AGENT_DIR, "requirements.txt"), encoding="utf-8").read()
    assert "os.environ.get(\"GEMINI_API_KEY\"" not in src
    assert "getenv(\"GEMINI_API_KEY\"" not in src
    assert "generativelanguage.googleapis.com" not in src
    assert "google-generativeai" not in req
    assert "openai" not in req.lower()
    assert "Does NOT use, store, or need GEMINI_API_KEY" in src


@test("no keylogger or input-control APIs")
def _():
    src = open(os.path.join(AGENT_DIR, "agent.py"), encoding="utf-8").read()
    forbidden = [
        "SetCursorPos", "mouse_event", "keybd_event", "SendInput",
        "pynput", "keyboard.hook", "GetAsyncKeyState",
    ]
    for item in forbidden:
        assert item not in src, item


@test("no continuous capture loop")
def _():
    src = open(os.path.join(AGENT_DIR, "agent.py"), encoding="utf-8").read()
    assert "serve_forever" in src
    assert "def capture_screen" in src
    assert "Never capture continuously" in src
    assert src.count("backend.capture_screen") == 1, src.count("backend.capture_screen")
    assert "threading.Timer" not in src


# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------

print("\n" + "=" * 60)
print("AGENT RESULTS: %s passed, %s failed, %s total" % (passed, failed, passed + failed))
print("=" * 60)

if failed:
    print("\nFailed tests:")
    for name, status, err in results:
        if status == "FAIL":
            print("  ✗ %s: %s" % (name, err))
    sys.exit(1)

print("\nAll local-agent tests passed! ✓")
sys.exit(0)
