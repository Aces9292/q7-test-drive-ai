// Q7 Training Drive: an AI product instructor that rides along and teaches sales consultants
// how to demo the 2027 Audi Q7, lesson by lesson, in sync with where the car is.
//
// How the pieces fit:
//   - Gemini Live API (WebSocket, straight from the phone's browser) does the talking and listening.
//   - The phone's GPS + an OpenStreetMap road lookup tell the app which "zone" the car is in
//     (lot, local roads, highway, I-95, Merritt Parkway, stopped, back at the store).
//   - curriculum.json is the training plan. Each lesson belongs to one or more zones.
//     The app starts the right lesson when the car reaches the right road, and tracks progress.
//   - The AI can call two functions in this app: get_drive_status (where are we, what's left)
//     and complete_lesson (mark a lesson done). That keeps the AI and the drive in sync.
// Nothing from the drive is stored on the phone. Only settings (including the API key) live in localStorage.

const WS_URL =
  'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';
const DEFAULTS = { apiKey: '', model: 'gemini-3.8-live', voice: 'Charon', echoGuard: true, captions: true, location: true, carAudio: true };
const VOICES = [
  ['Charon', 'informative'], ['Achird', 'friendly'], ['Sulafat', 'warm'], ['Puck', 'upbeat'],
  ['Kore', 'firm'], ['Orus', 'firm'], ['Aoede', 'breezy'], ['Fenrir', 'excitable'], ['Leda', 'youthful'],
  ['Zephyr', 'bright'], ['Callirrhoe', 'easy-going'], ['Autonoe', 'bright'], ['Enceladus', 'breathy'],
  ['Iapetus', 'clear'], ['Umbriel', 'easy-going'], ['Algieba', 'smooth'], ['Despina', 'smooth'],
  ['Erinome', 'clear'], ['Algenib', 'gravelly'], ['Rasalgethi', 'informative'], ['Laomedeia', 'upbeat'],
  ['Achernar', 'soft'], ['Alnilam', 'firm'], ['Schedar', 'even'], ['Gacrux', 'mature'],
  ['Pulcherrima', 'forward'], ['Zubenelgenubi', 'casual'], ['Vindemiatrix', 'gentle'],
  ['Sadachbia', 'lively'], ['Sadaltager', 'knowledgeable'],
];
const MAX_RECONNECTS = 5;

// Zones the app can detect, and how they're described to the AI and on screen.
const ZONES = {
  lot: { label: 'Lot', text: 'parked in the dealership lot' },
  local: { label: 'Local roads', text: 'on local roads' },
  stopped: { label: 'Stopped', text: 'stopped at a light or in traffic' },
  highway: { label: 'Highway', text: 'on a highway' },
  i95: { label: 'I-95', text: 'on I-95' },
  parkway: { label: 'Merritt Pkwy', text: 'on the Merritt Parkway' },
  return: { label: 'Back at store', text: 'back at the dealership' },
};
const PRIME_ZONES = new Set(['highway', 'i95', 'parkway', 'return']); // time-sensitive: these lessons can cut in
const TOOLS = [{
  functionDeclarations: [
    {
      name: 'get_drive_status',
      description:
        "Live status from the phone: the zone the car is in (lot, local, stopped, highway, i95, parkway, return), road name and type, speed, whether it's dark, the current lesson, lessons done, and lessons left for this zone. Call it whenever you need to know where the car is or what to teach next.",
    },
    {
      name: 'complete_lesson',
      description:
        'Mark a lesson finished once you have taught it and run its practice, or the group asked to skip it. The app then lines up the next lesson for the road the car is on.',
      parameters: {
        type: 'OBJECT',
        properties: { lesson_id: { type: 'STRING', description: 'Lesson id from the curriculum, for example i95-handsfree' } },
        required: ['lesson_id'],
      },
    },
  ],
}];

const $ = (id) => document.getElementById(id);
const S = {
  settings: loadSettings(),
  prompt: null,
  lessons: [],
  ws: null,
  ready: false,
  running: false,
  handle: null,
  kicked: false,
  reconnects: 0,
  ctx: null,
  micStream: null,
  micNode: null,
  micOn: true,
  nextPlay: 0,
  sources: new Set(),
  dropTurn: false,
  generating: false,
  wakeLock: null,
  startedAt: 0,
  timer: null,
  lastSpeaker: null,
  lastHeardAt: 0,
  geo: null,
  train: null,
};

