/* ═══════════════════════════════════════════════════════════════
   Lossless — browser music player
   ═══════════════════════════════════════════════════════════════ */

'use strict';

/* ─── Utilities ──────────────────────────────────────────────── */
const uid = () => crypto.randomUUID();
const AUDIO_EXTENSIONS = /\.(flac|m4a|mp3|ogg|wav|aac|opus|wma|aiff|aif|dsf|dsd)$/i;
const fmt = (s) => {
  if (!isFinite(s) || s < 0) return '0:00';
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, '0')}`;
};
const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/* ─── Toast ──────────────────────────────────────────────────── */
const toast = (() => {
  const container = document.getElementById('toast-container');
  return (msg, duration = 2200) => {
    const el = document.createElement('div');
    el.className = 'toast';
    el.textContent = msg;
    container.appendChild(el);
    setTimeout(() => {
      el.classList.add('out');
      el.addEventListener('animationend', () => el.remove(), { once: true });
    }, duration);
  };
})();

/* ─── IndexedDB wrapper ──────────────────────────────────────── */
class Database {
  constructor() {
    this.db = null;
  }

  open() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('lossless-v1', 2);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('files')) db.createObjectStore('files');
        if (!db.objectStoreNames.contains('arts'))  db.createObjectStore('arts');
      };
      req.onsuccess = (e) => { this.db = e.target.result; resolve(); };
      req.onerror  = (e) => reject(e.target.error);
    });
  }

  _tx(store, mode) {
    return this.db.transaction(store, mode).objectStore(store);
  }

  put(store, key, value) {
    return new Promise((resolve, reject) => {
      const req = this._tx(store, 'readwrite').put(value, key);
      req.onsuccess = () => resolve();
      req.onerror   = (e) => reject(e.target.error);
    });
  }

  get(store, key) {
    return new Promise((resolve, reject) => {
      const req = this._tx(store, 'readonly').get(key);
      req.onsuccess = (e) => resolve(e.target.result ?? null);
      req.onerror   = (e) => reject(e.target.error);
    });
  }

  del(store, key) {
    return new Promise((resolve, reject) => {
      const req = this._tx(store, 'readwrite').delete(key);
      req.onsuccess = () => resolve();
      req.onerror   = (e) => reject(e.target.error);
    });
  }

  getAllKeys(store) {
    return new Promise((resolve, reject) => {
      const req = this._tx(store, 'readonly').getAllKeys();
      req.onsuccess = (e) => resolve(e.target.result);
      req.onerror   = (e) => reject(e.target.error);
    });
  }
}

/* ─── Local-storage wrapper ──────────────────────────────────── */
const store = {
  _get: (k, def) => {
    try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : def; }
    catch { return def; }
  },
  _set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },

  getTracks:    ()  => store._get('ll_tracks', []),
  setTracks:    (v) => store._set('ll_tracks', v),
  getPlaylists: ()  => store._get('ll_playlists', []),
  setPlaylists: (v) => store._set('ll_playlists', v),
  getQueue:     ()  => store._get('ll_queue', []),
  setQueue:     (v) => store._set('ll_queue', v),
  getPlayerState: () => store._get('ll_player', { volume: 1, shuffle: false, repeat: 'none', currentId: null, currentTime: 0 }),
  setPlayerState: (v) => store._set('ll_player', v),
  getLiked:     ()  => store._get('ll_liked', []),
  setLiked:     (v) => store._set('ll_liked', v),
};

/* ─── Metadata parser (jsmediatags wrapper) ──────────────────── */
class MetadataParser {
  parse(file) {
    return new Promise((resolve) => {
      const fallback = {
        title: file.name.replace(/\.[^.]+$/, ''),
        artist: 'Unknown Artist',
        album:  'Unknown Album',
        year:   '',
        genre:  '',
        track:  '',
        lyrics: '',
        art:    null,
      };

      if (typeof window.jsmediatags === 'undefined') {
        resolve(fallback);
        return;
      }

      try {
        window.jsmediatags.read(file, {
          onSuccess: (tag) => {
            const t = tag.tags || {};
            const meta = {
              title:  t.title  || fallback.title,
              artist: t.artist || fallback.artist,
              album:  t.album  || fallback.album,
              year:   t.year   || '',
              genre:  Array.isArray(t.genre) ? t.genre[0] : (t.genre || ''),
              track:  t.track  || '',
              lyrics: '',
              art:    null,
            };

            // Lyrics — try multiple tag locations
            const ul = t.USLT;
            if (ul) {
              meta.lyrics = typeof ul === 'string' ? ul :
                            (ul.data?.lyrics ?? ul.lyrics ?? '');
            } else if (t['©lyr']) {
              meta.lyrics = t['©lyr'];
            } else if (t.lyrics) {
              meta.lyrics = typeof t.lyrics === 'string' ? t.lyrics :
                            (t.lyrics.lyrics ?? t.lyrics.data ?? '');
            } else if (t.LYRICS) {
              meta.lyrics = t.LYRICS;
            } else if (t.unsyncedlyrics) {
              meta.lyrics = t.unsyncedlyrics;
            }

            // Album art
            if (t.picture) {
              try {
                const { data, format } = t.picture;
                const bytes = new Uint8Array(data);
                meta.art = new Blob([bytes], { type: format || 'image/jpeg' });
              } catch {}
            }

            resolve(meta);
          },
          onError: () => resolve(fallback),
        });
      } catch {
        resolve(fallback);
      }
    });
  }
}

/* ─── Dominant-color extractor ───────────────────────────────── */
class ColorExtractor {
  extract(url) {
    return new Promise((resolve) => {
      const fallback = { r: 252, g: 60, b: 68 };
      if (!url) { resolve(fallback); return; }

      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        try {
          const canvas = document.createElement('canvas');
          canvas.width = canvas.height = 40;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, 40, 40);
          const data = ctx.getImageData(0, 0, 40, 40).data;

          // Accumulate in buckets of 16 to find dominant hue
          const buckets = {};
          for (let i = 0; i < data.length; i += 4) {
            const r = data[i], g = data[i+1], b = data[i+2], a = data[i+3];
            if (a < 128) continue;
            const bright = (r + g + b) / 3;
            if (bright < 20 || bright > 240) continue;
            const key = `${r >> 4},${g >> 4},${b >> 4}`;
            buckets[key] = (buckets[key] || 0) + 1;
          }
          const best = Object.entries(buckets).sort((a,b) => b[1]-a[1])[0];
          if (!best) { resolve(fallback); return; }
          const [rq, gq, bq] = best[0].split(',').map(Number);
          // Scale back from quantized
          resolve({ r: (rq << 4) + 8, g: (gq << 4) + 8, b: (bq << 4) + 8 });
        } catch { resolve(fallback); }
      };
      img.onerror = () => resolve(fallback);
      img.src = url;
    });
  }
}

/* ─── LRC parser ─────────────────────────────────────────────── */
function parseLRC(text) {
  if (!text) return null;
  const lines = text.split('\n');
  const parsed = [];
  const timeRe = /\[(\d+):(\d+(?:\.\d+)?)\]/g;
  for (const line of lines) {
    const content = line.replace(/\[\d+:\d+(?:\.\d+)?\]/g, '').trim();
    let m;
    const times = [];
    timeRe.lastIndex = 0;
    while ((m = timeRe.exec(line)) !== null) {
      times.push(parseInt(m[1]) * 60 + parseFloat(m[2]));
    }
    if (times.length && content) {
      for (const t of times) parsed.push({ t, text: content });
    }
  }
  if (parsed.length < 2) return null; // treat as plain text
  return parsed.sort((a, b) => a.t - b.t);
}

/* ─── Audio Player ───────────────────────────────────────────── */
class Player {
  constructor() {
    this.audio  = new Audio();
    this.audio.preload = 'auto';
    this.queue  = [];    // ordered track IDs for current session
    this.orig   = [];    // original (unshuffled) order
    this.idx    = -1;
    this.shuffle = false;
    this.repeat  = 'none'; // 'none' | 'all' | 'one'
    this.volume  = 1;
    this._url    = null;
    this._db     = null;  // set by App after DB is open

    // Callbacks
    this.onTrackChange = null;
    this.onPlayState   = null;
    this.onTimeUpdate  = null;
    this.onEnded       = null;

    this.audio.addEventListener('timeupdate', () => this.onTimeUpdate?.());
    this.audio.addEventListener('play',       () => this.onPlayState?.());
    this.audio.addEventListener('pause',      () => this.onPlayState?.());
    this.audio.addEventListener('ended',      () => this._handleEnded());
    this.audio.addEventListener('error',      () => { toast('Could not play this file.'); });
  }

  get playing()   { return !this.audio.paused; }
  get currentId() { return this.queue[this.idx] ?? null; }
  get time()      { return this.audio.currentTime; }
  get duration()  { return this.audio.duration || 0; }
  get pct()       { return this.duration ? this.time / this.duration : 0; }

  setVolume(v) { this.volume = v; this.audio.volume = v; }

  /* Load queue and optionally start playing */
  async setQueue(ids, startIdx = 0, db, autoPlay = true) {
    this.orig = [...ids];
    if (this.shuffle) {
      this.queue = this._shuffled([...ids], ids[startIdx]);
      this.idx = 0;
    } else {
      this.queue = [...ids];
      this.idx = clamp(startIdx, 0, ids.length - 1);
    }
    if (autoPlay) await this._load(db, true);
    store.setQueue(this.queue);
    store.setPlayerState({ ...store.getPlayerState(), currentId: this.currentId, currentTime: 0 });
  }

  addToQueue(id) {
    this.queue.push(id);
    if (this.orig.indexOf(id) === -1) this.orig.push(id);
    store.setQueue(this.queue);
  }

  removeFromQueue(qIdx) {
    if (qIdx === this.idx) return;
    this.queue.splice(qIdx, 1);
    if (qIdx < this.idx) this.idx--;
    store.setQueue(this.queue);
  }

  async play(db)  { if (!this.currentId) return; await this._load(db, true); }
  togglePlay()   { this.playing ? this.audio.pause() : this.audio.play().catch(() => {}); }

  seek(s)        { this.audio.currentTime = clamp(s, 0, this.duration); }
  seekPct(p)     { this.seek(p * this.duration); }

  async next(db) {
    if (!this.queue.length) return;
    if (this.repeat === 'one') { this.seek(0); this.audio.play(); return; }
    if (this.idx < this.queue.length - 1) {
      this.idx++;
    } else if (this.repeat === 'all') {
      this.idx = 0;
    } else { this.seek(0); this.audio.pause(); this.onTrackChange?.(); return; }
    await this._load(db, true);
    store.setPlayerState({ ...store.getPlayerState(), currentId: this.currentId });
  }

  async prev(db) {
    if (!this.queue.length) return;
    if (this.time > 3) { this.seek(0); return; }
    if (this.idx > 0) {
      this.idx--;
    } else if (this.repeat === 'all') {
      this.idx = this.queue.length - 1;
    } else { this.seek(0); return; }
    await this._load(db, true);
    store.setPlayerState({ ...store.getPlayerState(), currentId: this.currentId });
  }

  toggleShuffle() {
    this.shuffle = !this.shuffle;
    const cur = this.currentId;
    if (this.shuffle) {
      this.queue = this._shuffled([...this.orig], cur);
      this.idx = 0;
    } else {
      this.queue = [...this.orig];
      this.idx = this.queue.indexOf(cur);
      if (this.idx === -1) this.idx = 0;
    }
    store.setQueue(this.queue);
  }

  cycleRepeat() {
    const modes = ['none', 'all', 'one'];
    this.repeat = modes[(modes.indexOf(this.repeat) + 1) % modes.length];
  }

  async _load(db, autoPlay) {
    const id = this.currentId;
    if (!id) return;
    const blob = await db.get('files', id);
    if (!blob) { toast('Track file not found in storage.'); return; }
    if (this._url) URL.revokeObjectURL(this._url);
    this._url = URL.createObjectURL(blob);
    this.audio.src = this._url;
    if (autoPlay) await this.audio.play().catch(() => {});
    this.onTrackChange?.();
  }

  _handleEnded() {
    if (this.repeat === 'one') { this.seek(0); this.audio.play(); return; }
    if (this.idx < this.queue.length - 1 || this.repeat === 'all') {
      this.next(this._db);
    } else {
      this.seek(0);
      this.audio.pause();
      this.onEnded?.();
    }
  }

  _shuffled(arr, pinFirst) {
    // Fisher-Yates, keep pinFirst at front
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    if (pinFirst) {
      const pi = arr.indexOf(pinFirst);
      if (pi > 0) { arr.splice(pi, 1); arr.unshift(pinFirst); }
    }
    return arr;
  }
}

/* ─── Main Application ───────────────────────────────────────── */
class App {
  constructor() {
    this.db       = new Database();
    this.parser   = new MetadataParser();
    this.extractor= new ColorExtractor();
    this.player   = new Player();

    this.tracks   = [];   // [{id, title, artist, album, year, genre, track, lyrics, hasArt, duration, fileSize, addedAt}]
    this.playlists= [];   // [{id, name, trackIds, createdAt}]
    this.liked    = new Set();

    this.currentView     = 'library';
    this.currentPlaylist = null; // playlist id for detail view
    this.searchQuery     = '';
    this.sortBy          = 'title';

    this._artUrls = {}; // id → object URL for album art
    this._fpOpen  = false;
    this._lrcData = null;
    this._lrcHighlight = -1;
    this._seekDragging = false;

    // drag counter for whole-window drop
    this._dragCounter = 0;
  }

  /* ══ Init ══════════════════════════════════════════════════ */
  async init() {
    await this.db.open();
    this._loadState();
    this._setupPlayer();
    this._setupUI();
    this._restorePlayerState();
    this.renderLibrary();
    this.renderPlaylists();
    this.renderQueue();
  }

  _loadState() {
    this.tracks    = store.getTracks();
    this.playlists = store.getPlaylists();
    this.liked     = new Set(store.getLiked());
    const ps = store.getPlayerState();
    this.player.shuffle = ps.shuffle ?? false;
    this.player.repeat  = ps.repeat  ?? 'none';
    this.player.setVolume(ps.volume  ?? 1);
    // Restore queue
    const q = store.getQueue();
    if (q.length) {
      this.player.queue = q;
      this.player.orig  = [...q];
      const ci = q.indexOf(ps.currentId);
      this.player.idx = ci >= 0 ? ci : 0;
    }
  }

  async _restorePlayerState() {
    const ps = store.getPlayerState();
    if (!ps.currentId) return;
    const track = this.tracks.find(t => t.id === ps.currentId);
    if (!track) return;
    // Load the file silently (no autoplay on restore)
    const blob = await this.db.get('files', ps.currentId);
    if (!blob) return;
    if (this.player._url) URL.revokeObjectURL(this.player._url);
    this.player._url = URL.createObjectURL(blob);
    this.player.audio.src = this.player._url;
    this.player.audio.currentTime = ps.currentTime ?? 0;
    await this._updateNowPlayingUI(ps.currentId);
    this._showMiniPlayer();
  }

  /* ══ Player callbacks ══════════════════════════════════════ */
  _setupPlayer() {
    this.player._db          = this.db;
    this.player.onTrackChange = () => this._onTrackChange();
    this.player.onPlayState   = () => this._onPlayState();
    this.player.onTimeUpdate  = () => this._onTimeUpdate();
    this.player.onEnded       = () => this._onPlayState();
  }

  async _onTrackChange() {
    const id = this.player.currentId;
    if (!id) return;
    await this._updateNowPlayingUI(id);
    this._showMiniPlayer();
    this._onPlayState();
    store.setPlayerState({
      ...store.getPlayerState(),
      currentId: id, currentTime: 0,
      shuffle: this.player.shuffle, repeat: this.player.repeat,
    });
    this.renderQueue();
    this.renderLibrary(); // refresh active state
  }

  _onPlayState() {
    const playing = this.player.playing;
    // Mini player icons
    document.getElementById('mini-play-icon').classList.toggle('hidden', playing);
    document.getElementById('mini-pause-icon').classList.toggle('hidden', !playing);
    // Full player icons
    document.getElementById('fp-play-icon').classList.toggle('hidden', playing);
    document.getElementById('fp-pause-icon').classList.toggle('hidden', !playing);
    // Art scale
    document.getElementById('fp-art')?.classList.toggle('playing', playing);
    // Persist
    store.setPlayerState({ ...store.getPlayerState(), shuffle: this.player.shuffle, repeat: this.player.repeat, volume: this.player.volume });
  }

  _onTimeUpdate() {
    const { time, duration, pct } = this.player;
    // Mini progress
    document.getElementById('mini-progress-fill').style.width = `${pct * 100}%`;
    // Full player
    if (!this._seekDragging) {
      document.getElementById('fp-progress-fill').style.width  = `${pct * 100}%`;
      document.getElementById('fp-progress-thumb').style.left  = `${pct * 100}%`;
      document.getElementById('fp-current-time').textContent   = fmt(time);
    }
    // LRC sync
    this._syncLRC(time);
    // Persist time occasionally
    if (Math.round(time) % 5 === 0) {
      store.setPlayerState({ ...store.getPlayerState(), currentTime: time });
    }
  }

  /* ══ Now-playing UI update ════════════════════════════════ */
  async _updateNowPlayingUI(id) {
    const track = this.tracks.find(t => t.id === id);
    if (!track) return;

    // Ensure art URL
    let artUrl = null;
    if (track.hasArt) {
      if (!this._artUrls[id]) {
        const blob = await this.db.get('arts', id);
        if (blob) this._artUrls[id] = URL.createObjectURL(blob);
      }
      artUrl = this._artUrls[id] || null;
    }

    // Mini player
    document.getElementById('mini-title').textContent  = track.title;
    document.getElementById('mini-artist').textContent = track.artist;
    const miniArt = document.getElementById('mini-art');
    const miniPh  = document.getElementById('mini-art-placeholder');
    if (artUrl) {
      miniArt.src = artUrl;
      miniArt.style.display = 'block';
      miniPh.style.display  = 'none';
    } else {
      miniArt.style.display = 'none';
      miniPh.style.display  = 'flex';
    }

    // Full player
    document.getElementById('fp-title').textContent  = track.title;
    document.getElementById('fp-artist').textContent = track.artist;
    document.getElementById('fp-duration').textContent = fmt(track.duration || 0);

    const fpArt = document.getElementById('fp-art');
    const fpPh  = document.getElementById('fp-art-placeholder');
    const fpBg  = document.getElementById('fp-bg');

    if (artUrl) {
      fpArt.src = artUrl;
      fpArt.style.display = 'block';
      fpPh.style.display  = 'none';
      fpBg.style.backgroundImage = `url(${artUrl})`;
    } else {
      fpArt.style.display = 'none';
      fpPh.style.display  = 'flex';
      fpBg.style.backgroundImage = '';
    }

    // Like button
    this._updateLikeBtn(id);

    // Dynamic color
    if (artUrl) {
      const { r, g, b } = await this.extractor.extract(artUrl);
      document.documentElement.style.setProperty('--dyn-r', r);
      document.documentElement.style.setProperty('--dyn-g', g);
      document.documentElement.style.setProperty('--dyn-b', b);
    } else {
      document.documentElement.style.setProperty('--dyn-r', 252);
      document.documentElement.style.setProperty('--dyn-g', 60);
      document.documentElement.style.setProperty('--dyn-b', 68);
    }

    // Lyrics
    this._setupLyrics(track);
  }

  _updateLikeBtn(id) {
    const liked = this.liked.has(id);
    document.getElementById('fp-heart-empty').classList.toggle('hidden', liked);
    document.getElementById('fp-heart-filled').classList.toggle('hidden', !liked);
    document.getElementById('fp-like-btn').classList.toggle('liked', liked);
  }

  /* ══ Lyrics ══════════════════════════════════════════════ */
  _setupLyrics(track) {
    const content = document.getElementById('fp-lyrics-content');
    this._lrcData = null;
    this._lrcHighlight = -1;
    content.innerHTML = '';

    const raw = track.lyrics || '';
    if (!raw.trim()) {
      content.innerHTML = '<div class="lyrics-empty">No lyrics available for this song.</div>';
      return;
    }

    const lrc = parseLRC(raw);
    if (lrc) {
      this._lrcData = lrc;
      content.classList.add('has-lrc');
      lrc.forEach((line, i) => {
        const div = document.createElement('div');
        div.className = 'lrc-line';
        div.textContent = line.text;
        div.dataset.idx = i;
        div.addEventListener('click', () => this.player.seek(line.t));
        content.appendChild(div);
      });
    } else {
      content.classList.remove('has-lrc');
      content.textContent = raw;
    }
  }

  _syncLRC(time) {
    if (!this._lrcData) return;
    const lines = this._lrcData;
    let active = -1;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].t <= time) active = i; else break;
    }
    if (active === this._lrcHighlight) return;
    this._lrcHighlight = active;
    const content = document.getElementById('fp-lyrics-content');
    content.querySelectorAll('.lrc-line').forEach((el, i) => {
      el.classList.toggle('lrc-active', i === active);
    });
    if (active >= 0) {
      const el = content.querySelector(`.lrc-line[data-idx="${active}"]`);
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }

  /* ══ UI Setup ═════════════════════════════════════════════ */
  _setupUI() {
    this._setupNav();
    this._setupUpload();
    this._setupSearch();
    this._setupMiniPlayer();
    this._setupFullPlayer();
    this._setupContextMenu();
    this._setupModalOverlay();
  }

  /* ── Navigation ─────────────────────────────────────────── */
  _setupNav() {
    document.querySelectorAll('.nav-item').forEach(btn => {
      btn.addEventListener('click', () => this._switchView(btn.dataset.view));
    });
  }

  _switchView(view) {
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.querySelectorAll('.nav-item').forEach(b => {
      b.classList.toggle('active', b.dataset.view === view);
    });
    const el = document.getElementById(`view-${view}`);
    if (el) el.classList.add('active');
    this.currentView = view;
    if (view === 'queue') this.renderQueue();
    if (view === 'playlists') this.renderPlaylists();
    if (view === 'library') this.renderLibrary();
  }

  /* ── Upload ─────────────────────────────────────────────── */
  _setupUpload() {
    const zone  = document.getElementById('upload-zone');
    const input = document.getElementById('file-input');

    zone.addEventListener('click', () => input.click());
    zone.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') input.click(); });
    input.addEventListener('change', () => this._importFiles([...input.files]));

    // Sidebar drag-and-drop
    zone.addEventListener('dragover',  (e) => { e.preventDefault(); zone.classList.add('drag-active'); });
    zone.addEventListener('dragleave', ()  => zone.classList.remove('drag-active'));
    zone.addEventListener('drop',      (e) => {
      e.preventDefault();
      zone.classList.remove('drag-active');
      this._importFiles([...e.dataTransfer.files]);
    });

    // Whole-window drop zone
    const overlay = document.getElementById('drag-overlay');
    window.addEventListener('dragenter', (e) => {
      if ([...e.dataTransfer.types].includes('Files')) {
        this._dragCounter++;
        overlay.classList.remove('hidden');
      }
    });
    window.addEventListener('dragleave', (e) => {
      this._dragCounter = Math.max(0, this._dragCounter - 1);
      if (this._dragCounter === 0) overlay.classList.add('hidden');
    });
    window.addEventListener('dragover', (e) => e.preventDefault());
    window.addEventListener('drop', (e) => {
      e.preventDefault();
      this._dragCounter = 0;
      overlay.classList.add('hidden');
      this._importFiles([...e.dataTransfer.files]);
    });
  }

  async _importFiles(files) {
    const audioFiles = files.filter(f => f.type.startsWith('audio/') || AUDIO_EXTENSIONS.test(f.name));
    if (!audioFiles.length) { toast('No audio files found.'); return; }

    const overlay  = document.getElementById('upload-overlay');
    const fillEl   = document.getElementById('upload-progress-fill');
    const nameEl   = document.getElementById('upload-filename');
    const countEl  = document.getElementById('upload-count');
    overlay.classList.remove('hidden');

    let done = 0, added = 0;
    for (const file of audioFiles) {
      nameEl.textContent  = file.name;
      countEl.textContent = `${done + 1} of ${audioFiles.length}`;
      fillEl.style.width  = `${(done / audioFiles.length) * 100}%`;

      try {
        // Check for duplicate by filename + size
        const exists = this.tracks.find(t => t.filename === file.name && t.fileSize === file.size);
        if (exists) { done++; continue; }

        const [meta, duration] = await Promise.all([
          this.parser.parse(file),
          this._getAudioDuration(file),
        ]);

        const id = uid();
        // Store file blob
        await this.db.put('files', id, file);
        // Store art blob
        if (meta.art) {
          await this.db.put('arts', id, meta.art);
          this._artUrls[id] = URL.createObjectURL(meta.art);
        }

        const track = {
          id, title: meta.title, artist: meta.artist, album: meta.album,
          year: meta.year, genre: meta.genre, track: meta.track,
          lyrics: meta.lyrics,
          hasArt: !!meta.art,
          duration, filename: file.name, fileSize: file.size,
          addedAt: Date.now(),
        };
        this.tracks.push(track);
        added++;
      } catch (err) {
        console.warn('Import error', file.name, err);
      }
      done++;
      fillEl.style.width = `${(done / audioFiles.length) * 100}%`;
    }

    store.setTracks(this.tracks);
    overlay.classList.add('hidden');
    document.getElementById('file-input').value = '';

    if (added > 0) {
      toast(`Added ${added} song${added !== 1 ? 's' : ''}`);
      this.renderLibrary();
      this._updateStorageBar();
    } else {
      toast('All files already in library.');
    }
  }

  _getAudioDuration(file) {
    return new Promise((resolve) => {
      const a   = new Audio();
      const url = URL.createObjectURL(file);
      a.src = url;
      a.addEventListener('loadedmetadata', () => {
        URL.revokeObjectURL(url);
        resolve(isFinite(a.duration) ? a.duration : 0);
      });
      a.addEventListener('error', () => { URL.revokeObjectURL(url); resolve(0); });
    });
  }

  /* ── Search ─────────────────────────────────────────────── */
  _setupSearch() {
    const input = document.getElementById('search-input');
    const clear = document.getElementById('search-clear');
    const sort  = document.getElementById('sort-select');

    input.addEventListener('input', () => {
      this.searchQuery = input.value;
      clear.classList.toggle('hidden', !input.value);
      this.renderLibrary();
    });
    clear.addEventListener('click', () => {
      input.value = '';
      this.searchQuery = '';
      clear.classList.add('hidden');
      this.renderLibrary();
    });
    sort.addEventListener('change', () => {
      this.sortBy = sort.value;
      this.renderLibrary();
    });
  }

  /* ── Mini player ────────────────────────────────────────── */
  _setupMiniPlayer() {
    const trigger = document.getElementById('mini-open-trigger');
    const prev    = document.getElementById('mini-prev-btn');
    const play    = document.getElementById('mini-play-btn');
    const next    = document.getElementById('mini-next-btn');

    trigger.addEventListener('click', () => this._openFullPlayer());

    // Controls must not bubble and open full player
    const ctrl = document.getElementById('mini-controls-stop-prop');
    ctrl.addEventListener('click', (e) => e.stopPropagation());

    prev.addEventListener('click', () => this.player.prev(this.db));
    play.addEventListener('click', () => this.player.togglePlay());
    next.addEventListener('click', () => this.player.next(this.db));
  }

  _showMiniPlayer() {
    document.getElementById('mini-player').classList.remove('hidden');
  }

  /* ── Full player ────────────────────────────────────────── */
  _setupFullPlayer() {
    // Close
    document.getElementById('fp-close-btn').addEventListener('click', () => this._closeFullPlayer());

    // Play/Pause
    document.getElementById('fp-play-btn').addEventListener('click', () => this.player.togglePlay());

    // Prev / Next
    document.getElementById('fp-prev-btn').addEventListener('click', () => this.player.prev(this.db));
    document.getElementById('fp-next-btn').addEventListener('click', () => this.player.next(this.db));

    // Shuffle
    const shuffleBtn = document.getElementById('fp-shuffle-btn');
    shuffleBtn.addEventListener('click', () => {
      this.player.toggleShuffle();
      shuffleBtn.classList.toggle('active', this.player.shuffle);
      toast(this.player.shuffle ? 'Shuffle on' : 'Shuffle off');
      store.setPlayerState({ ...store.getPlayerState(), shuffle: this.player.shuffle });
      this.renderQueue();
    });
    shuffleBtn.classList.toggle('active', this.player.shuffle);

    // Repeat
    const repeatBtn = document.getElementById('fp-repeat-btn');
    repeatBtn.addEventListener('click', () => {
      this.player.cycleRepeat();
      this._updateRepeatBtn();
      store.setPlayerState({ ...store.getPlayerState(), repeat: this.player.repeat });
    });
    this._updateRepeatBtn();

    // Volume
    const vol = document.getElementById('fp-volume');
    vol.value = this.player.volume;
    vol.addEventListener('input', () => { this.player.setVolume(parseFloat(vol.value)); store.setPlayerState({ ...store.getPlayerState(), volume: this.player.volume }); });

    // Progress track — click / drag
    const pt = document.getElementById('fp-progress-track');
    const seekFromEvent = (e) => {
      const rect = pt.getBoundingClientRect();
      const x = (e.clientX ?? e.touches?.[0]?.clientX) - rect.left;
      this.player.seekPct(clamp(x / rect.width, 0, 1));
    };
    pt.addEventListener('mousedown', (e) => {
      this._seekDragging = true;
      pt.classList.add('dragging');
      seekFromEvent(e);
      const up = () => {
        this._seekDragging = false;
        pt.classList.remove('dragging');
        document.removeEventListener('mouseup', up);
        document.removeEventListener('mousemove', move);
      };
      const move = (e) => {
        if (!this._seekDragging) return;
        const r = pt.getBoundingClientRect();
        const p = clamp((e.clientX - r.left) / r.width, 0, 1);
        document.getElementById('fp-progress-fill').style.width = `${p * 100}%`;
        document.getElementById('fp-progress-thumb').style.left = `${p * 100}%`;
        document.getElementById('fp-current-time').textContent  = fmt(p * this.player.duration);
      };
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
    });
    pt.addEventListener('touchstart', (e) => { e.preventDefault(); seekFromEvent(e); }, { passive: false });
    pt.addEventListener('touchmove',  (e) => { e.preventDefault(); seekFromEvent(e); }, { passive: false });

    // Like
    document.getElementById('fp-like-btn').addEventListener('click', () => {
      const id = this.player.currentId;
      if (!id) return;
      if (this.liked.has(id)) this.liked.delete(id); else this.liked.add(id);
      store.setLiked([...this.liked]);
      this._updateLikeBtn(id);
      toast(this.liked.has(id) ? '♥ Liked' : 'Removed from liked');
    });

    // Queue toggle
    document.getElementById('fp-queue-toggle-btn').addEventListener('click', () => {
      this._switchFPPanel('queue');
    });

    // Tabs
    document.querySelectorAll('.fp-tab').forEach(tab => {
      tab.addEventListener('click', () => this._switchFPPanel(tab.dataset.panel));
    });

    // Swipe on album art stage
    this._setupArtSwipe();

    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.isContentEditable) return;
      if (e.key === ' ') { e.preventDefault(); this.player.togglePlay(); }
      if (e.key === 'ArrowRight') { e.preventDefault(); this.player.next(this.db); }
      if (e.key === 'ArrowLeft')  { e.preventDefault(); this.player.prev(this.db); }
      if (e.key === 'Escape')     { if (this._fpOpen) this._closeFullPlayer(); }
    });
  }

  _updateRepeatBtn() {
    const r  = this.player.repeat;
    const btn = document.getElementById('fp-repeat-btn');
    btn.classList.toggle('active', r !== 'none');
    document.getElementById('fp-repeat-icon-all').classList.toggle('hidden', r === 'one');
    document.getElementById('fp-repeat-icon-one').classList.toggle('hidden', r !== 'one');
    let label = 'Repeat';
    if (r === 'all') label = 'Repeat All';
    if (r === 'one') label = 'Repeat One';
    btn.setAttribute('title', label);
  }

  _switchFPPanel(panel) {
    document.querySelectorAll('.fp-tab').forEach(t => {
      t.classList.toggle('active', t.dataset.panel === panel);
    });
    document.querySelectorAll('.fp-panel').forEach(p => {
      p.classList.toggle('active', p.id === `fp-panel-${panel}`);
    });
    if (panel === 'queue') this._renderFPQueue();
  }

  _openFullPlayer() {
    const fp = document.getElementById('full-player');
    fp.classList.remove('hidden');
    // Trigger CSS transition
    requestAnimationFrame(() => fp.classList.add('open'));
    this._fpOpen = true;
    this._renderFPQueue();
  }

  _closeFullPlayer() {
    const fp = document.getElementById('full-player');
    fp.classList.remove('open');
    fp.addEventListener('transitionend', () => {
      if (!this._fpOpen) fp.classList.add('hidden');
    }, { once: true });
    this._fpOpen = false;
  }

  /* ── Swipe gesture on album art ─────────────────────────── */
  _setupArtSwipe() {
    const stage = document.getElementById('fp-art-stage');
    let sx = 0, sy = 0, dragging = false;

    stage.addEventListener('touchstart', (e) => {
      sx = e.touches[0].clientX;
      sy = e.touches[0].clientY;
      dragging = true;
    }, { passive: true });

    stage.addEventListener('touchmove', (e) => {
      if (!dragging) return;
      const dx = e.touches[0].clientX - sx;
      const dy = e.touches[0].clientY - sy;
      // Pan art slightly
      const art = document.getElementById('fp-art');
      if (Math.abs(dx) > Math.abs(dy)) {
        art.style.transform = `scale(1.04) translateX(${dx * 0.2}px)`;
      }
    }, { passive: true });

    stage.addEventListener('touchend', (e) => {
      if (!dragging) return;
      dragging = false;
      const dx = e.changedTouches[0].clientX - sx;
      const dy = e.changedTouches[0].clientY - sy;
      const art = document.getElementById('fp-art');
      art.style.transform = '';

      if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 55) {
        if (dx < 0) this.player.next(this.db);
        else         this.player.prev(this.db);
      } else if (dy > 80 && Math.abs(dy) > Math.abs(dx)) {
        this._closeFullPlayer();
      }
    }, { passive: true });

    // Mouse swipe fallback (desktop)
    let msx = 0, msy = 0, mdown = false;
    stage.addEventListener('mousedown', (e) => { msx = e.clientX; msy = e.clientY; mdown = true; });
    document.addEventListener('mouseup', (e) => {
      if (!mdown) return;
      mdown = false;
      const dx = e.clientX - msx;
      const dy = e.clientY - msy;
      const art = document.getElementById('fp-art');
      art.style.transform = '';
      if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 55) {
        if (dx < 0) this.player.next(this.db);
        else         this.player.prev(this.db);
      }
    });
    document.addEventListener('mousemove', (e) => {
      if (!mdown) return;
      const dx = e.clientX - msx;
      const dy = e.clientY - msy;
      if (Math.abs(dx) > Math.abs(dy)) {
        const art = document.getElementById('fp-art');
        art.style.transform = `scale(1.04) translateX(${dx * 0.2}px)`;
      }
    });
  }

  /* ── Context menu ───────────────────────────────────────── */
  _setupContextMenu() {
    document.addEventListener('click', () => this._closeContextMenu());
    document.addEventListener('contextmenu', (e) => {
      // Only suppress if our own handler will open it
    });
  }

  _openContextMenu(x, y, items) {
    const menu = document.getElementById('context-menu');
    const itemsEl = document.getElementById('context-menu-items');
    itemsEl.innerHTML = '';
    items.forEach(item => {
      if (item === 'sep') {
        const div = document.createElement('div');
        div.className = 'ctx-separator';
        itemsEl.appendChild(div);
        return;
      }
      if (item.label && !item.action) {
        const div = document.createElement('div');
        div.className = 'ctx-label';
        div.textContent = item.label;
        itemsEl.appendChild(div);
        return;
      }
      const btn = document.createElement('button');
      btn.className = `ctx-item${item.danger ? ' danger' : ''}`;
      btn.innerHTML = (item.icon || '') + `<span>${item.text}</span>`;
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        this._closeContextMenu();
        item.action?.();
      });
      itemsEl.appendChild(btn);
    });

    menu.classList.remove('hidden');
    // Position
    const rect = menu.getBoundingClientRect();
    const vw = window.innerWidth, vh = window.innerHeight;
    let left = x, top = y;
    // After render, check bounds
    requestAnimationFrame(() => {
      const mr = menu.getBoundingClientRect();
      if (left + mr.width > vw - 8)  left = vw - mr.width - 8;
      if (top  + mr.height > vh - 8) top  = vh - mr.height - 8;
      menu.style.left = `${left}px`;
      menu.style.top  = `${top}px`;
    });
    menu.style.left = `${x}px`;
    menu.style.top  = `${y}px`;
  }

  _closeContextMenu() {
    document.getElementById('context-menu').classList.add('hidden');
  }

  /* ── Modal ──────────────────────────────────────────────── */
  _setupModalOverlay() {
    document.getElementById('modal-overlay').addEventListener('click', (e) => {
      if (e.target.id === 'modal-overlay') this._closeModal();
    });
  }

  _openModal(html) {
    document.getElementById('modal-body').innerHTML = html;
    document.getElementById('modal-overlay').classList.remove('hidden');
  }

  _closeModal() {
    document.getElementById('modal-overlay').classList.add('hidden');
  }

  /* ══ Library rendering ════════════════════════════════════ */
  renderLibrary() {
    const list  = document.getElementById('track-list');
    const empty = document.getElementById('library-empty');
    let tracks  = [...this.tracks];

    if (this.searchQuery) {
      const q = this.searchQuery.toLowerCase();
      tracks = tracks.filter(t =>
        t.title.toLowerCase().includes(q)  ||
        t.artist.toLowerCase().includes(q) ||
        t.album.toLowerCase().includes(q)
      );
    }

    // Sort
    tracks.sort((a, b) => {
      switch (this.sortBy) {
        case 'artist':   return a.artist.localeCompare(b.artist) || a.title.localeCompare(b.title);
        case 'album':    return a.album.localeCompare(b.album) || (parseInt(a.track)||0) - (parseInt(b.track)||0);
        case 'added':    return b.addedAt - a.addedAt;
        case 'duration': return a.duration - b.duration;
        default:         return a.title.localeCompare(b.title);
      }
    });

    empty.classList.toggle('hidden', tracks.length > 0);
    list.innerHTML = '';
    tracks.forEach((track, i) => {
      list.appendChild(this._makeTrackRow(track, i + 1, tracks, i));
    });
  }

  _makeTrackRow(track, num, contextTracks, contextIdx, opts = {}) {
    const active  = track.id === this.player.currentId;
    const row     = document.createElement('div');
    row.className = `track-row${active ? ' active' : ''}`;
    row.setAttribute('role', 'listitem');

    // Art URL (may be undefined if not loaded yet)
    const artUrl  = this._artUrls[track.id] || '';

    row.innerHTML = `
      <div class="track-num">
        <span class="track-num-label">${opts.hideNum ? '' : num}</span>
        <div class="track-playing-indicator">
          <div class="playing-bars"><span></span><span></span><span></span></div>
        </div>
      </div>
      <div class="track-main">
        <div class="track-art-wrap">
          <img class="track-art-img" src="${artUrl}" alt="" loading="lazy" style="${artUrl ? '' : 'display:none'}">
          <div class="track-art-placeholder" style="${artUrl ? 'display:none' : ''}">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M9 18V5l12-2v13" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><circle cx="6" cy="18" r="3" stroke="currentColor" stroke-width="1.8"/><circle cx="18" cy="16" r="3" stroke="currentColor" stroke-width="1.8"/></svg>
          </div>
        </div>
        <div class="track-text">
          <div class="track-title">${this._esc(track.title)}</div>
          <div class="track-artist">${this._esc(track.artist)}</div>
        </div>
      </div>
      <div class="track-album">${this._esc(track.album)}</div>
      <div class="track-duration">${fmt(track.duration)}</div>
      ${opts.showRemove ? `<div class="track-row-actions"><button class="track-action-btn" data-remove="1" title="Remove from playlist">✕</button></div>` : `<div class="track-row-actions"><button class="track-action-btn" data-more="1" title="More options">···</button></div>`}
    `;

    // Play on click
    row.addEventListener('click', async (e) => {
      if (e.target.closest('[data-more]') || e.target.closest('[data-remove]')) return;
      const ids = contextTracks.map(t => t.id);
      await this.player.setQueue(ids, contextIdx, this.db, true);
    });

    // More options
    const moreBtn = row.querySelector('[data-more]');
    if (moreBtn) moreBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this._showTrackMenu(e.clientX, e.clientY, track, contextTracks, contextIdx);
    });

    // Remove from playlist
    const removeBtn = row.querySelector('[data-remove]');
    if (removeBtn) removeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      opts.onRemove?.(track.id);
    });

    // Load art async if not yet cached
    if (track.hasArt && !this._artUrls[track.id]) {
      this.db.get('arts', track.id).then(blob => {
        if (blob) {
          this._artUrls[track.id] = URL.createObjectURL(blob);
          const img = row.querySelector('.track-art-img');
          const ph  = row.querySelector('.track-art-placeholder');
          if (img) { img.src = this._artUrls[track.id]; img.style.display = 'block'; }
          if (ph)  ph.style.display = 'none';
        }
      });
    }

    // Right-click
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      this._showTrackMenu(e.clientX, e.clientY, track, contextTracks, contextIdx);
    });

    return row;
  }

  _showTrackMenu(x, y, track, contextTracks, contextIdx) {
    const playlists = this.playlists;
    const inQueue   = this.player.queue.includes(track.id);
    const items = [
      { text: 'Play Next', icon: this._svgIcon('next'), action: () => {
          const afterIdx = this.player.idx + 1;
          this.player.queue.splice(afterIdx, 0, track.id);
          store.setQueue(this.player.queue);
          this.renderQueue();
          toast('Playing next');
        }
      },
      { text: 'Add to Queue', icon: this._svgIcon('queue'), action: () => {
          this.player.addToQueue(track.id);
          toast('Added to queue');
          this.renderQueue();
        }
      },
      'sep',
    ];

    if (playlists.length) {
      items.push({ label: 'Add to Playlist' });
      playlists.forEach(pl => {
        items.push({ text: pl.name, action: () => {
            if (!pl.trackIds.includes(track.id)) {
              pl.trackIds.push(track.id);
              store.setPlaylists(this.playlists);
              toast(`Added to "${pl.name}"`);
            } else {
              toast(`Already in "${pl.name}"`);
            }
          }
        });
      });
      items.push('sep');
    }

    items.push({ text: 'Delete from Library', danger: true, icon: this._svgIcon('trash'), action: () => this._deleteTrack(track.id) });

    this._openContextMenu(x, y, items);
  }

  async _deleteTrack(id) {
    if (!confirm('Remove this song from your library?')) return;
    this.tracks = this.tracks.filter(t => t.id !== id);
    store.setTracks(this.tracks);
    // Remove from playlists
    this.playlists.forEach(pl => {
      pl.trackIds = pl.trackIds.filter(tid => tid !== id);
    });
    store.setPlaylists(this.playlists);
    // Remove from queue
    this.player.queue = this.player.queue.filter(tid => tid !== id);
    this.player.orig  = this.player.orig.filter(tid => tid !== id);
    store.setQueue(this.player.queue);
    // Remove from DB
    await this.db.del('files', id);
    await this.db.del('arts',  id);
    if (this._artUrls[id]) { URL.revokeObjectURL(this._artUrls[id]); delete this._artUrls[id]; }
    // If currently playing, skip
    if (this.player.currentId === id) await this.player.next(this.db);
    this.renderLibrary();
    this.renderPlaylists();
    this.renderQueue();
    this._updateStorageBar();
    toast('Deleted from library');
  }

  /* ══ Playlists rendering ══════════════════════════════════ */
  renderPlaylists() {
    const grid  = document.getElementById('playlist-grid');
    const empty = document.getElementById('playlists-empty');
    empty.classList.toggle('hidden', this.playlists.length > 0);
    grid.innerHTML = '';
    this.playlists.forEach(pl => grid.appendChild(this._makePlaylistCard(pl)));
  }

  _makePlaylistCard(pl) {
    const card = document.createElement('div');
    card.className = 'playlist-card';
    card.setAttribute('role', 'listitem');

    // Mosaic art (up to 4 tracks)
    const artIds = pl.trackIds.slice(0, 4).filter(id => this.tracks.find(t => t.id === id)?.hasArt);
    const single = artIds.length === 1;
    const artDiv = document.createElement('div');
    artDiv.className = `playlist-card-art${single ? ' single' : ''}`;

    if (artIds.length === 0) {
      artDiv.innerHTML = `<div class="pc-art-cell"><svg width="36" height="36" viewBox="0 0 24 24" fill="none"><path d="M3 6h18M3 12h12M3 18h8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg></div>`;
    } else {
      artIds.forEach(id => {
        const url = this._artUrls[id];
        if (url) {
          const img = document.createElement('img');
          img.src = url;
          img.alt = '';
          artDiv.appendChild(img);
        } else {
          const cell = document.createElement('div');
          cell.className = 'pc-art-cell';
          artDiv.appendChild(cell);
          // Load async
          this.db.get('arts', id).then(blob => {
            if (blob) {
              this._artUrls[id] = URL.createObjectURL(blob);
              cell.innerHTML = `<img src="${this._artUrls[id]}" alt="" style="width:100%;height:100%;object-fit:cover">`;
            }
          });
        }
      });
    }

    const count = pl.trackIds.length;
    card.innerHTML = `<div class="playlist-card-name">${this._esc(pl.name)}</div><div class="playlist-card-count">${count} song${count !== 1 ? 's' : ''}</div>`;
    card.insertBefore(artDiv, card.firstChild);

    card.addEventListener('click', () => this._openPlaylist(pl.id));
    card.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      this._openContextMenu(e.clientX, e.clientY, [
        { text: 'Play', action: () => this._playPlaylist(pl.id, false) },
        { text: 'Shuffle', action: () => this._playPlaylist(pl.id, true) },
        'sep',
        { text: 'Delete Playlist', danger: true, action: () => this._deletePlaylist(pl.id) },
      ]);
    });

    return card;
  }

  _openPlaylist(id) {
    this.currentPlaylist = id;
    const pl = this.playlists.find(p => p.id === id);
    if (!pl) return;

    document.getElementById('playlist-detail-name').textContent = pl.name;
    const count = pl.trackIds.length;
    document.getElementById('playlist-detail-count').textContent = `${count} song${count !== 1 ? 's' : ''}`;
    this._renderPlaylistArt(pl, document.getElementById('playlist-detail-art'), 'pd-cell');

    // Render tracks
    const list   = document.getElementById('playlist-track-list');
    list.innerHTML = '';
    const tracks = pl.trackIds.map(id => this.tracks.find(t => t.id === id)).filter(Boolean);
    tracks.forEach((track, i) => {
      list.appendChild(this._makeTrackRow(track, i + 1, tracks, i, {
        showRemove: true,
        onRemove: (tid) => {
          pl.trackIds = pl.trackIds.filter(x => x !== tid);
          store.setPlaylists(this.playlists);
          this._openPlaylist(id); // re-render
          toast('Removed from playlist');
        },
      }));
    });

    // Play / Shuffle buttons
    document.getElementById('playlist-play-btn').onclick    = () => this._playPlaylist(id, false);
    document.getElementById('playlist-shuffle-btn').onclick = () => this._playPlaylist(id, true);
    document.getElementById('delete-playlist-btn').onclick  = () => this._deletePlaylist(id);

    // Rename on blur of contenteditable
    const nameEl = document.getElementById('playlist-detail-name');
    nameEl.addEventListener('blur', () => {
      pl.name = nameEl.textContent.trim() || pl.name;
      store.setPlaylists(this.playlists);
      this.renderPlaylists();
    });

    // Switch view
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.getElementById('view-playlist-detail').classList.add('active');
    document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
    document.querySelector('.nav-item[data-view="playlists"]').classList.add('active');
    this.currentView = 'playlist-detail';

    // Back button
    document.getElementById('back-to-playlists').onclick = () => this._switchView('playlists');
  }

  _renderPlaylistArt(pl, container, cellClass) {
    container.innerHTML = '';
    const artIds = pl.trackIds.slice(0, 4).filter(id => this.tracks.find(t => t.id === id)?.hasArt);
    if (artIds.length === 0) {
      container.innerHTML = `<div class="${cellClass}" style="grid-column:1/-1;grid-row:1/-1"><svg width="48" height="48" viewBox="0 0 24 24" fill="none"><path d="M3 6h18M3 12h12M3 18h8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg></div>`;
    } else {
      artIds.forEach(id => {
        const url = this._artUrls[id];
        if (url) {
          const img = document.createElement('img');
          img.src = url; img.alt = '';
          container.appendChild(img);
        } else {
          const cell = document.createElement('div');
          cell.className = cellClass;
          container.appendChild(cell);
          this.db.get('arts', id).then(blob => {
            if (blob) {
              this._artUrls[id] = URL.createObjectURL(blob);
              cell.innerHTML = `<img src="${this._artUrls[id]}" alt="" style="width:100%;height:100%;object-fit:cover">`;
            }
          });
        }
      });
    }
  }

  async _playPlaylist(id, shuffleFirst) {
    const pl = this.playlists.find(p => p.id === id);
    if (!pl || !pl.trackIds.length) { toast('Playlist is empty'); return; }
    const prevShuffle = this.player.shuffle;
    this.player.shuffle = shuffleFirst;
    await this.player.setQueue(pl.trackIds, 0, this.db, true);
    this.player.shuffle = prevShuffle; // restore
    if (shuffleFirst) document.getElementById('fp-shuffle-btn')?.classList.toggle('active', this.player.shuffle);
    this._openFullPlayer();
  }

  _deletePlaylist(id) {
    if (!confirm('Delete this playlist?')) return;
    this.playlists = this.playlists.filter(p => p.id !== id);
    store.setPlaylists(this.playlists);
    if (this.currentView === 'playlist-detail') this._switchView('playlists');
    this.renderPlaylists();
    toast('Playlist deleted');
  }

  /* ── New playlist ───────────────────────────────────────── */
  _setupNewPlaylistBtn() {
    document.getElementById('new-playlist-btn').addEventListener('click', () => {
      this._openModal(`
        <div class="modal-title">New Playlist</div>
        <input class="modal-input" id="modal-pl-name" type="text" placeholder="Playlist name" maxlength="80" />
        <div class="modal-actions">
          <button class="btn-accent btn-secondary" id="modal-cancel">Cancel</button>
          <button class="btn-accent" id="modal-create">Create</button>
        </div>
      `);
      const input = document.getElementById('modal-pl-name');
      input.focus();
      document.getElementById('modal-cancel').addEventListener('click', () => this._closeModal());
      document.getElementById('modal-create').addEventListener('click', () => {
        const name = input.value.trim();
        if (!name) { input.focus(); return; }
        this._createPlaylist(name);
        this._closeModal();
      });
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') document.getElementById('modal-create').click();
        if (e.key === 'Escape') this._closeModal();
      });
    });
  }

  _createPlaylist(name) {
    const pl = { id: uid(), name, trackIds: [], createdAt: Date.now() };
    this.playlists.push(pl);
    store.setPlaylists(this.playlists);
    this.renderPlaylists();
    toast(`Created "${name}"`);
    return pl;
  }

  /* ══ Queue rendering ══════════════════════════════════════ */
  renderQueue() {
    const curEl   = document.getElementById('queue-current-track');
    const listEl  = document.getElementById('queue-list');
    const emptyEl = document.getElementById('queue-empty');
    curEl.innerHTML  = '';
    listEl.innerHTML = '';

    if (!this.player.queue.length) {
      emptyEl.classList.remove('hidden');
      return;
    }
    emptyEl.classList.add('hidden');

    const curId = this.player.currentId;
    if (curId) {
      const cur = this.tracks.find(t => t.id === curId);
      if (cur) curEl.appendChild(this._makeTrackRow(cur, 1, [cur], 0));
    }

    const upcoming = this.player.queue.slice(this.player.idx + 1);
    upcoming.forEach((id, i) => {
      const t = this.tracks.find(tr => tr.id === id);
      if (t) {
        const qIdx = this.player.idx + 1 + i;
        const row = this._makeTrackRow(t, i + 1, this.player.queue.map(qid => this.tracks.find(tr => tr.id === qid)).filter(Boolean), qIdx);
        listEl.appendChild(row);
      }
    });

    document.getElementById('clear-queue-btn').onclick = () => {
      this.player.queue = this.player.currentId ? [this.player.currentId] : [];
      this.player.orig  = [...this.player.queue];
      this.player.idx   = 0;
      store.setQueue(this.player.queue);
      this.renderQueue();
      toast('Queue cleared');
    };
  }

  _renderFPQueue() {
    const list = document.getElementById('fp-queue-list');
    list.innerHTML = '';
    const upcoming = this.player.queue.slice(this.player.idx + 1);
    if (!upcoming.length) {
      list.innerHTML = '<div class="lyrics-empty">Nothing up next</div>';
      return;
    }
    upcoming.forEach((id, i) => {
      const t = this.tracks.find(tr => tr.id === id);
      if (t) {
        const row = this._makeTrackRow(t, i + 1, upcoming.map(qid => this.tracks.find(tr => tr.id === qid)).filter(Boolean), i);
        list.appendChild(row);
      }
    });
  }

  /* ══ Storage bar ══════════════════════════════════════════ */
  async _updateStorageBar() {
    if (!navigator.storage?.estimate) return;
    if (!this.tracks.length) return;
    const bar = document.getElementById('storage-bar');
    const { usage, quota } = await navigator.storage.estimate();
    if (!quota) return;
    bar.hidden = false;
    const mb  = (usage / 1e6).toFixed(0);
    document.getElementById('storage-used').textContent = `${mb} MB`;
    document.getElementById('storage-fill').style.width = `${Math.min(100, (usage / quota) * 100)}%`;
  }

  /* ══ Helpers ══════════════════════════════════════════════ */
  _esc(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  _svgIcon(name) {
    const icons = {
      next:  `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="5,4 15,12 5,20"/><rect x="16.5" y="4" width="2.5" height="16" rx="1"/></svg>`,
      queue: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M3 6h18M3 12h18M3 18h11" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>`,
      trash: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>`,
    };
    return icons[name] || '';
  }
}

/* ─── Boot ───────────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', async () => {
  const app = new App();
  window._app = app;
  await app.init();

  // Setup new playlist button (needs DOM to be ready)
  app._setupNewPlaylistBtn();

  // Storage bar initial render
  await app._updateStorageBar();
});
