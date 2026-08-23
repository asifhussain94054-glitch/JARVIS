# JARVIS — Realtime Personal AI Voice Assistant

A voice-first, futuristic AI assistant. Tap the orb control **once** and you're in a
continuous conversation — no button pressing between sentences, natural barge-in
interruptions, and native realtime audio from the Gemini Live API.

```
mic ──► 16 kHz PCM ──► Gemini Live (WebSocket, ephemeral token)
                            │
speakers ◄── streamed 24 kHz PCM ◄──┘
```

Your permanent Gemini API key **never** touches the browser. Google Apps Script mints a
short-lived ephemeral token with the model, persona and voice locked in.

---

## Files

| File | Where it goes |
|---|---|
| `Index.html` | Your GitHub Pages repo (root). The whole frontend — no build step, no dependencies. |
| `Code.gs` | A Google Apps Script project, deployed as a Web app. |

---

## Step 1 — Get a Gemini API key

1. Go to <https://aistudio.google.com/apikey> and create an API key. It's free-tier eligible.
2. Copy it. Do **not** paste it into any HTML file, ever.

## Step 2 — Deploy the backend (`Code.gs`)

1. Go to <https://script.google.com> → **New project**. Name it `JARVIS Backend`.
2. Delete everything in the editor and paste the **entire** contents of `Code.gs`. Save (Ctrl+S).
3. **Project Settings** (gear icon) → scroll to **Script Properties** → **Add script property**:
   - Name: `GEMINI_API_KEY`
   - Value: *your key from step 1*
   - **Save script properties**
4. Back in the editor, select the function `testToken` from the dropdown and click **Run**.
   Authorise when prompted ("Advanced" → "Go to JARVIS Backend (unsafe)" → Allow — it's your own script).
   The execution log should print `{"ok":true,"token":"auth_tokens/..."}`.
5. **Deploy** → **New deployment** → gear → **Web app**:
   - Description: `v1`
   - Execute as: **Me**
   - Who has access: **Anyone**
   - **Deploy**, then copy the **Web app URL** (ends in `/exec`).

> Every time you edit `Code.gs` you must **Deploy → Manage deployments → edit (pencil) →
> Version: New version → Deploy**, or the live URL keeps serving the old code.

## Step 3 — Configure the frontend

Open `Index.html` and edit **one line** near the top of the `<script>` block:

```js
const BACKEND_URL = "https://script.google.com/macros/s/AKfy..../exec";
```

## Step 4 — Publish on GitHub Pages

1. Commit `Index.html` to the repo root (GitHub Pages serves `Index.html` as the index).
2. Repo **Settings → Pages** → Source: `Deploy from a branch`, Branch: `main` / `/ (root)`.
3. Wait ~1 minute, open `https://<user>.github.io/<repo>/`.

## Step 5 — Test

- Open the page in **Chrome or Edge** (desktop or Android). HTTPS is required for the mic.
- Tap the mic control. Allow microphone access.
- JARVIS greets you briefly, then listens.
- Ask: *"What is the capital of Japan?"* → then follow up: *"How far is it from India?"*
  It should resolve "it" as Tokyo.
- While it's answering, just talk over it — it stops instantly.
- Tap the control again to end the session.

---

## What's implemented

- **One-tap continuous session** — server-side VAD decides when you start and stop talking.
- **Barge-in** — `START_OF_ACTIVITY_INTERRUPTS`; on the `interrupted` event all queued audio
  buffers are killed immediately, so there's no trailing word.
- **Native realtime audio** — Gemini's own voice (`Charon`), not `speechSynthesis`. No robotic TTS.
- **Gapless playback** — chunks are scheduled on a running AudioContext playhead, so there
  are no clicks or "tip-top" seams between packets.
- **Echo cancellation / noise suppression / AGC** on the mic, so JARVIS doesn't hear itself.
- **Live transcripts** both ways, shown in the panel (audio itself is never transcribed locally).
- **Google Search grounding** — real answers for prices, weather, news; no invented live data.
- **Conversation memory** for the whole session, with sliding-window context compression.
- **Persona** tuned to be calm and concise, using "boss" sparingly, never narrating its state.
- **Futuristic orb** that reacts to your mic level while listening and to JARVIS's actual
  output waveform while speaking, with distinct idle / thinking / error states.
- **Human error messages**; technical detail goes to the console only.

## Free-tier limits, honestly

- **Gemini Live native-audio preview** is free-tier but tightly rate-limited (a small number
  of concurrent sessions and daily tokens). Heavy use will return `429` — JARVIS will say
  *"at its free usage limit"*.
- **Sessions are capped** by Google at roughly 10–15 minutes of audio-only conversation.
  Tap the control again to start a fresh one.
- **Apps Script**: ~20,000 UrlFetch calls/day on a consumer Google account. One call per
  session start, so this is not a practical limit.
- **GitHub Pages**: free, static only — which is why the key lives in Apps Script.
- Model preview names change; if the socket closes immediately, update `LIVE_MODEL` in
  `Code.gs` to a current Live model and redeploy a **new version**.

## Roadmap (not in v1)

Tool calling (`open YouTube`, `set a reminder`), camera/vision input, long-term memory in a
Google Sheet, and calendar access. The backend already returns a locked config object, so
adding `functionDeclarations` to `liveConfig_()` is the natural next step — the client would
then handle `toolCall` messages and reply with `toolResponse`. JARVIS is instructed never to
claim it performed an action that no tool actually performed.