// ---------- settings ----------
function loadSettings() {
  try {
    return Object.assign({}, DEFAULTS, JSON.parse(localStorage.getItem('q7ai.settings') || '{}'));
  } catch {
    return { ...DEFAULTS };
  }
}
function saveSettings() {
  try { localStorage.setItem('q7ai.settings', JSON.stringify(S.settings)); } catch { /* private mode */ }
}

function fillSettingsForm() {
  const sel = $('voice');
  if (!sel.options.length) {
    for (const [name, style] of VOICES) sel.add(new Option(`${name} (${style})`, name));
  }
  $('apiKey').value = S.settings.apiKey;
  sel.value = S.settings.voice;
  $('echoGuard').checked = S.settings.echoGuard;
  $('captionsOn').checked = S.settings.captions;
  $('locationOn').checked = S.settings.location;
  $('carAudio').checked = S.settings.carAudio;
  $('model').value = S.settings.model;
}

function openSettings() {
  fillSettingsForm();
  $('settings').showModal();
}

$('settingsForm').addEventListener('submit', (e) => {
  e.preventDefault();
  S.settings.apiKey = $('apiKey').value.trim();
  S.settings.voice = $('voice').value;
  S.settings.echoGuard = $('echoGuard').checked;
  S.settings.captions = $('captionsOn').checked;
  S.settings.location = $('locationOn').checked;
  S.settings.carAudio = $('carAudio').checked;
  S.settings.model = $('model').value.trim() || DEFAULTS.model;
  saveSettings();
  $('settings').close();
  renderIdle();
});
$('closeSettings').addEventListener('click', () => $('settings').close());
$('forgetKey').addEventListener('click', () => {
  S.settings.apiKey = '';
  $('apiKey').value = '';
  saveSettings();
  renderIdle();
});
$('showKey').addEventListener('change', (e) => { $('apiKey').type = e.target.checked ? 'text' : 'password'; });
$('openSettings').addEventListener('click', openSettings);

// ---------- UI ----------
function setStatus(word, detail = '', tone = 'idle') {
  $('statusWord').textContent = word;
  $('statusDetail').textContent = detail;
  document.body.dataset.tone = tone;
}

function renderIdle() {
  $('idleControls').hidden = false;
  $('driveControls').hidden = true;
  $('lessonCard').hidden = true;
  $('timer').textContent = '';
  if (!S.settings.apiKey) {
    setStatus('Setup needed', 'Add your Gemini API key in Settings.', 'warn');
    $('startBtn').textContent = 'Open settings';
  } else {
    setStatus('Ready', `Voice: ${S.settings.voice}. Plug the phone into the car, then tap Start.`, 'idle');
    $('startBtn').textContent = 'Start training drive';
  }
}

function renderDriving() {
  $('idleControls').hidden = true;
  $('driveControls').hidden = false;
  $('lessonCard').hidden = false;
  $('micBtn').textContent = S.micOn ? 'Mic on' : 'Mic off';
  $('micBtn').setAttribute('aria-pressed', String(!S.micOn));
  $('captions').hidden = !S.settings.captions;
  renderLesson();
}

function renderLesson() {
  const t = S.train;
  if (!t) return;
  const total = S.lessons.length;
  const done = t.done.size;
  $('lessonBar').style.width = `${total ? Math.round((done / total) * 100) : 0}%`;
  $('lessonCount').textContent = `${done} of ${total} lessons done`;
  if (t.current) {
    const zones = t.current.zones.map((z) => (ZONES[z] ? ZONES[z].label : 'Anywhere')).join(' / ');
    $('lessonMeta').textContent = `Now teaching · ${zones}`;
    $('lessonTitle').textContent = t.current.title;
  } else {
    const next = pickNextLesson();
    $('lessonMeta').textContent = next ? 'Up next' : 'All lessons for this road are done';
    $('lessonTitle').textContent = next ? next.title : 'Tap Next lesson for any remaining topic';
  }
}

function caption(speaker, text) {
  if (!S.settings.captions || !text) return;
  const box = $('captions');
  let line = box.lastElementChild;
  if (!line || S.lastSpeaker !== speaker) {
    line = document.createElement('p');
    line.className = speaker;
    line.innerHTML = `<b>${speaker === 'ai' ? 'Instructor' : 'Car'}</b> <span></span>`;
    box.appendChild(line);
    S.lastSpeaker = speaker;
    while (box.children.length > 8) box.firstElementChild.remove();
  }
  line.querySelector('span').textContent += text;
  box.scrollTop = box.scrollHeight;
}

