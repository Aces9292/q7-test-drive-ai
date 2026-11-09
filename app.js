// Q7 Test Drive AI: a voice sales guide that talks through the car via the phone.
// Talks to the Gemini Live API directly from the browser over a WebSocket.
// Nothing about the conversation is stored on the phone; only settings (incl. API key) live in localStorage.

const WS_URL =
  'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';
const DEFAULTS = { apiKey: '', model: 'gemini-3.8-live', voice: 'Achird', echoGuard: true, captions: true };
const VOICES = [
  ['Achird', 'friendly'], ['Sulafat', 'warm'], ['Puck', 'upbeat'], ['Charon', 'informative'],
  ['Kore', 'firm'], ['Orus', 'firm'], ['Aoede', 'breezy'], ['Fenrir', 'excitable'], ['Leda', 'youthful'],
  ['Zephyr', 'bright'], ['Callirrhoe', 'easy-going'], ['Autonoe', 'bright'], ['Enceladus', 'breathy'],
  ['Iapetus', 'clear'], ['Umbriel', 'easy-going'], ['Algieba', 'smooth'], ['Despina', 'smooth'],
  ['Erinome', 'clear'], ['Algenib', 'gravelly'], ['Rasalgethi', 'informative'], ['Laomedeia', 'upbeat'],
  ['Achernar', 'soft'], ['Alnilam', 'firm'], ['Schedar', 'even'], ['Gacrux', 'mature'],
  ['Pulcherrima', 'forward'], ['Zubenelgenubi', 'casual'], ['Vindemiatrix', 'gentle'],
  ['Sadachbia', 'lively'], ['Sadaltager', 'knowledgeable'],
];
const KICKOFF = 'Start the test drive.';
const HEADING_BACK = "We're heading back to the dealership now.";
const MAX_RECONNECTS = 5;

const $ = (id) => document.getElementById(id);
const S = {
  settings: loadSettings(),
  guide: null,
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
  $('timer').textContent = '';
  if (!S.settings.apiKey) {
    setStatus('Setup needed', 'Add your Gemini API key in Settings.', 'warn');
    $('startBtn').textContent = 'Open settings';
  } else {
    setStatus('Ready', `Voice: ${S.settings.voice}. Plug the phone into the car, then tap Start.`, 'idle');
    $('startBtn').textContent = 'Start test drive';
  }
}

function renderDriving() {
  $('idleControls').hidden = true;
  $('driveControls').hidden = false;
  $('micBtn').textContent = S.micOn ? 'Mic on' : 'Mic off';
  $('micBtn').setAttribute('aria-pressed', String(!S.micOn));
  $('captions').hidden = !S.settings.captions;
}

function caption(speaker, text) {
  if (!S.settings.captions || !text) return;
  const box = $('captions');
  let line = box.lastElementChild;
  if (!line || S.lastSpeaker !== speaker) {
    line = document.createElement('p');
    line.className = speaker;
    line.innerHTML = `<b>${speaker === 'ai' ? 'AI' : 'Car'}</b> <span></span>`;
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
  if (S.ready) {
    if (!S.micOn) setStatus('Mic off', 'The AI can’t hear the car. Tap Mic off to turn it back on.', 'warn');
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
  S.micStream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  await S.ctx.audioWorklet.addModule('mic-worklet.js');
  const src = S.ctx.createMediaStreamSource(S.micStream);
  S.micNode = new AudioWorkletNode(S.ctx, 'mic-processor');
  const mute = S.ctx.createGain();
  mute.gain.value = 0;
  src.connect(S.micNode).connect(mute).connect(S.ctx.destination);
  S.micNode.port.onmessage = (e) => {
    if (!S.ready || !S.micOn) return;
    if (S.settings.echoGuard && isSpeaking()) return; // don't let the AI hear itself through the car speakers
    send({ realtimeInput: { audio: { data: toBase64(e.data), mimeType: 'audio/pcm;rate=16000' } } });
  };
}

// ---------- Live API ----------
function send(msg) {
  if (S.ws && S.ws.readyState === WebSocket.OPEN) S.ws.send(JSON.stringify(msg));
}

function sendText(text) {
  stopPlayback();
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
      systemInstruction: { parts: [{ text: S.guide }] },
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
      sendText(KICKOFF);
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
    if (sc.inputTranscription?.text) caption('car', sc.inputTranscription.text);
    if (sc.outputTranscription?.text && !S.dropTurn) caption('ai', sc.outputTranscription.text);
    if (sc.turnComplete) {
      S.dropTurn = false;
      S.generating = false;
    }
  }
  const ru = msg.sessionResumptionUpdate;
  if (ru && ru.resumable && ru.newHandle) S.handle = ru.newHandle;
  if (msg.goAway) reconnect('Refreshing the connection…');
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

// ---------- drive lifecycle ----------
async function startDrive() {
  if (!S.settings.apiKey) { openSettings(); return; }
  $('startBtn').disabled = true;
  setStatus('Starting', 'Allow the microphone if Chrome asks.', 'warn');
  try {
    S.ctx = new AudioContext();
    await S.ctx.resume();
    if (!S.guide) {
      const r = await fetch('guide.txt', { cache: 'no-cache' });
      if (!r.ok) throw new Error('Couldn’t load the sales guide (guide.txt).');
      S.guide = await r.text();
    }
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
  S.startedAt = Date.now();
  S.timer = setInterval(tick, 250);
  requestWakeLock();
  renderDriving();
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
  S.handle = null;
  S.generating = false;
  S.dropTurn = false;
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
$('backBtn').addEventListener('click', () => sendText(HEADING_BACK));

renderIdle();
if (!S.settings.apiKey) openSettings();
