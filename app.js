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
  getEQ:        ()  => store._get('ll_eq', { bass: 0, mids: 0, treble: 0 }),
  setEQ:        (v) => store._set('ll_eq', v),
  getPitch:     ()  => store._get('ll_pitch', 0),
  setPitch:     (v) => store._set('ll_pitch', v),
  getAccent:    ()  => store._get('ll_accent', '#fc3c44'),
  setAccent:    (v) => store._set('ll_accent', v),
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
    this.pitch   = 0;
    this._url    = null;
    this._db     = null;  // set by App after DB is open

    // Web Audio API (EQ)
    this._audioCtx   = null;
    this._srcNode    = null;
    this._bassFilter = null;
    this._midsFilter = null;
    this._trebFilter = null;

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

  /* Lazily initialize Web Audio API (must happen after user gesture) */
  _initAudioCtx() {
    if (this._audioCtx) return;
    try {
      this._audioCtx   = new (window.AudioContext || window.webkitAudioContext)();
      this._srcNode    = this._audioCtx.createMediaElementSource(this.audio);
      this._bassFilter = this._audioCtx.createBiquadFilter();
      this._bassFilter.type = 'lowshelf';
      this._bassFilter.frequency.value = 250;
      this._midsFilter = this._audioCtx.createBiquadFilter();
      this._midsFilter.type = 'peaking';
      this._midsFilter.frequency.value = 1000;
      this._midsFilter.Q.value = 0.8;
      this._trebFilter = this._audioCtx.createBiquadFilter();
      this._trebFilter.type = 'highshelf';
      this._trebFilter.frequency.value = 8000;
      this._srcNode
        .connect(this._bassFilter)
        .connect(this._midsFilter)
        .connect(this._trebFilter)
        .connect(this._audioCtx.destination);
    } catch (e) {
      console.warn('Web Audio API not available:', e);
    }
  }

  setEQ(bass, mids, treble) {
    if (this._bassFilter) this._bassFilter.gain.value = bass;
    if (this._midsFilter) this._midsFilter.gain.value = mids;
    if (this._trebFilter) this._trebFilter.gain.value = treble;
  }

  get playing()   { return !this.audio.paused; }
  get currentId() { return this.queue[this.idx] ?? null; }
  get time()      { return this.audio.currentTime; }
  get duration()  { return this.audio.duration || 0; }
  get pct()       { return this.duration ? this.time / this.duration : 0; }

  setVolume(v) { this.volume = v; this.audio.volume = v; }

  setPitch(semitones = 0) {
    const safeSemitones = Number.isFinite(semitones) ? semitones : 0;
    this.pitch = safeSemitones;
    const rate = clamp(Math.pow(2, safeSemitones / 12), 0.0625, 16);
    this.audio.playbackRate = rate;
    try { if ('preservesPitch' in this.audio) this.audio.preservesPitch = false; } catch {}
    try { if ('mozPreservesPitch' in this.audio) this.audio.mozPreservesPitch = false; } catch {}
    try { if ('webkitPreservesPitch' in this.audio) this.audio.webkitPreservesPitch = false; } catch {}
  }

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
  togglePlay()   {
    this._initAudioCtx();
    if (this._audioCtx && this._audioCtx.state === 'suspended') {
      this._audioCtx.resume().catch(() => {});
    }
    this.playing ? this.audio.pause() : this.audio.play().catch(() => {});
  }

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
    if (autoPlay) {
      this._initAudioCtx();
      if (this._audioCtx && this._audioCtx.state === 'suspended') {
        await this._audioCtx.resume().catch(() => {});
      }
      await this.audio.play().catch(() => {});
    }
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
    this._settingsOpen = false;
    this._lrcData = null;
    this._lrcHighlight = -1;
    this._seekDragging = false;

    // drag counter for whole-window drop
    this._dragCounter = 0;

    // Accent colors palette
    this._accentColors = [
      { name: 'Red',    value: '#fc3c44' },
      { name: 'Blue',   value: '#0a84ff' },
      { name: 'Green',  value: '#30d158' },
      { name: 'Purple', value: '#bf5af2' },
      { name: 'Orange', value: '#ff9f0a' },
      { name: 'Pink',   value: '#ff375f' },
      { name: 'Cyan',   value: '#5ac8fa' },
      { name: 'Yellow', value: '#ffd60a' },
    ];
  }

  /* ══ Init ══════════════════════════════════════════════════ */
  async init() {
    await this.db.open();
    this._loadState();
    this._applyAccent(store.getAccent());
    this._setupPlayer();
    this._setupUI();
    this._restorePlayerState();
    this.renderLibrary();
    this.renderPlaylists();
  }

  _loadState() {
    this.tracks    = store.getTracks();
    this.playlists = store.getPlaylists();
    this.liked     = new Set(store.getLiked());
    const ps = store.getPlayerState();
    this.player.shuffle = ps.shuffle ?? false;
    this.player.repeat  = ps.repeat  ?? 'none';
    this.player.setVolume(ps.volume  ?? 1);
    this.player.setPitch(parseFloat(store.getPitch()) || 0);
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
    this.renderLibrary(); // refresh active state
  }

  _onPlayState() {
    const playing = this.player.playing;
    // Sidebar mini player icons
    document.getElementById('smp-play-icon')?.classList.toggle('hidden', playing);
    document.getElementById('smp-pause-icon')?.classList.toggle('hidden', !playing);
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
    // Sidebar mini player progress
    const smpFill = document.getElementById('smp-progress-fill');
    if (smpFill) smpFill.style.width = `${pct * 100}%`;
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

    // Sidebar mini player
    const smpTitle = document.getElementById('smp-title');
    const smpArtist = document.getElementById('smp-artist');
    const smpArt = document.getElementById('smp-art');
    const smpPh  = document.getElementById('smp-art-placeholder');
    if (smpTitle) smpTitle.textContent  = track.title;
    if (smpArtist) smpArtist.textContent = track.artist;
    if (smpArt && smpPh) {
      if (artUrl) {
        smpArt.src = artUrl;
        smpArt.style.display = 'block';
        smpPh.style.display  = 'none';
      } else {
        smpArt.style.display = 'none';
        smpPh.style.display  = 'flex';
      }
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

    // Dynamic color + fancy gradient
    if (artUrl) {
      const { r, g, b } = await this.extractor.extract(artUrl);
      document.documentElement.style.setProperty('--dyn-r', r);
      document.documentElement.style.setProperty('--dyn-g', g);
      document.documentElement.style.setProperty('--dyn-b', b);
      // Apple Music-style gradient overlay
      const colorLayer = document.getElementById('fp-color-layer');
      if (colorLayer) {
        colorLayer.style.background = `radial-gradient(ellipse at 50% 0%, rgba(${r},${g},${b},.8) 0%, rgba(${r},${g},${b},.3) 50%, transparent 80%)`;
      }
    } else {
      document.documentElement.style.setProperty('--dyn-r', 252);
      document.documentElement.style.setProperty('--dyn-g', 60);
      document.documentElement.style.setProperty('--dyn-b', 68);
      const colorLayer = document.getElementById('fp-color-layer');
      if (colorLayer) colorLayer.style.background = '';
    }

    // Media Session API
    if ('mediaSession' in navigator) {
      navigator.mediaSession.metadata = new MediaMetadata({
        title:  track.title,
        artist: track.artist,
        album:  track.album,
        artwork: artUrl
          ? [{ src: artUrl, sizes: '512x512', type: 'image/jpeg' }]
          : [],
      });
      navigator.mediaSession.setActionHandler('play',          () => this.player.togglePlay());
      navigator.mediaSession.setActionHandler('pause',         () => this.player.togglePlay());
      navigator.mediaSession.setActionHandler('nexttrack',     () => this.player.next(this.db));
      navigator.mediaSession.setActionHandler('previoustrack', () => this.player.prev(this.db));
      navigator.mediaSession.setActionHandler('seekto', (details) => {
        if (details.seekTime != null) this.player.seek(details.seekTime);
      });
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
    this._setupSidebarMiniPlayer();
    this._setupFullPlayer();
    this._setupContextMenu();
    this._setupModalOverlay();
    this._setupSettings();
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
    if (view === 'playlists') this.renderPlaylists();
    if (view === 'library')   this.renderLibrary();
    if (view === 'artists')   this.renderArtists();
    if (view === 'albums')    this.renderAlbums();
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

  /* ── Sidebar mini player ────────────────────────────────── */
  _setupSidebarMiniPlayer() {
    const trigger = document.getElementById('smp-open-trigger');
    const prev    = document.getElementById('smp-prev-btn');
    const play    = document.getElementById('smp-play-btn');
    const next    = document.getElementById('smp-next-btn');

    trigger.addEventListener('click', () => this._openFullPlayer());

    // Controls must not bubble and open full player
    const ctrl = document.getElementById('smp-controls-stop-prop');
    ctrl.addEventListener('click', (e) => e.stopPropagation());

    prev.addEventListener('click', () => this.player.prev(this.db));
    play.addEventListener('click', () => this.player.togglePlay());
    next.addEventListener('click', () => this.player.next(this.db));
  }

  _showMiniPlayer() {
    document.getElementById('sidebar-mini-player').classList.remove('hidden');
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
      this._renderFPQueue();
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
      if (e.key === 'Escape') {
        if (this._settingsOpen) this._closeSettings();
        else if (this._fpOpen)  this._closeFullPlayer();
      }
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

  /* ── Settings panel ─────────────────────────────────────── */
  _setupSettings() {
    const panel    = document.getElementById('settings-panel');
    const openBtn  = document.getElementById('sidebar-settings-btn');
    const closeBtn = document.getElementById('settings-close-btn');
    const bg       = document.getElementById('settings-bg');

    openBtn.addEventListener('click',  () => this._openSettings());
    closeBtn.addEventListener('click', () => this._closeSettings());
    bg.addEventListener('click',       () => this._closeSettings());

    const formatPitch = (v) => {
      const n = Number(v);
      const abs = Number.isInteger(n) ? n.toString() : n.toFixed(1);
      return `${n > 0 ? '+' : ''}${abs} st`;
    };

    // EQ sliders
    const savedEQ = store.getEQ();
    const bands = [
      { id: 'eq-bass',   valId: 'eq-bass-val',   key: 'bass'   },
      { id: 'eq-mids',   valId: 'eq-mids-val',   key: 'mids'   },
      { id: 'eq-treble', valId: 'eq-treble-val', key: 'treble' },
    ];
    bands.forEach(({ id, valId, key }) => {
      const slider = document.getElementById(id);
      const label  = document.getElementById(valId);
      slider.value = savedEQ[key] ?? 0;
      label.textContent = `${savedEQ[key] >= 0 ? '+' : ''}${savedEQ[key] ?? 0} dB`;
      slider.addEventListener('input', () => {
        const v = parseInt(slider.value);
        label.textContent = `${v >= 0 ? '+' : ''}${v} dB`;
        const eq = store.getEQ();
        eq[key] = v;
        store.setEQ(eq);
        this.player.setEQ(eq.bass, eq.mids, eq.treble);
      });
    });

    // Reset EQ
    document.getElementById('eq-reset-btn').addEventListener('click', () => {
      bands.forEach(({ id, valId }) => {
        document.getElementById(id).value = 0;
        document.getElementById(valId).textContent = '0 dB';
      });
      store.setEQ({ bass: 0, mids: 0, treble: 0 });
      this.player.setEQ(0, 0, 0);
      toast('EQ reset');
    });

    // Pitch slider
    const pitchSlider = document.getElementById('pitch-slider');
    const pitchVal    = document.getElementById('pitch-val');
    const savedPitch  = parseFloat(store.getPitch()) || 0;
    pitchSlider.value = savedPitch;
    pitchVal.textContent = formatPitch(savedPitch);
    pitchSlider.addEventListener('input', () => {
      const v = parseFloat(pitchSlider.value);
      pitchVal.textContent = formatPitch(v);
      store.setPitch(v);
      this.player.setPitch(v);
    });

    // Reset Pitch
    document.getElementById('pitch-reset-btn').addEventListener('click', () => {
      pitchSlider.value = 0;
      pitchVal.textContent = '0 st';
      store.setPitch(0);
      this.player.setPitch(0);
      toast('Pitch reset');
    });

    // Color swatches
    const swatchContainer = document.getElementById('color-swatches');
    const currentAccent   = store.getAccent();
    this._accentColors.forEach(({ name, value }) => {
      const btn = document.createElement('button');
      btn.className = `color-swatch${value === currentAccent ? ' active' : ''}`;
      btn.style.background = value;
      btn.title = name;
      btn.setAttribute('aria-label', name);
      btn.addEventListener('click', () => {
        swatchContainer.querySelectorAll('.color-swatch').forEach(s => s.classList.remove('active'));
        btn.classList.add('active');
        store.setAccent(value);
        this._applyAccent(value);
        toast(`Accent: ${name}`);
      });
      swatchContainer.appendChild(btn);
    });
  }

  _openSettings() {
    const panel = document.getElementById('settings-panel');
    panel.classList.remove('hidden');
    // Initialize EQ filters now that user interacted
    this.player._initAudioCtx();
    const eq = store.getEQ();
    this.player.setEQ(eq.bass, eq.mids, eq.treble);
    this.player.setPitch(parseFloat(store.getPitch()) || 0);
    requestAnimationFrame(() => panel.classList.add('open'));
    this._settingsOpen = true;
  }

  _closeSettings() {
    const panel = document.getElementById('settings-panel');
    panel.classList.remove('open');
    panel.addEventListener('transitionend', () => {
      if (!this._settingsOpen) panel.classList.add('hidden');
    }, { once: true });
    this._settingsOpen = false;
  }

  _applyAccent(hex) {
    // Parse hex to rgb
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    const root = document.documentElement;
    root.style.setProperty('--accent',      hex);
    root.style.setProperty('--accent-dim',  `rgba(${r},${g},${b},.25)`);
    root.style.setProperty('--accent-glow', `rgba(${r},${g},${b},.4)`);
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
    const items = [
      { text: 'Play Next', icon: this._svgIcon('next'), action: () => {
          const afterIdx = this.player.idx + 1;
          this.player.queue.splice(afterIdx, 0, track.id);
          store.setQueue(this.player.queue);
          toast('Playing next');
        }
      },
    ];

    if (playlists.length) {
      items.push('sep');
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
    } else {
      items.push({ text: 'Add to Playlist', icon: this._svgIcon('playlist'), action: () => {
          toast('Create a playlist first');
        }
      });
    }

    items.push('sep');
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

  /* ══ Queue rendering (internal - used by full player) ═════ */
  renderQueue() {
    // Queue view removed from sidebar - use _renderFPQueue for full player queue panel
    this._renderFPQueue();
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

  /* ══ Artists rendering ════════════════════════════════════ */
  renderArtists() {
    const list  = document.getElementById('artist-list');
    const empty = document.getElementById('artists-empty');
    if (!list) return;

    // Group tracks by artist
    const artistMap = new Map();
    for (const t of this.tracks) {
      const key = t.artist || 'Unknown Artist';
      if (!artistMap.has(key)) artistMap.set(key, []);
      artistMap.get(key).push(t);
    }

    const artists = [...artistMap.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    empty.classList.toggle('hidden', artists.length > 0);
    list.innerHTML = '';

    artists.forEach(([name, tracks]) => {
      const row = document.createElement('div');
      row.className = 'artist-row';
      row.setAttribute('role', 'listitem');

      // Find first track with art for avatar
      const artTrack = tracks.find(t => t.hasArt && this._artUrls[t.id]);
      const avatarUrl = artTrack ? this._artUrls[artTrack.id] : null;

      const songCount = tracks.length;
      row.innerHTML = `
        <div class="artist-row-avatar">
          ${avatarUrl
            ? `<img src="${avatarUrl}" alt="" />`
            : `<svg width="22" height="22" viewBox="0 0 24 24" fill="none"><circle cx="8" cy="8" r="3.5" stroke="currentColor" stroke-width="1.8"/><path d="M2 20c0-3.31 2.69-6 6-6s6 2.69 6 6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>`
          }
        </div>
        <div class="artist-row-info">
          <div class="artist-row-name">${this._esc(name)}</div>
          <div class="artist-row-count">${songCount} song${songCount !== 1 ? 's' : ''}</div>
        </div>
        <svg class="artist-row-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M9 18l6-6-6-6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
      `;

      row.addEventListener('click', () => this._openArtistDetail(name, tracks));

      // Async load avatar if not cached
      if (!avatarUrl) {
        const artT = tracks.find(t => t.hasArt);
        if (artT) {
          this.db.get('arts', artT.id).then(blob => {
            if (blob) {
              this._artUrls[artT.id] = URL.createObjectURL(blob);
              const av = row.querySelector('.artist-row-avatar');
              if (av) av.innerHTML = `<img src="${this._artUrls[artT.id]}" alt="" />`;
            }
          });
        }
      }

      list.appendChild(row);
    });
  }

  _openArtistDetail(artistName, allArtistTracks) {
    // Group tracks into albums
    const albumMap = new Map();
    for (const t of allArtistTracks) {
      const key = t.album || 'Unknown Album';
      if (!albumMap.has(key)) albumMap.set(key, []);
      albumMap.get(key).push(t);
    }

    // Sort albums by year then name
    const albums = [...albumMap.entries()].sort((a, b) => {
      const ya = a[1][0]?.year || '';
      const yb = b[1][0]?.year || '';
      return ya.localeCompare(yb) || a[0].localeCompare(b[0]);
    });

    document.getElementById('artist-detail-name').textContent = artistName;
    const count = allArtistTracks.length;
    document.getElementById('artist-detail-count').textContent = `${count} song${count !== 1 ? 's' : ''}`;

    // Avatar
    const avatarEl = document.getElementById('artist-avatar');
    const artTrack  = allArtistTracks.find(t => t.hasArt && this._artUrls[t.id]);
    if (artTrack) {
      avatarEl.innerHTML = `<img src="${this._artUrls[artTrack.id]}" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:50%" />`;
    } else {
      avatarEl.innerHTML = `<svg width="48" height="48" viewBox="0 0 24 24" fill="none"><circle cx="8" cy="8" r="3.5" stroke="currentColor" stroke-width="1.4"/><path d="M2 20c0-3.31 2.69-6 6-6s6 2.69 6 6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>`;
    }

    // Play / Shuffle buttons
    document.getElementById('artist-play-btn').onclick = async () => {
      const ids = allArtistTracks.map(t => t.id);
      await this.player.setQueue(ids, 0, this.db, true);
      this._openFullPlayer();
    };
    document.getElementById('artist-shuffle-btn').onclick = async () => {
      const ids = allArtistTracks.map(t => t.id);
      const prev = this.player.shuffle;
      this.player.shuffle = true;
      await this.player.setQueue(ids, 0, this.db, true);
      this.player.shuffle = prev;
      this._openFullPlayer();
    };

    // Albums section
    const section = document.getElementById('artist-albums-section');
    section.innerHTML = '';

    if (albums.length > 1) {
      const label = document.createElement('div');
      label.className = 'artist-section-label';
      label.textContent = 'Albums';
      section.appendChild(label);
    }

    albums.forEach(([albumName, tracks]) => {
      // Sort tracks by track number
      const sorted = [...tracks].sort((a, b) => (parseInt(a.track)||999) - (parseInt(b.track)||999));
      const block = document.createElement('div');
      block.className = 'artist-album-block';

      // Album header (click → album detail)
      const header = document.createElement('div');
      header.className = 'artist-album-header';

      const artTrack = sorted.find(t => t.hasArt && this._artUrls[t.id]);
      const artUrl   = artTrack ? this._artUrls[artTrack.id] : null;
      const year     = sorted[0]?.year || '';

      header.innerHTML = `
        <div class="artist-album-art">
          ${artUrl
            ? `<img src="${artUrl}" alt="" />`
            : `<svg width="22" height="22" viewBox="0 0 24 24" fill="none"><rect x="3" y="3" width="18" height="18" rx="3" stroke="currentColor" stroke-width="1.8"/><circle cx="12" cy="12" r="3" stroke="currentColor" stroke-width="1.8"/></svg>`
          }
        </div>
        <div class="artist-album-meta">
          <div class="artist-album-title">${this._esc(albumName)}</div>
          <div class="artist-album-year">${year ? year : sorted.length + ' song' + (sorted.length !== 1 ? 's' : '')}</div>
        </div>
        <svg class="artist-album-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M9 18l6-6-6-6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
      `;

      header.addEventListener('click', () => {
        this._openAlbumDetail(albumName, sorted, 'artist-detail');
      });

      // Async load art for album header
      if (!artUrl) {
        const at = sorted.find(t => t.hasArt);
        if (at) {
          this.db.get('arts', at.id).then(blob => {
            if (blob) {
              this._artUrls[at.id] = URL.createObjectURL(blob);
              const artEl = header.querySelector('.artist-album-art');
              if (artEl) artEl.innerHTML = `<img src="${this._artUrls[at.id]}" alt="" style="width:100%;height:100%;object-fit:cover" />`;
            }
          });
        }
      }

      block.appendChild(header);
      section.appendChild(block);
    });

    // Back button
    document.getElementById('back-to-artists').onclick = () => this._switchView('artists');

    // Switch to artist detail view
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.getElementById('view-artist-detail').classList.add('active');
    document.querySelectorAll('.nav-item').forEach(b => b.classList.toggle('active', b.dataset.view === 'artists'));
    this.currentView = 'artist-detail';
  }

  /* ══ Albums rendering ══════════════════════════════════════ */
  renderAlbums() {
    const grid  = document.getElementById('album-grid');
    const empty = document.getElementById('albums-empty');
    if (!grid) return;

    // Group tracks by album
    const albumMap = new Map();
    for (const t of this.tracks) {
      const key = `${t.album || 'Unknown Album'}|||${t.artist || 'Unknown Artist'}`;
      if (!albumMap.has(key)) albumMap.set(key, []);
      albumMap.get(key).push(t);
    }

    const albums = [...albumMap.entries()].sort((a, b) => {
      const [nameA] = a[0].split('|||');
      const [nameB] = b[0].split('|||');
      return nameA.localeCompare(nameB);
    });

    empty.classList.toggle('hidden', albums.length > 0);
    grid.innerHTML = '';

    albums.forEach(([key, tracks]) => {
      const [albumName, artistName] = key.split('|||');
      const sorted = [...tracks].sort((a, b) => (parseInt(a.track)||999) - (parseInt(b.track)||999));

      const card = document.createElement('div');
      card.className = 'album-card';
      card.setAttribute('role', 'listitem');

      const artTrack = sorted.find(t => t.hasArt && this._artUrls[t.id]);
      const artUrl   = artTrack ? this._artUrls[artTrack.id] : null;

      card.innerHTML = `
        <div class="album-card-art">
          ${artUrl
            ? `<img src="${artUrl}" alt="" />`
            : `<svg width="36" height="36" viewBox="0 0 24 24" fill="none"><rect x="3" y="3" width="18" height="18" rx="3" stroke="currentColor" stroke-width="1.4"/><circle cx="12" cy="12" r="3" stroke="currentColor" stroke-width="1.4"/><circle cx="12" cy="12" r="1" fill="currentColor"/></svg>`
          }
        </div>
        <div class="album-card-name">${this._esc(albumName)}</div>
        <div class="album-card-artist">${this._esc(artistName)}</div>
      `;

      // Async load art
      if (!artUrl) {
        const at = sorted.find(t => t.hasArt);
        if (at) {
          this.db.get('arts', at.id).then(blob => {
            if (blob) {
              this._artUrls[at.id] = URL.createObjectURL(blob);
              const artEl = card.querySelector('.album-card-art');
              if (artEl) artEl.innerHTML = `<img src="${this._artUrls[at.id]}" alt="" style="width:100%;height:100%;object-fit:cover" />`;
            }
          });
        }
      }

      card.addEventListener('click', () => this._openAlbumDetail(albumName, sorted, 'albums'));
      card.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        this._openContextMenu(e.clientX, e.clientY, [
          { text: 'Play', action: () => this._playAlbum(sorted, false) },
          { text: 'Shuffle', action: () => this._playAlbum(sorted, true) },
        ]);
      });

      grid.appendChild(card);
    });
  }

  _openAlbumDetail(albumName, tracks, backView = 'albums') {
    const artist = tracks[0]?.artist || 'Unknown Artist';
    const count  = tracks.length;

    document.getElementById('album-detail-name').textContent   = albumName;
    document.getElementById('album-detail-artist').textContent = artist;
    document.getElementById('album-detail-count').textContent  = `${count} song${count !== 1 ? 's' : ''}`;
    document.getElementById('album-back-label').textContent    = backView === 'artist-detail' ? 'Artist' : 'Albums';

    // Art
    const artContainer = document.getElementById('album-detail-art');
    const artTrack = tracks.find(t => t.hasArt && this._artUrls[t.id]);
    const artUrl   = artTrack ? this._artUrls[artTrack.id] : null;
    artContainer.innerHTML = '';
    if (artUrl) {
      const img = document.createElement('img');
      img.src = artUrl; img.alt = '';
      img.style.cssText = 'width:100%;height:100%;object-fit:cover;border-radius:var(--radius)';
      artContainer.appendChild(img);
    } else {
      artContainer.innerHTML = `<div class="pd-cell" style="grid-column:1/-1;grid-row:1/-1"><svg width="48" height="48" viewBox="0 0 24 24" fill="none"><rect x="3" y="3" width="18" height="18" rx="3" stroke="currentColor" stroke-width="1.4"/><circle cx="12" cy="12" r="3" stroke="currentColor" stroke-width="1.4"/></svg></div>`;
      const at = tracks.find(t => t.hasArt);
      if (at) {
        this.db.get('arts', at.id).then(blob => {
          if (blob) {
            this._artUrls[at.id] = URL.createObjectURL(blob);
            const img = document.createElement('img');
            img.src = this._artUrls[at.id]; img.alt = '';
            img.style.cssText = 'width:100%;height:100%;object-fit:cover;border-radius:var(--radius)';
            artContainer.innerHTML = '';
            artContainer.appendChild(img);
          }
        });
      }
    }

    // Play / Shuffle
    document.getElementById('album-play-btn').onclick    = () => this._playAlbum(tracks, false);
    document.getElementById('album-shuffle-btn').onclick = () => this._playAlbum(tracks, true);

    // Back button
    document.getElementById('back-from-album').onclick = () => {
      if (backView === 'artist-detail') {
        document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
        document.getElementById('view-artist-detail').classList.add('active');
        this.currentView = 'artist-detail';
      } else {
        this._switchView('albums');
      }
    };

    // Track list
    const list = document.getElementById('album-track-list');
    list.innerHTML = '';
    tracks.forEach((track, i) => {
      list.appendChild(this._makeTrackRow(track, i + 1, tracks, i));
    });

    // Switch view
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.getElementById('view-album-detail').classList.add('active');
    document.querySelectorAll('.nav-item').forEach(b => {
      b.classList.toggle('active', b.dataset.view === (backView === 'artist-detail' ? 'artists' : 'albums'));
    });
    this.currentView = 'album-detail';
  }

  async _playAlbum(tracks, shuffleFirst) {
    if (!tracks.length) { toast('Album is empty'); return; }
    const ids = tracks.map(t => t.id);
    const prev = this.player.shuffle;
    this.player.shuffle = shuffleFirst;
    await this.player.setQueue(ids, 0, this.db, true);
    this.player.shuffle = prev;
    this._openFullPlayer();
  }

  /* ══ Storage bar (removed) ════════════════════════════════ */
  async _updateStorageBar() {
    // Storage bar removed; no-op
  }

  /* ══ Helpers ══════════════════════════════════════════════ */
  _esc(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  _svgIcon(name) {
    const icons = {
      next:     `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="5,4 15,12 5,20"/><rect x="16.5" y="4" width="2.5" height="16" rx="1"/></svg>`,
      queue:    `<svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M3 6h18M3 12h18M3 18h11" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>`,
      playlist: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M3 6h18M3 12h12M3 18h8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>`,
      trash:    `<svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>`,
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
});