function tick() {
  const s = Math.floor((Date.now() - S.startedAt) / 1000);
  $('timer').textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  const speaking = isSpeaking();
  document.body.classList.toggle('speaking', speaking);
  if (S.geo) {
    updateZone();
    renderWhere();
  }
  tryLesson();
  if (S.ready) {
    if (!S.micOn) setStatus('Mic off', 'The instructor can’t hear the car. Tap Mic off to turn it back on.', 'warn');
    else if (speaking) setStatus('Speaking', S.settings.echoGuard ? 'Mic paused while it talks. Tap Stop talking to cut in.' : '', 'live');
    else setStatus('Listening', '', 'live');
  }
}

// ---------- audio out ----------
function isSpeaking() {
  return !!S.ctx && S.ctx.currentTime < S.nextPlay + 0.25;
}

function playPcm(b64) {
  if (S.dropTurn) return;
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const pcm = new Int16Array(bytes.buffer, 0, bytes.length >> 1);
  const buf = S.ctx.createBuffer(1, pcm.length, 24000);
  const ch = buf.getChannelData(0);
  for (let i = 0; i < pcm.length; i++) ch[i] = pcm[i] / 32768;
  const src = S.ctx.createBufferSource();
  src.buffer = buf;
  src.connect(S.ctx.destination);
  const at = Math.max(S.ctx.currentTime + 0.05, S.nextPlay);
  src.start(at);
  S.nextPlay = at + buf.duration;
  S.sources.add(src);
  src.onended = () => S.sources.delete(src);
}

function stopPlayback() {
  for (const s of S.sources) { try { s.stop(); } catch { /* already stopped */ } }
  S.sources.clear();
  if (S.ctx) S.nextPlay = S.ctx.currentTime;
}

// ---------- audio in ----------
function toBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

async function startMic() {
  // Car audio mode: with echo cancellation on, Android switches the phone into "call" mode,
  // Android Auto treats it as a phone call, and mutes the voice we play on the media channel.
  // So in the car we turn the call-style processing off and rely on the echo guard instead.
  const car = S.settings.carAudio;
  S.micStream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: !car, noiseSuppression: !car, autoGainControl: !car },
  });
  await S.ctx.audioWorklet.addModule('mic-worklet.js');
  const src = S.ctx.createMediaStreamSource(S.micStream);
  S.micNode = new AudioWorkletNode(S.ctx, 'mic-processor');
  const mute = S.ctx.createGain();
  mute.gain.value = 0;
  src.connect(S.micNode).connect(mute).connect(S.ctx.destination);
  S.micNode.port.onmessage = (e) => {
    if (!S.ready || !S.micOn) return;
    if ((S.settings.echoGuard || S.settings.carAudio) && isSpeaking()) return; // don't let the AI hear itself through the car speakers
    send({ realtimeInput: { audio: { data: toBase64(e.data), mimeType: 'audio/pcm;rate=16000' } } });
  };
}

// ---------- Live API ----------
function send(msg) {
  if (S.ws && S.ws.readyState === WebSocket.OPEN) S.ws.send(JSON.stringify(msg));
}

function sendText(text, { cut = true } = {}) {
  if (cut) stopPlayback();
  S.dropTurn = false;
  send({ realtimeInput: { text } });
}

function setupMessage() {
  return {
    setup: {
      model: `models/${S.settings.model}`,
      generationConfig: {
        responseModalities: ['AUDIO'],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: S.settings.voice } } },
      },
      systemInstruction: { parts: [{ text: S.prompt }] },
      tools: TOOLS,
      inputAudioTranscription: {},
      outputAudioTranscription: {},
      realtimeInputConfig: {
        automaticActivityDetection: {
          startOfSpeechSensitivity: 'START_SENSITIVITY_LOW', // ignore road noise
          endOfSpeechSensitivity: 'END_SENSITIVITY_LOW', // let people pause mid-sentence
          prefixPaddingMs: 200,
          silenceDurationMs: 700,
        },
      },
      contextWindowCompression: { slidingWindow: {} }, // lets the session run past 15 minutes
      sessionResumption: S.handle ? { handle: S.handle } : {},
    },
  };
}

