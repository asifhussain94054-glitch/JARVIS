# JARVIS Local Agent — Phase 1

This small program runs on **your Windows computer** and gives the JARVIS website
permission to look at your screen — **only when you ask**.

```
JARVIS website  →  secure local connection  →  this agent  →  your screen
```

Phase 1 can:

- take **one** screenshot when JARVIS asks
- read the **active window** name and title
- read **screen size** / monitor information

Phase 1 cannot:

- move the mouse
- type on the keyboard
- control apps
- record the screen in the background
- see your computer from the internet

Your Gemini API key is **not** used by this agent and must never be pasted here.

---

## 1. Requirements

You need:

1. **Windows 10 or 11** (this is the computer JARVIS should see)
2. **Python 3.10 or newer** — free, from [python.org/downloads](https://www.python.org/downloads/)
3. The JARVIS website open in **Chrome or Edge**

When you install Python:

- **Check the box** that says **“Add python.exe to PATH”**
- Then click **Install Now**

You do **not** need an extra AI API key.
You do **not** need to pay for anything.

---

## 2. Installation

1. Download or clone this JARVIS repository onto your Windows PC.
2. Open the folder named `local-agent`.
3. Double-click **`start.bat`**.

The first run will:

- create a private Python environment inside `local-agent/.venv`
- install two free libraries (`mss` and `Pillow`) used for screenshots
- start the agent

This first setup can take a minute. Later starts are faster.

If a black window says *“Python was not found”*, install Python (step 1) and
run `start.bat` again.

---

## 3. How to start the local agent

**Easiest way (Windows):** double-click `local-agent/start.bat`.

**Or from a terminal:**

```bat
cd local-agent
python agent.py
```

Leave the window **open** while you talk to JARVIS.

You should see something like:

```
Listening : http://127.0.0.1:18765
Bound to  : 127.0.0.1  (this computer only)
Token     : aLongRandomString...
```

That address is only on your computer. It is not on the public internet.

---

## 4. How to stop it

- Click the agent window and press **Ctrl+C**, or
- Double-click **`stop.bat`**, or
- Simply close the window

When it is stopped, JARVIS will say the local computer agent is not connected.

---

## 5. How to connect it to JARVIS

1. Start the local agent (`start.bat`).
2. Copy the **Token** printed in the window.
   You can also open [http://127.0.0.1:18765](http://127.0.0.1:18765) in your
   browser and click **Copy token**.
3. Open the JARVIS website.
4. Click the small **LOCAL AGENT** label near the top.
5. Paste the token and click **Connect**.

The indicator should change to:

```
LOCAL AGENT  ● Connected
```

The website remembers the token on this browser, so you usually only paste it once.

**Also redeploy `Code.gs`** in Google Apps Script after this update
(Deploy → Manage deployments → pencil → Version: New version → Deploy).
The new screen tools are baked into the ephemeral token there. Without a
new deployment, JARVIS will not know it can look at your screen.

You can also add the token to the page URL once:

```
https://YOUR-PAGES-URL/?agentToken=PASTE_TOKEN_HERE
```

JARVIS will store it and you can remove it from the address bar afterwards.

---

## 6. Windows permissions required

Phase 1 only **looks**. It does not need Administrator rights.

You may see Windows ask whether Python / JARVIS can capture the screen.
Choose **Allow**.

If capture is blocked later:

1. Open **Windows Settings**
2. Go to **Privacy & security**
3. Check **Screenshot** / **Screen capture** / **Graphics capture** permissions
4. Allow **Python** (or **Windows Terminal** if you started it from there)

Run the agent as the **same Windows user** you are logged in as.
Do not install it as a background service.

---

## 7. Security model

| Rule | How it is enforced |
|---|---|
| Local only | Listens on `127.0.0.1:18765` only. Refuses `0.0.0.0`. |
| Not on the internet | Other computers cannot connect. |
| Token required | Every screen / window request needs `Authorization: Bearer <token>`. |
| Known website only | CORS allows the JARVIS GitHub Pages origin and localhost. |
| On-demand capture | A screenshot is taken only when JARVIS calls `capture_screen`. |
| No permanent storage | Screenshots stay in memory, are sent once, then discarded. |
| No keylogger | The agent never reads keystrokes. |
| No mouse / keyboard | Phase 1 has no input-control APIs. |
| No Gemini key | The agent never sees `GEMINI_API_KEY`. |

The token is saved in `local-agent/.agent-token` on your PC (this file is git-ignored).
Treat it like a password for *this computer’s screen*. Anyone who has it, and is
using a browser **on this same PC**, can ask the agent for a screenshot.

If you think the token leaked, delete `.agent-token`, restart the agent, and
paste the new token into JARVIS.

---

## 8. Troubleshooting

**The website says Offline**

- Is `start.bat` still running?
- Open [http://127.0.0.1:18765/health](http://127.0.0.1:18765/health) —
  you should see `"ok": true`.
- Use Chrome or Edge on the **same computer**.

**It says “Needs token” or permission is denied**

- Click **LOCAL AGENT**, paste the token from the agent window, click Connect.
- Tokens are case-sensitive. Copy the whole string.

**“Port 18765 is already in use”**

- Another copy of the agent is already running. Use `stop.bat`, then start again.

**Screenshot fails**

- Allow screen-capture permission for Python (section 6).
- Make sure you are not on the Windows lock screen.
- Try asking JARVIS again: *“What’s on my screen?”*

**Python was not found**

- Install Python 3 from python.org and tick **Add to PATH**.
- Close and reopen the folder, then run `start.bat` again.

**I changed computers**

- The agent must run on the computer whose screen you want JARVIS to see.

---

## 9. How to verify the agent is connected

1. Start `start.bat`. Leave it open.
2. On the JARVIS website, **LOCAL AGENT** shows **Connected** (green dot).
3. Start a voice session and try:

   - *“JARVIS, what’s my screen resolution?”*  
     → JARVIS should call `get_screen_info` and answer with real numbers.
   - *“What window am I using?”*  
     → JARVIS should name the focused app.
   - *“What’s on my screen?”*  
     → status shows **Looking at your screen…**, then JARVIS describes it.

If the agent is stopped, JARVIS should say:

> Sir, the local computer agent isn't connected.

---

## Local URL

| Item | Value |
|---|---|
| Address | `http://127.0.0.1:18765` |
| Health (no token) | `GET /health` |
| Pairing page | `GET /` (this computer only) |
| Screenshot | `POST /capture_screen` (token required) |
| Active window | `GET /active_window` (token required) |
| Screen info | `GET /screen_info` (token required) |

---

## Running the tests

From the repository root:

```bat
python local-agent/tests/test_agent.py
node test_tools.js
```

The agent tests start a temporary server on `127.0.0.1` with a fake display
backend. They do not need a real desktop session.
