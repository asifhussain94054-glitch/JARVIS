/**
 * JARVIS — Secure backend (Google Apps Script)
 * ---------------------------------------------------------------
 * Responsibilities:
 *   1. Mint EPHEMERAL tokens for the Gemini Live API so the browser
 *      can open a realtime WebSocket WITHOUT ever seeing your real key.
 *   2. Provide a plain text fallback (/?action=chat) used only if the
 *      realtime session cannot be established.
 *   3. Never leak the API key or internal errors to the client.
 *
 * SETUP (do this once):
 *   Apps Script editor -> Project Settings -> Script Properties -> Add:
 *      Name :  GEMINI_API_KEY
 *      Value:  <your private Gemini API key>
 *   Then: Deploy -> New deployment -> Web app
 *      Execute as        : Me
 *      Who has access    : Anyone
 *   Copy the /exec URL into BACKEND_URL inside Index.html.
 *
 * FREE-TIER NOTES:
 *   - Gemini Live (native audio) preview models are free-tier limited
 *     (a few sessions/minutes per minute-window, daily token caps).
 *   - Apps Script web apps: ~20k UrlFetch calls/day on consumer accounts.
 *   - Ephemeral tokens live ~30 min and allow 1 new session by default.
 */

/** Live model used for the realtime audio session. */
var LIVE_MODEL = 'gemini-2.5-flash-native-audio-preview-09-2025';
/** Cheap text model used only by the fallback path. */
var TEXT_MODEL = 'gemini-2.5-flash';
/** Prebuilt voice for JARVIS. Options: Puck, Charon, Kore, Fenrir, Aoede, Zephyr, Orus. */
var VOICE_NAME = 'Charon';

/** The JARVIS persona. Kept server-side so it can be tuned without redeploying the site. */
var SYSTEM_INSTRUCTION = [
  'You are JARVIS, the user\'s personal AI assistant. You are speaking out loud, in real time.',
  '',
  'Voice and manner:',
  '- Intelligent, calm, confident, warm and quietly futuristic. Never bubbly, never robotic.',
  '- Speak in natural spoken English with normal contractions and natural pauses.',
  '- You may address the user as "boss", but sparingly — roughly one turn in four, and never',
  '  at the start of every reply. Never say "Certainly, boss" or "Yes, boss" repeatedly.',
  '',
  'Response style:',
  '- Be brief. One to three sentences for ordinary questions. Expand only when asked.',
  '- Never narrate your own state. Do not say "listening", "thinking", "processing", "one moment".',
  '- Never re-greet the user mid-session. Greet once at the very start only.',
  '- No markdown, no bullet points, no emoji, no stage directions — this is spoken audio.',
  '- Numbers, dates and units should be written the way a person would say them.',
  '',
  'Honesty and tools:',
  '- Use Google Search grounding whenever the question involves current events, prices,',
  '  weather, sports results or anything time-sensitive. Do not guess at live data.',
  '- If you cannot actually perform an action, say so plainly. Never claim to have opened,',
  '  sent, played or scheduled anything unless a tool actually did it.',
  '',
  'Context:',
  '- Track the conversation. Resolve "it", "that", "there" from what was just said.',
  '',
  'If the user interrupts you, stop immediately and deal with what they just said.'
].join('\n');

/* ------------------------------------------------------------------ */
/* HTTP entry points                                                   */
/* ------------------------------------------------------------------ */

function doGet(e) {
  var action = (e && e.parameter && e.parameter.action) || 'token';
  try {
    if (action === 'ping')  return json_({ ok: true, model: LIVE_MODEL });
    if (action === 'token') return json_(mintEphemeralToken_());
    if (action === 'chat')  return json_(textFallback_(e.parameter.q || '', e.parameter.history || ''));
    return json_({ ok: false, error: 'unknown_action' });
  } catch (err) {
    console.error('doGet ' + action + ': ' + err);
    return json_({ ok: false, error: friendly_(err) });
  }
}

function doPost(e) {
  var body = {};
  try { body = JSON.parse((e && e.postData && e.postData.contents) || '{}'); } catch (ignore) {}
  var action = body.action || 'token';
  try {
    if (action === 'token') return json_(mintEphemeralToken_());
    if (action === 'chat')  return json_(textFallback_(body.q || '', body.history || []));
    return json_({ ok: false, error: 'unknown_action' });
  } catch (err) {
    console.error('doPost ' + action + ': ' + err);
    return json_({ ok: false, error: friendly_(err) });
  }
}

/* ------------------------------------------------------------------ */
/* 1. Ephemeral token for Gemini Live                                  */
/* ------------------------------------------------------------------ */