function connect() {
  S.ready = false;
  const ws = new WebSocket(`${WS_URL}?key=${encodeURIComponent(S.settings.apiKey)}`);
  S.ws = ws;
  ws.onopen = () => ws.send(JSON.stringify(setupMessage()));
  ws.onmessage = async (ev) => {
    if (ws !== S.ws) return;
    const text = typeof ev.data === 'string' ? ev.data : await ev.data.text();
    let msg;
    try { msg = JSON.parse(text); } catch { return; }
    onServer(msg);
  };
  ws.onclose = (ev) => onClose(ws, ev);
}

function onServer(msg) {
  if (msg.setupComplete) {
    S.ready = true;
    S.reconnects = 0;
    setStatus('Listening', '', 'live');
    if (!S.kicked) {
      S.kicked = true;
      kickoff();
    }
  }
  const sc = msg.serverContent;
  if (sc) {
    if (sc.interrupted) {
      stopPlayback();
      S.dropTurn = false;
      S.generating = false;
    }
    if (sc.modelTurn) S.generating = true;
    for (const part of sc.modelTurn?.parts || []) {
      if (part.inlineData?.data) playPcm(part.inlineData.data);
    }
    if (sc.inputTranscription?.text) {
      S.lastHeardAt = Date.now();
      caption('car', sc.inputTranscription.text);
    }
    if (sc.outputTranscription?.text && !S.dropTurn) caption('ai', sc.outputTranscription.text);
    if (sc.turnComplete) {
      S.dropTurn = false;
      S.generating = false;
    }
  }
  if (msg.toolCall) {
    const functionResponses = (msg.toolCall.functionCalls || []).map((fc) => ({
      id: fc.id,
      name: fc.name,
      response: runTool(fc.name, fc.args || {}),
    }));
    send({ toolResponse: { functionResponses } });
  }
  const ru = msg.sessionResumptionUpdate;
  if (ru && ru.resumable && ru.newHandle) S.handle = ru.newHandle;
  if (msg.goAway) reconnect('Refreshing the connection…');
}

function runTool(name, args) {
  if (name === 'get_drive_status') return { result: driveStatus() };
  if (name === 'complete_lesson') {
    const ok = completeLesson(String(args.lesson_id || ''), 'ai');
    const next = pickNextLesson();
    return {
      result: ok ? 'Marked done.' : 'No lesson with that id. Use an id from the curriculum.',
      next_lesson: next ? `${next.id}: ${next.title}` : 'none for this road yet',
      scheduling: 'SILENT',
    };
  }
  return { result: `Unknown function ${name}` };
}

// Opening line. Waits up to 3 s for a first GPS fix so the instructor knows where the car is.
function kickoff(tries = 0) {
  if (!S.running) return;
  if (S.geo && !S.geo.fixes && !S.geo.denied && tries < 12) {
    setTimeout(() => kickoff(tries + 1), 250);
    return;
  }
  const first = S.lessons.find((l) => l.zones.includes('lot')) || S.lessons[0];
  startLesson(first, `Start the training drive. ${whereLine()} Begin with lesson ${first.id}.`);
}

function reconnect(detail) {
  if (!S.running) return;
  const old = S.ws;
  S.ws = null;
  S.ready = false;
  if (old) { old.onclose = null; try { old.close(1000); } catch { /* ignore */ } }
  setStatus('Reconnecting', detail, 'warn');
  connect();
}

function onClose(ws, ev) {
  if (ws !== S.ws || !S.running) return;
  S.ready = false;
  const reason = ev.reason || '';
  if (/api key|permission|unauth|billing|quota/i.test(reason) || ev.code === 1007 || ev.code === 1008) {
    endDrive();
    setStatus('Connection refused', reason || 'Check the API key and billing in Settings.', 'stop');
    return;
  }
  if (S.reconnects >= MAX_RECONNECTS) {
    endDrive();
    setStatus('Lost connection', reason || 'Check cell signal, then tap Start again.', 'stop');
    return;
  }
  S.reconnects++;
  setStatus('Reconnecting', reason ? `Dropped: ${reason}` : 'Connection dropped.', 'warn');
  setTimeout(() => S.running && connect(), 1000 * S.reconnects);
}

// ---------- training plan ----------
function newTraining() {
  return { done: new Set(), current: null, currentAt: 0, lastDoneAt: 0 };
}

function lessonById(id) {
  return S.lessons.find((l) => l.id === id);
}

function currentZone() {
  return S.geo ? S.geo.zone : 'local';
}

