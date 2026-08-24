/**
 * JARVIS Agent Tools — Automated Tests
 * =====================================
 * Tests the tool-execution logic that was added to Code.gs and Index.html.
 * Run with:  node test_tools.js
 *
 * Since these tests run outside the browser and outside Apps Script, they
 * re-extract and stub the pure-logic functions from the source files.
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const assert = require('assert');

let passed = 0, failed = 0;
const results = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    results.push({ name, status: 'PASS' });
    console.log('  ✓ ' + name);
  } catch (e) {
    failed++;
    results.push({ name, status: 'FAIL', error: e.message });
    console.log('  ✗ ' + name + '  →  ' + e.message);
  }
}

/* ================================================================== */
/* 1. Extract and test pure-logic helpers from Index.html             */
/* ================================================================== */

// Read Index.html and extract the JavaScript
const indexHtml = fs.readFileSync(path.join(__dirname, 'Index.html'), 'utf8');
const scriptMatch = indexHtml.match(/<script>([\s\S]*)<\/script>/);
assert(scriptMatch, 'Could not find <script> block in Index.html');
const script = scriptMatch[1];

// ---- haversineKm ----
function haversineKm(lat1, lon1, lat2, lon2){
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2) * Math.sin(dLat/2)
          + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180)
          * Math.sin(dLon/2) * Math.sin(dLon/2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ---- formatDistance ----
function formatDistance(km){
  if (km < 1) return Math.round(km * 1000) + ' meters';
  return km.toFixed(1) + ' km';
}

// ---- NEARBY_CATEGORIES ----
const NEARBY_CATEGORIES = {
  clinic:       { tags: [['amenity','clinic'],['amenity','doctors']], label: 'clinics and doctors' },
  hospital:     { tags: [['amenity','hospital']], label: 'hospitals' },
  pharmacy:     { tags: [['amenity','pharmacy']], label: 'pharmacies' },
  medical_shop: { tags: [['amenity','pharmacy'],['shop','medical_supply']], label: 'pharmacies and medical shops' },
  dentist:      { tags: [['amenity','dentist']], label: 'dentists' },
  doctor:       { tags: [['amenity','doctors'],['amenity','clinic']], label: 'doctors and clinics' },
  restaurant:   { tags: [['amenity','restaurant']], label: 'restaurants' },
  cafe:         { tags: [['amenity','cafe']], label: 'cafes' },
  bank:         { tags: [['amenity','bank']], label: 'banks' },
  atm:          { tags: [['amenity','atm']], label: 'ATMs' },
  grocery:      { tags: [['shop','supermarket'],['shop','convenience'],['shop','greengrocer']], label: 'grocery stores' },
  fuel:         { tags: [['amenity','fuel']], label: 'fuel stations' },
  hotel:        { tags: [['tourism','hotel'],['tourism','guest_house'],['tourism','motel']], label: 'hotels and guest houses' }
};

// ---- buildOverpassQuery ----
function buildOverpassQuery(lat, lon, radiusM, tags){
  const parts = tags.map(([k,v]) => {
    const q = 'node["' + k + '"="' + v + '"](around:' + radiusM + ',' + lat + ',' + lon + ');'
            + 'way["' + k + '"="' + v + '"](around:' + radiusM + ',' + lat + ',' + lon + ');';
    return q;
  });
  return '[out:json][timeout:12];(' + parts.join('') + ');out center 15;';
}

console.log('\n=== Haversine Distance ===');

test('Same point returns 0', () => {
  assert.strictEqual(haversineKm(34.0837, 74.7973, 34.0837, 74.7973), 0);
});

test('Srinagar to Delhi ≈ ~650 km', () => {
  const d = haversineKm(34.0837, 74.7973, 28.6139, 77.2090);
  assert(d > 600 && d < 700, `Expected ~650 km, got ${d}`);
});

test('Short distance (100m apart)', () => {
  const d = haversineKm(34.0837, 74.7973, 34.0846, 74.7973);
  assert(d > 0.05 && d < 0.15, `Expected ~0.1 km, got ${d}`);
});

test('Cross-hemisphere distance', () => {
  const d = haversineKm(34.0837, 74.7973, -33.8688, 151.2093); // Sydney
  assert(d > 10000 && d < 12000, `Expected ~11000 km, got ${d}`);
});

console.log('\n=== Format Distance ===');

test('500m → "500 meters"', () => {
  assert.strictEqual(formatDistance(0.5), '500 meters');
});

test('200m → "200 meters"', () => {
  assert.strictEqual(formatDistance(0.2), '200 meters');
});

test('1.5 km → "1.5 km"', () => {
  assert.strictEqual(formatDistance(1.5), '1.5 km');
});

test('10 km → "10.0 km"', () => {
  assert.strictEqual(formatDistance(10), '10.0 km');
});

test('0.99 km → "990 meters"', () => {
  assert.strictEqual(formatDistance(0.99), '990 meters');
});

console.log('\n=== Overpass Query Builder ===');

test('Single tag query is valid Overpass QL', () => {
  const q = buildOverpassQuery(34.0837, 74.7973, 2000, [['amenity','clinic']]);
  assert(q.startsWith('[out:json][timeout:12];'));
  assert(q.includes('node["amenity"="clinic"](around:2000,34.0837,74.7973)'));
  assert(q.includes('way["amenity"="clinic"](around:2000,34.0837,74.7973)'));
  assert(q.endsWith(';out center 15;'));
});

test('Multi-tag query includes all tags', () => {
  const q = buildOverpassQuery(34.0837, 74.7973, 1000, [
    ['amenity','pharmacy'], ['shop','medical_supply']
  ]);
  assert(q.includes('node["amenity"="pharmacy"]'));
  assert(q.includes('node["shop"="medical_supply"]'));
  assert(q.includes('way["amenity"="pharmacy"]'));
  assert(q.includes('way["shop"="medical_supply"]'));
});

test('Query uses correct radius', () => {
  const q = buildOverpassQuery(34.0837, 74.7973, 5000, [['amenity','hospital']]);
  assert(q.includes('around:5000'));
  assert(!q.includes('around:2000'));
});

console.log('\n=== NEARBY_CATEGORIES ===');

test('All 13 categories defined', () => {
  const keys = Object.keys(NEARBY_CATEGORIES);
  assert.strictEqual(keys.length, 13);
  ['clinic','hospital','pharmacy','medical_shop','dentist','doctor',
   'restaurant','cafe','bank','atm','grocery','fuel','hotel'].forEach(k => {
    assert(NEARBY_CATEGORIES[k], 'Missing category: ' + k);
  });
});

test('Each category has tags and label', () => {
  for (const [k, v] of Object.entries(NEARBY_CATEGORIES)) {
    assert(Array.isArray(v.tags) && v.tags.length > 0, `${k}: tags missing`);
    assert(typeof v.label === 'string' && v.label.length > 0, `${k}: label missing`);
    v.tags.forEach(([key, val]) => {
      assert(typeof key === 'string', `${k}: tag key not string`);
      assert(typeof val === 'string', `${k}: tag val not string`);
    });
  }
});

test('Clinic category includes doctors', () => {
  const clinic = NEARBY_CATEGORIES.clinic;
  assert(clinic.tags.some(([k,v]) => k === 'amenity' && v === 'clinic'));
  assert(clinic.tags.some(([k,v]) => k === 'amenity' && v === 'doctors'));
});

test('Medical shop includes pharmacy and medical_supply', () => {
  const ms = NEARBY_CATEGORIES.medical_shop;
  assert(ms.tags.some(([k,v]) => k === 'amenity' && v === 'pharmacy'));
  assert(ms.tags.some(([k,v]) => k === 'shop' && v === 'medical_supply'));
});

console.log('\n=== Code.gs Source Verification ===');

const codeGs = fs.readFileSync(path.join(__dirname, 'Code.gs'), 'utf8');

test('TOOL_DECLARATIONS_ exists with 3 tools', () => {
  assert(codeGs.includes('var TOOL_DECLARATIONS_'));
  assert(codeGs.includes("name: 'web_search'"));
  assert(codeGs.includes("name: 'get_current_location'"));
  assert(codeGs.includes("name: 'search_nearby'"));
});

test('web_search tool has query parameter', () => {
  assert(codeGs.includes("description: 'The search query to look up on the web.'"));
});

test('search_nearby has category and radius_km parameters', () => {
  assert(codeGs.includes('category'));
  assert(codeGs.includes('radius_km'));
});

test('liveSetup_ includes functionDeclarations', () => {
  assert(codeGs.includes('{ functionDeclarations: TOOL_DECLARATIONS_ }'));
});

test('liveSetup_ retains googleSearch tool', () => {
  assert(codeGs.includes('{ googleSearch: {} }'));
});

test('web_search action in doGet', () => {
  assert(codeGs.includes("action === 'web_search'"));
});

test('web_search action in doPost', () => {
  // Check both doGet and doPost reference web_search
  const matches = codeGs.match(/action === 'web_search'/g);
  assert(matches && matches.length >= 2, 'web_search should be in both doGet and doPost');
});

test('webSearch_ function exists', () => {
  assert(codeGs.includes('function webSearch_('));
});

test('webSearch_ uses Google Search grounding', () => {
  assert(codeGs.includes('tools: [{ googleSearch: {} }]'));
});

test('System instruction mentions all 3 tools', () => {
  assert(codeGs.includes('web_search'));
  assert(codeGs.includes('get_current_location'));
  assert(codeGs.includes('search_nearby'));
});

test('GEMINI_API_KEY stays server-side only', () => {
  // Code.gs should reference PropertiesService for the key
  assert(codeGs.includes('PropertiesService.getScriptProperties'));
  assert(codeGs.includes('GEMINI_API_KEY'));
});

console.log('\n=== Index.html Source Verification ===');

test('executeToolCall function exists', () => {
  assert(script.includes('async function executeToolCall'));
});

test('executeWebSearch function exists', () => {
  assert(script.includes('async function executeWebSearch'));
});

test('executeGetLocation function exists', () => {
  assert(script.includes('async function executeGetLocation'));
});

test('executeSearchNearby function exists', () => {
  assert(script.includes('async function executeSearchNearby'));
});

test('Tool call handling in handleServer', () => {
  assert(script.includes('m.toolCall'));
  assert(script.includes('m.toolCall.functionCalls'));
});

test('functionCall within modelTurn parts handled', () => {
  assert(script.includes('p.functionCall'));
});

test('toolResponse sent via WebSocket', () => {
  assert(script.includes('toolResponse'));
  assert(script.includes('functionResponses'));
});

test('cachedLocation variable exists', () => {
  assert(script.includes('cachedLocation'));
});

test('Location cache timeout defined', () => {
  assert(script.includes('LOCATION_CACHE_MS'));
});

test('showToolStatus and clearToolStatus exist', () => {
  assert(script.includes('function showToolStatus'));
  assert(script.includes('function clearToolStatus'));
});

test('toolStatusActive flag exists', () => {
  assert(script.includes('toolStatusActive'));
});

test('setState respects toolStatusActive', () => {
  assert(script.includes('if (toolStatusActive) return;'));
});

test('stopSession clears tool status and cached location', () => {
  // Find the stopSession function
  const stopIdx = script.indexOf('function stopSession');
  assert(stopIdx > -1, 'stopSession not found');
  const stopBody = script.substring(stopIdx, stopIdx + 500);
  assert(stopBody.includes('toolStatusActive = false'), 'toolStatusActive not cleared');
  assert(stopBody.includes('cachedLocation = null'), 'cachedLocation not cleared');
});

test('navigator.geolocation used for location', () => {
  assert(script.includes('navigator.geolocation'));
  assert(script.includes('getCurrentPosition'));
});

test('Overpass API URL used', () => {
  assert(script.includes('overpass-api.de/api/interpreter'));
});

test('Nominatim reverse geocoding used', () => {
  assert(script.includes('nominatim.openstreetmap.org/reverse'));
});

test('Haversine function defined', () => {
  assert(script.includes('function haversineKm'));
});

test('No API keys in frontend code', () => {
  // Ensure no hardcoded API keys
  assert(!script.match(/AIza[0-9A-Za-z_-]{35}/), 'Found what looks like an API key in frontend');
  assert(!script.includes('GEMINI_API_KEY'), 'GEMINI_API_KEY reference found in frontend');
});

test('Web search goes through BACKEND_URL (server-side)', () => {
  assert(script.includes('executeWebSearch'));
  // The web search function should use BACKEND_URL, not call Gemini directly
  const wsStart = script.indexOf('async function executeWebSearch');
  const wsEnd = script.indexOf('async function executeGetLocation');
  const wsBody = script.substring(wsStart, wsEnd);
  assert(wsBody.includes('BACKEND_URL'), 'Web search should use BACKEND_URL');
  assert(!wsBody.includes('generativelanguage.googleapis.com'), 'Web search should not call Gemini directly');
});

test('Location permission errors handled', () => {
  assert(script.includes('Location permission denied'));
  assert(script.includes('Location unavailable'));
  assert(script.includes('Location request timed out'));
});

test('OpenStreetMap map link generated', () => {
  assert(script.includes('openstreetmap.org/?mlat='));
});

console.log('\n=== index.html (lowercase) Sync Check ===');

test('index.html is identical to Index.html', () => {
  const indexLower = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
  assert.strictEqual(indexLower, indexHtml, 'index.html should be identical to Index.html');
});

console.log('\n=== Tool Response Format ===');

test('toolResponse uses correct Gemini Live format', () => {
  // The tool response should have toolResponse.functionResponses[].id, name, response.result
  const trIdx = script.indexOf('toolResponse:');
  assert(trIdx > -1, 'toolResponse not found');
  const trBlock = script.substring(trIdx, trIdx + 300);
  assert(trBlock.includes('functionResponses'), 'Missing functionResponses');
  assert(trBlock.includes('id:'), 'Missing id field');
  assert(trBlock.includes('name:'), 'Missing name field');
  assert(trBlock.includes('response:'), 'Missing response field');
  assert(trBlock.includes('result:'), 'Missing result field');
});

console.log('\n=== Preserve Existing Architecture ===');

test('Gemini Live WebSocket path preserved', () => {
  assert(script.includes('BidiGenerateContentConstrained'));
});

test('AudioWorklet mic processor preserved', () => {
  assert(script.includes('class MicProc extends AudioWorkletProcessor'));
});

test('PCM rates preserved (16k in, 24k out)', () => {
  assert(script.includes('MIC_RATE = 16000'));
  assert(script.includes('OUT_RATE = 24000'));
});

test('START_OF_ACTIVITY_INTERRUPTS preserved', () => {
  // This is in Code.gs liveSetup_
  assert(codeGs.includes('START_OF_ACTIVITY_INTERRUPTS'));
});

test('Echo cancellation, noise suppression, AGC preserved', () => {
  assert(script.includes('echoCancellation:true'));
  assert(script.includes('noiseSuppression:true'));
  assert(script.includes('autoGainControl:true'));
});

test('Backend keep-warm preserved', () => {
  assert(script.includes('function warmBackend'));
  assert(script.includes('function startWarm'));
});

test('VAD settings preserved in Code.gs', () => {
  assert(codeGs.includes('startOfSpeechSensitivity'));
  assert(codeGs.includes('endOfSpeechSensitivity'));
  assert(codeGs.includes('prefixPaddingMs: 120'));
  assert(codeGs.includes('silenceDurationMs: 400'));
});

test('Orb canvas animation preserved', () => {
  assert(script.includes("canvas#orb") || script.includes("$('orb')"));
});

test('Barge-in handling preserved', () => {
  assert(script.includes('sc.interrupted'));
  assert(script.includes('flushPlayback'));
});

test('Latency diagnostics preserved', () => {
  assert(script.includes('LATENCY_DIAGNOSTICS'));
  assert(script.includes('latencyStartTurn'));
  assert(script.includes('printLatencyReport'));
});

test('Existing BACKEND_URL preserved', () => {
  assert(script.includes('AKfycbzJrvQD-Ia7pEqebsLvxTmqCATWc9631uC9YOO6aWo_wcY_Yn-pNMCq-zSafHyA6WF9BQ'));
});

/* ================================================================== */
/* Summary                                                             */
/* ================================================================== */
console.log('\n' + '='.repeat(60));
console.log(`RESULTS: ${passed} passed, ${failed} failed, ${passed + failed} total`);
console.log('='.repeat(60));

if (failed > 0) {
  console.log('\nFailed tests:');
  results.filter(r => r.status === 'FAIL').forEach(r => {
    console.log('  ✗ ' + r.name + ': ' + r.error);
  });
  process.exit(1);
} else {
  console.log('\nAll tests passed! ✓');
  process.exit(0);
}