function mintEphemeralToken_() {
  var key = apiKey_();
  var now = Date.now();

  // NOTE: the REST body is an AuthToken resource. The nested field is
  // `bidiGenerateContentSetup` — `liveConnectConstraints` / `httpOptions`
  // are SDK-only names and the REST API rejects them with a 400.
  var payload = {
    // Token itself stays valid for 30 minutes...
    expireTime: new Date(now + 30 * 60 * 1000).toISOString(),
    // ...but must be used to START a session within 2 minutes.
    newSessionExpireTime: new Date(now + 2 * 60 * 1000).toISOString(),
    uses: 1,
    // Locking the setup to the token means the browser cannot tamper with
    // the model, persona or voice even though it holds the token.
    bidiGenerateContentSetup: liveSetup_()
  };

  // v1alpha is the version that supports ephemeral tokens; fall back to
  // v1beta in case the preview endpoint moves.
  var out = tryMint_('v1alpha', key, payload);
  if (!out.ok && out.code === 404) out = tryMint_('v1beta', key, payload);

  if (!out.ok) {
    console.error('auth_tokens ' + out.code + ': ' + out.text);
    throw new Error('token_http_' + out.code);
  }

  var data = JSON.parse(out.text);
  if (!data.name) throw new Error('token_missing');

  return {
    ok: true,
    token: data.name,           // looks like "auth_tokens/abc..."
    model: LIVE_MODEL,
    apiVersion: out.version,
    expiresAt: data.expireTime || null
  };
}

function tryMint_(version, key, payload) {
  var res = UrlFetchApp.fetch(
    'https://generativelanguage.googleapis.com/' + version + '/auth_tokens',
    {
      method: 'post',
      contentType: 'application/json',
      headers: { 'x-goog-api-key': key },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    }
  );
  var code = res.getResponseCode();
  return { ok: code >= 200 && code < 300, code: code, text: res.getContentText(), version: version };
}

/**
 * A BidiGenerateContentSetup message — exactly what the client would otherwise
 * send as its first WebSocket frame. Note that in the raw WS/REST shape,
 * responseModalities and speechConfig live INSIDE generationConfig.
 */
function liveSetup_() {
  return {
    model: 'models/' + LIVE_MODEL,
    generationConfig: {
      responseModalities: ['AUDIO'],
      temperature: 0.85,
      speechConfig: {
        voiceConfig: { prebuiltVoiceConfig: { voiceName: VOICE_NAME } }
      }
    },
    systemInstruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
    // Server-side VAD: Gemini decides when you started and stopped talking,
    // and cancels its own audio the moment you barge in.
    realtimeInputConfig: {
      automaticActivityDetection: {
        disabled: false,
        startOfSpeechSensitivity: 'START_SENSITIVITY_HIGH',
        endOfSpeechSensitivity: 'END_SENSITIVITY_HIGH',
        prefixPaddingMs: 120,
        silenceDurationMs: 550
      },
      activityHandling: 'START_OF_ACTIVITY_INTERRUPTS'
    },
    // Live transcripts so the on-screen conversation log stays in sync.
    inputAudioTranscription: {},
    outputAudioTranscription: {},
    // Real grounding for anything time-sensitive. No fake answers.
    tools: [{ googleSearch: {} }],
    contextWindowCompression: { slidingWindow: {} }
  };
}

/* ------------------------------------------------------------------ */
/* 2. Text fallback (only used if the realtime socket fails)           */
/* ------------------------------------------------------------------ */

function textFallback_(q, history) {
  if (!q) return { ok: false, error: 'empty_prompt' };

  var contents = [];
  var hist = history;
  if (typeof hist === 'string' && hist) { try { hist = JSON.parse(hist); } catch (ignore) { hist = []; } }
  if (Object.prototype.toString.call(hist) === '[object Array]') {
    hist.slice(-12).forEach(function (m) {
      if (m && m.text) contents.push({ role: m.role === 'jarvis' ? 'model' : 'user', parts: [{ text: String(m.text) }] });
    });
  }
  contents.push({ role: 'user', parts: [{ text: String(q) }] });

  var res = UrlFetchApp.fetch(
    'https://generativelanguage.googleapis.com/v1beta/models/' + TEXT_MODEL +
    ':generateContent?key=' + encodeURIComponent(apiKey_()),
    {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify({
        contents: contents,
        systemInstruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
        generationConfig: { temperature: 0.85, maxOutputTokens: 400 }
      }),
      muteHttpExceptions: true
    }
  );

  var code = res.getResponseCode();
  if (code < 200 || code >= 300) {
    console.error('generateContent ' + code + ': ' + res.getContentText());
    throw new Error('chat_http_' + code);
  }

  var data = JSON.parse(res.getContentText());
  var parts = (((data.candidates || [])[0] || {}).content || {}).parts || [];
  var out = parts.map(function (p) { return p.text || ''; }).join('').trim();
  return { ok: true, text: out || "I didn't catch that. Say it again?" };
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function apiKey_() {
  var k = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
  if (!k) throw new Error('missing_key');
  return k;
}

/** Map internal errors to safe, user-readable messages. Never leak details. */
function friendly_(err) {
  var m = String(err && err.message ? err.message : err);
  if (m.indexOf('missing_key') > -1)   return 'JARVIS is not configured yet.';
  if (m.indexOf('_http_429') > -1)     return 'JARVIS is at its free usage limit. Try again in a minute.';
  if (m.indexOf('_http_40') > -1)      return "JARVIS couldn't authenticate with its AI service.";
  return 'JARVIS is temporarily unavailable. Please try again.';
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/** Run this once from the editor to verify your key + token minting work. */
function testToken() {
  Logger.log(JSON.stringify(mintEphemeralToken_()));
}