// Next lesson for where the car is: lessons for this zone first (in curriculum order), then "anywhere" lessons.
function pickNextLesson(zone = currentZone()) {
  const t = S.train;
  if (!t) return null;
  const dark = S.geo ? S.geo.dark : false;
  const open = S.lessons.filter((l) => !t.done.has(l.id) && (!l.dark || dark) && (!t.current || l.id !== t.current.id));
  // Curriculum order, except back at the store: return lessons first, leftover lot lessons next, debrief last.
  const rank = (l) => (l.id === 'debrief' ? 2 : zone === 'return' && l.zones[0] === 'lot' ? 1 : 0);
  const here = open.filter((l) => l.zones.includes(zone)).sort((a, b) => rank(a) - rank(b));
  if (here.length) return here[0];
  if (zone === 'lot' || zone === 'return') return null; // don't start road lessons in the lot
  return open.find((l) => l.zones.includes('any')) || null;
}

function startLesson(lesson, lead = '') {
  const t = S.train;
  t.current = lesson;
  t.currentAt = Date.now();
  const n = S.lessons.indexOf(lesson) + 1;
  const text = `${lead ? `${lead} ` : ''}[Lesson ${lesson.id} · ${n} of ${S.lessons.length}] Teach now: ${lesson.title}. ${lead ? '' : whereLine()} Follow that lesson card. When it's done, call complete_lesson.`;
  sendText(text.replace(/\s+/g, ' ').trim());
  renderLesson();
}

function completeLesson(id, by) {
  const t = S.train;
  const lesson = lessonById(id);
  if (!t || !lesson) return false;
  t.done.add(id);
  if (t.current && t.current.id === id) t.current = null;
  t.lastDoneAt = Date.now();
  t.lastDoneBy = by;
  renderLesson();
  return true;
}

// Start the next lesson when the moment is right: nothing in progress, nobody talking, a short breather after the last one.
function tryLesson() {
  const t = S.train;
  if (!t || !S.ready || !S.running) return;
  const now = Date.now();
  if (t.current) {
    // Lesson left behind on another road for a long time: let it go and bring it back later.
    const zone = currentZone();
    if (!t.current.zones.includes(zone) && !t.current.zones.includes('any') && now - t.currentAt > 6 * 60000) {
      t.current = null;
      renderLesson();
    }
    return;
  }
  if (S.generating || isSpeaking()) return;
  if (now - S.lastHeardAt < 5000) return;
  if (now - t.lastDoneAt < (t.lastDoneBy === 'button' ? 1500 : 20000)) return;
  if (S.geo && now - S.geo.zoneSince < 6000) return; // let the zone settle
  const next = pickNextLesson();
  if (next) startLesson(next);
}

// The car just reached a road with time-sensitive lessons (I-95, the Merritt, any highway).
// If something else is mid-lesson, park it for later and switch now.
function onZoneChange(prev, zone) {
  const t = S.train;
  if (!t || !S.ready) return;
  if (!PRIME_ZONES.has(zone)) return;
  const next = pickNextLesson(zone);
  if (!next || !next.zones.includes(zone)) return;
  if (t.current && t.current.zones.includes(zone)) return;
  const wrap = t.current ? `[Drive update] We just got ${ZONES[zone].text}. Wrap up "${t.current.title}" in one sentence; we'll come back to it.` : `[Drive update] We just got ${ZONES[zone].text}.`;
  t.current = null;
  startLesson(next, wrap);
}

function driveStatus() {
  const g = S.geo;
  const t = S.train;
  const zone = currentZone();
  const dark = g ? g.dark : false;
  const left = S.lessons.filter((l) => !t.done.has(l.id) && l.zones.includes(zone) && (!l.dark || dark)).map((l) => `${l.id}: ${l.title}`);
  return {
    zone,
    where: ZONES[zone] ? ZONES[zone].text : zone,
    road: g && g.road ? g.road : 'unknown',
    road_type: g && g.roadType ? g.roadType : 'unknown',
    speed_mph: g ? Math.round(g.speedMph) : null,
    dark: g ? g.dark : null,
    gps: g ? (g.denied ? 'blocked' : g.fixes ? 'ok' : 'searching') : 'off',
    local_time: new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }),
    current_lesson: t.current ? `${t.current.id}: ${t.current.title}` : 'none',
    lessons_done: [...t.done],
    lessons_left_for_this_road: left,
    lessons_left_total: S.lessons.length - t.done.size,
  };
}

