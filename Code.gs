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
var LIVE_MODEL = 'gemini-2.5-flash-native-audio-preview-12-2025';
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
  'Tools:',
  '- You have three callable tools: web_search, get_current_location, and search_nearby.',
  '- web_search(query): Call this when the user explicitly asks to search the web, or when',
  '  you need real-time information that your own knowledge cannot answer reliably.',
  '  For ordinary conversation, general knowledge, or static facts, answer directly.',
  '- get_current_location(): Call this when the user asks where they are, what city or area',
  '  they are in, or when you need their location to fulfil another request.',
  '- search_nearby(category, radius_km): Call this when the user asks to find nearby places',
  '  or businesses — clinics, pharmacies, hospitals, restaurants, banks, ATMs, etc. Always',
  '  call get_current_location first if you do not yet have the user\'s coordinates.',
  '- Google Search grounding is also available for lightweight automatic grounding.',
  '',
  'Honesty:',
  '- Never claim to have searched, looked up, or found something unless a tool actually ran',
  '  and returned a result. If a tool returns an error, say so honestly.',
  '- If you cannot actually perform an action, say so plainly.',
  '',
  'Context:',
  '- Track the conversation. Resolve "it", "that", "there" from what was just said.',
  '',
  'If the user interrupts you, stop immediately and deal with what they just said.'
].join('\n');

/* ------------------------------------------------------------------ */
/* Tool declarations (baked into the ephemeral token so the model can  */
/* call them; execution happens in the browser or via the backend).   */
/* ------------------------------------------------------------------ */
var TOOL_DECLARATIONS_ = [
  {
    name: 'web_search',
    description: 'Search the web for current, real-time information. Returns factual search results sourced from the live internet. Use when the user asks to search, look something up, or when the answer requires up-to-date facts.',
    parameters: {
      type: 'OBJECT',
      properties: {
        query: {
          type: 'STRING',
          description: 'The search query to look up on the web.'
        }
      },
      required: ['query']
    }
  },
  {
    name: 'get_current_location',
    description: "Get the user's current physical location using browser geolocation. Returns the approximate address, city, and coordinates. Use when the user asks where they are, what area they are in, or when another tool needs the user's location.",
    parameters: {
      type: 'OBJECT',
      properties: {}
    }
  },
  {
    name: 'search_nearby',
    description: 'Find nearby businesses, services, or places using the user\'s current location and OpenStreetMap data. Returns real results with name, address, distance, phone, and a map link. Use when the user asks to find nearby clinics, hospitals, pharmacies, restaurants, banks, ATMs, fuel stations, hotels, or any other category.',
    parameters: {
      type: 'OBJECT',
      properties: {
        category: {
          type: 'STRING',
          description: 'The type of place to find. Examples: clinic, hospital, pharmacy, medical_shop, dentist, doctor, restaurant, cafe, bank, atm, grocery, fuel, hotel, or "any" for general nearby search.'
        },
        radius_km: {
          type: 'NUMBER',
          description: 'Search radius in kilometers. Default 2, maximum 10.'
        }
      },
      required: ['category']
    }
  }
];

/* ------------------------------------------------------------------ */
/* HTTP entry points                                                   */
/* ------------------------------------------------------------------ */

function doGet(e) {
  var action = (e && e.parameter && e.parameter.action) || 'token';
  try {
    if (action === 'ping')  return json_({ ok: true, model: LIVE_MODEL });
    if (action === 'token') return json_(mintEphemeralToken_());
    if (action === 'chat')  return json_(textFallback_(e.parameter.q || '', e.parameter.history || ''));
    if (action === 'web_search') return json_(webSearch_(e.parameter.q || ''));
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
    if (action === 'web_search') return json_(webSearch_(body.q || ''));
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
        silenceDurationMs: 400
      },
      activityHandling: 'START_OF_ACTIVITY_INTERRUPTS'
    },
    // Live transcripts so the on-screen conversation log stays in sync.
    inputAudioTranscription: {},
    outputAudioTranscription: {},
    // Real grounding for anything time-sensitive. No fake answers.
    tools: [
      { googleSearch: {} },
      { functionDeclarations: TOOL_DECLARATIONS_ }
    ],
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
/* 3. Web search (server-side, uses Gemini + Google Search grounding) */
/* ------------------------------------------------------------------ */

function webSearch_(query) {
  if (!query || !query.trim()) return { ok: false, error: 'empty_query' };

  var prompt = 'Search the web for: ' + query + '\n\n' +
    'Provide the top 5 most relevant results. For each result include:\n' +
    '- A clear title\n' +
    '- A brief 1-2 sentence summary of the key information\n' +
    '- The source name if identifiable\n\n' +
    'Be factual, concise, and write in plain text suitable for speaking aloud. ' +
    'Do not include URLs or markdown formatting.';

  var res = UrlFetchApp.fetch(
    'https://generativelanguage.googleapis.com/v1beta/models/' + TEXT_MODEL +
    ':generateContent?key=' + encodeURIComponent(apiKey_()),
    {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        tools: [{ googleSearch: {} }],
        generationConfig: { temperature: 0.3, maxOutputTokens: 1200 }
      }),
      muteHttpExceptions: true
    }
  );

  var code = res.getResponseCode();
  if (code < 200 || code >= 300) {
    console.error('webSearch ' + code + ': ' + res.getContentText());
    return { ok: false, error: 'search_http_' + code };
  }

  var data = JSON.parse(res.getContentText());
  var parts = (((data.candidates || [])[0] || {}).content || {}).parts || [];
  var text = parts.map(function (p) { return p.text || ''; }).join('').trim();

  // Extract grounding sources if available
  var groundingMeta = (((data.candidates || [])[0] || {}).groundingMetadata) || null;
  var sources = [];
  if (groundingMeta && groundingMeta.groundingChunks) {
    groundingMeta.groundingChunks.forEach(function (chunk) {
      if (chunk.web && (chunk.web.title || chunk.web.uri)) {
        sources.push({ title: chunk.web.title || '', uri: chunk.web.uri || '' });
      }
    });
  }

  return {
    ok: true,
    text: text || 'No results found for that query.',
    sources: sources
  };
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