function whereLine() {
  const g = S.geo;
  const time = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (!g || !g.fixes) return `[Drive update] GPS isn't available, so ask where we are if it matters. Local time ${time}.`;
  let text = `[Drive update] The car is ${ZONES[g.zone].text}`;
  if (g.road && g.zone !== 'lot' && g.zone !== 'return') text += ` (${g.road}${g.roadType ? `, ${g.roadType}` : ''})`;
  if (g.speedMph >= 3) text += `, about ${Math.round(g.speedMph)} mph`;
  text += `. ${g.dark ? "It's dark out." : "It's daylight."} Local time ${time}.`;
  return text;
}

$('nextBtn').addEventListener('click', () => {
  if (!S.ready || !S.train) return;
  const t = S.train;
  if (t.current) completeLesson(t.current.id, 'button');
  const next = pickNextLesson() || S.lessons.find((l) => !t.done.has(l.id) && (!l.dark || (S.geo && S.geo.dark)));
  if (next) startLesson(next, 'Alex tapped Next lesson. Move on now.');
  else sendText('[Drive update] Every lesson is done. Run the debrief lesson if we have not yet.');
});
$('repeatBtn').addEventListener('click', () => {
  if (!S.ready || !S.train || !S.train.current) return;
  sendText(`[Alex tapped Repeat] Go over lesson ${S.train.current.id} again, slower and in different words. Focus on the activation steps and the customer demo.`);
});
$('practiceBtn').addEventListener('click', () => {
  if (!S.ready || !S.train) return;
  const t = S.train;
  const lesson = t.current || lessonById([...t.done].pop() || '');
  const topic = lesson ? `lesson ${lesson.id} (${lesson.title})` : 'the feature we just covered';
  sendText(`[Alex tapped Practice] Role-play now for ${topic}. You play a realistic customer and ask one question. Let the trainee give the demo, then give feedback: one thing they did well, one thing to tighten, and the line a top consultant would use.`);
});
$('debriefBtn').addEventListener('click', () => {
  if (!S.ready || !S.train) return;
  const t = S.train;
  const debrief = lessonById('debrief');
  const covered = S.lessons.filter((l) => t.done.has(l.id)).map((l) => l.title).join('; ') || 'none yet';
  const missed = S.lessons.filter((l) => !t.done.has(l.id) && l.id !== 'debrief').map((l) => l.title).join('; ') || 'none';
  if (t.current && t.current.id !== 'debrief') t.current = null;
  if (debrief) startLesson(debrief, `[Drive update] Time to debrief. Covered: ${covered}. Not covered: ${missed}.`);
});

// ---------- location: zones ----------
const MPH = 2.23694; // m/s to mph
const BASE_RADIUS_M = 350; // within this of the starting point = the dealership lot
const AWAY_M = 1500; // drove at least this far = a real drive, so coming back counts as "return"

function startLocation() {
  if (!navigator.geolocation) return;
  S.geo = {
    watchId: null, fixes: 0, last: null, base: null, maxAway: 0, speedMph: 0, slowSince: 0,
    zone: 'lot', zoneSince: Date.now(), candidate: null, candidateSince: 0,
    road: '', roadType: '', roadRef: '', roadAt: 0, roadPos: null, dark: false, denied: false,
  };
  S.geo.watchId = navigator.geolocation.watchPosition(onPosition, (err) => {
    if (S.geo && err.code === 1) S.geo.denied = true;
  }, { enableHighAccuracy: true, maximumAge: 1000, timeout: 20000 });
}

function stopLocation() {
  if (S.geo && S.geo.watchId != null) navigator.geolocation.clearWatch(S.geo.watchId);
  S.geo = null;
  $('where').textContent = '';
}

function metersBetween(a, b) {
  const R = 6371000, toRad = Math.PI / 180;
  const dLat = (b.latitude - a.latitude) * toRad, dLon = (b.longitude - a.longitude) * toRad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.latitude * toRad) * Math.cos(b.latitude * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// Sun angle (degrees above the horizon), NOAA approximation. Below -4 degrees counts as dark.
function sunElevation(date, lat, lon) {
  const rad = Math.PI / 180;
  const start = Date.UTC(date.getUTCFullYear(), 0, 0);
  const day = Math.floor((date.getTime() - start) / 86400000);
  const hours = date.getUTCHours() + date.getUTCMinutes() / 60;
  const g = (2 * Math.PI / 365) * (day - 1 + (hours - 12) / 24);
  const eqtime = 229.18 * (0.000075 + 0.001868 * Math.cos(g) - 0.032077 * Math.sin(g) - 0.014615 * Math.cos(2 * g) - 0.040849 * Math.sin(2 * g));
  const decl = 0.006918 - 0.399912 * Math.cos(g) + 0.070257 * Math.sin(g) - 0.006758 * Math.cos(2 * g) + 0.000907 * Math.sin(2 * g) - 0.002697 * Math.cos(3 * g) + 0.00148 * Math.sin(3 * g);
  const tst = hours * 60 + eqtime + 4 * lon;
  const ha = (tst / 4 - 180) * rad;
  const cosZen = Math.sin(lat * rad) * Math.sin(decl) + Math.cos(lat * rad) * Math.cos(decl) * Math.cos(ha);
  return 90 - Math.acos(Math.min(1, Math.max(-1, cosZen))) / rad;
}

function onPosition(pos) {
  const g = S.geo;
  if (!g) return;
  g.denied = false;
  const c = pos.coords;
  let mps = c.speed;
  if ((mps == null || mps < 0) && g.last) {
    const dt = (pos.timestamp - g.last.timestamp) / 1000;
    mps = dt > 0 ? metersBetween(g.last.coords, c) / dt : 0;
  }
  g.last = pos;
  g.fixes++;
  if (!g.base) g.base = { latitude: c.latitude, longitude: c.longitude };
  g.maxAway = Math.max(g.maxAway, metersBetween(g.base, c));
  g.speedMph = (mps || 0) * MPH;
  const now = Date.now();
  if (g.speedMph < 3) { if (!g.slowSince) g.slowSince = now; } else g.slowSince = 0;
  g.dark = sunElevation(new Date(), c.latitude, c.longitude) < -4;

  // Road name and type: every 20 s while moving and at least 250 m on.
  if (g.speedMph >= 5 && now - g.roadAt > 20000 && (!g.roadPos || metersBetween(g.roadPos, c) > 250)) {
    g.roadAt = now;
    g.roadPos = { latitude: c.latitude, longitude: c.longitude };
    lookupRoad(c.latitude, c.longitude);
  }
  updateZone();
}

async function lookupRoad(lat, lon) {
  try {
    const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=17&namedetails=1&lat=${lat.toFixed(4)}&lon=${lon.toFixed(4)}`;
    const r = await fetch(url, { signal: AbortSignal.timeout(6000) });
    if (!r.ok) return;
    const d = await r.json();
    if (!S.geo) return;
    const nd = d.namedetails || {};
    S.geo.road = (d.address && (d.address.road || d.address.highway)) || nd.name || d.name || '';
    S.geo.roadType = d.category === 'highway' ? d.type : '';
    S.geo.roadRef = nd.ref || '';
    updateZone();
  } catch { /* road lookup is best effort; speed still drives the zones */ }
}

function classifyZone() {
  const g = S.geo;
  if (!g.fixes) return g.zone;
  const nearBase = g.base && metersBetween(g.base, g.last.coords) < BASE_RADIUS_M;
  const slow = g.speedMph < 10;
  if (nearBase && slow) return g.maxAway > AWAY_M ? 'return' : 'lot';
  if (g.slowSince && Date.now() - g.slowSince > 8000) return 'stopped';
  if (g.speedMph < 3) return g.zone; // just slowed down: keep the current zone for now
  const name = `${g.road} ${g.roadRef}`.toLowerCase();
  const limitedAccess = g.roadType === 'motorway' || g.roadType === 'motorway_link';
  if (/merritt|\bct 15\b|route 15/.test(name)) return 'parkway';
  if (limitedAccess && /\bi[ -]?95\b|interstate 95|connecticut turnpike|lodge turnpike/.test(name)) return 'i95';
  if (limitedAccess || g.roadType === 'trunk' || g.speedMph >= 50) return 'highway';
  return 'local';
}

const ZONE_HOLD_MS = { lot: 0, return: 4000, stopped: 0, local: 8000, highway: 8000, i95: 3000, parkway: 3000 };

function updateZone() {
  const g = S.geo;
  if (!g) return;
  const z = classifyZone();
  const now = Date.now();
  if (z === g.zone) { g.candidate = null; return; }
  if (z !== g.candidate) { g.candidate = z; g.candidateSince = now; }
  if (now - g.candidateSince < (ZONE_HOLD_MS[z] || 0)) return;
  const prev = g.zone;
  g.zone = z;
  g.zoneSince = now;
  g.candidate = null;
  renderWhere();
  renderLesson();
  onZoneChange(prev, z);
}

function renderWhere() {
  const g = S.geo;
  const el = $('where');
  if (!g) { el.textContent = S.running ? 'Location off' : ''; return; }
  if (g.denied) { el.textContent = 'Location blocked. Allow it in Chrome to sync lessons to the road.'; return; }
  if (!g.fixes) { el.textContent = 'Finding GPS…'; return; }
  const bits = [ZONES[g.zone].label];
  if (g.road && g.zone !== 'lot' && g.zone !== 'return') bits.push(g.road);
  if (g.speedMph >= 3) bits.push(`${Math.round(g.speedMph)} mph`);
  if (g.dark) bits.push('Dark');
  el.textContent = bits.join(' · ');
}

// ---------- drive lifecycle ----------
async function loadTraining() {
  const get = async (f) => {
    const r = await fetch(f, { cache: 'no-cache' });
    if (!r.ok) throw new Error(`Couldn’t load ${f}.`);
    return f.endsWith('.json') ? r.json() : r.text();
  };
  const [instructor, curriculum, facts] = await Promise.all([get('instructor.txt'), get('curriculum.json'), get('car-facts.txt')]);
  S.lessons = curriculum.lessons;
  const plan = S.lessons.map((l) => {
    const where = l.zones.map((z) => (ZONES[z] ? ZONES[z].label : 'Anywhere')).join(', ');
    return `## Lesson ${l.id}: ${l.title}\nWhere: ${where}${l.dark ? ' (after dark)' : ''}\n${l.card.trim()}`;
  }).join('\n\n');
  S.prompt = `${instructor.trim()}\n\n# Curriculum (lesson cards)\n\n${plan}\n\n# Car facts\n\n${facts.trim()}\n`;
}

async function startDrive() {
  if (!S.settings.apiKey) { openSettings(); return; }
  $('startBtn').disabled = true;
  setStatus('Starting', 'Allow the microphone and location if Chrome asks.', 'warn');
  try {
    S.ctx = new AudioContext();
    await S.ctx.resume();
    if (!S.prompt) await loadTraining();
    await startMic();
  } catch (err) {
    $('startBtn').disabled = false;
    cleanupAudio();
    const denied = err && err.name === 'NotAllowedError';
    setStatus('Can’t start', denied ? 'Microphone access is blocked. Allow it in Chrome’s site settings.' : String(err.message || err), 'stop');
    return;
  }
  $('startBtn').disabled = false;
  $('captions').replaceChildren();
  S.lastSpeaker = null;
  S.running = true;
  S.kicked = false;
  S.handle = null;
  S.reconnects = 0;
  S.micOn = true;
  S.lastHeardAt = 0;
  S.train = newTraining();
  S.startedAt = Date.now();
  S.timer = setInterval(tick, 250);
  requestWakeLock();
  if (S.settings.location) startLocation();
  renderDriving();
  renderWhere();
  setStatus('Connecting', '', 'warn');
  connect();
}

function cleanupAudio() {
  stopPlayback();
  if (S.micStream) S.micStream.getTracks().forEach((t) => t.stop());
  S.micStream = null;
  S.micNode = null;
  if (S.ctx) S.ctx.close().catch(() => {});
  S.ctx = null;
  S.nextPlay = 0;
}

function endDrive() {
  S.running = false;
  S.ready = false;
  const ws = S.ws;
  S.ws = null;
  if (ws) { ws.onclose = null; try { ws.close(1000); } catch { /* ignore */ } }
  cleanupAudio();
  clearInterval(S.timer);
  stopLocation();
  S.handle = null;
  S.generating = false;
  S.dropTurn = false;
  S.train = null;
  document.body.classList.remove('speaking');
  if (S.wakeLock) { S.wakeLock.release().catch(() => {}); S.wakeLock = null; }
  $('captions').replaceChildren(); // nothing from the drive stays on the phone
  renderIdle();
}

async function requestWakeLock() {
  try { S.wakeLock = await navigator.wakeLock?.request('screen'); } catch { /* not critical */ }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && S.running) requestWakeLock();
});

$('startBtn').addEventListener('click', startDrive);
$('endBtn').addEventListener('click', endDrive);
$('micBtn').addEventListener('click', () => {
  S.micOn = !S.micOn;
  if (!S.micOn) send({ realtimeInput: { audioStreamEnd: true } });
  renderDriving();
  tick();
});
$('hushBtn').addEventListener('click', () => {
  stopPlayback();
  if (S.generating) S.dropTurn = true; // skip the rest of this answer; the mic opens right away
  tick();
});

renderIdle();
if (!S.settings.apiKey) openSettings();
