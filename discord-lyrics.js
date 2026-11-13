'use strict';

const { execFile } = require('child_process');
const DiscordRPC = require('discord-rpc');

const UPDATE_INTERVAL_MS = 3000;
const MEDIA_TIMEOUT_MS = 5000;
const LYRIC_TIMEOUT_MS = 7000;

const MEDIA_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
function Clean-Text($value) {
  return ([string]$value -replace '[\x00-\x1F\x7F]', ' ').Trim()
}
function Encode-Field($value) {
  return [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes((Clean-Text $value)))
}
function Write-Media($artist, $title, $source, $position, $duration, $playback, $browserTitle) {
  $fields = @(
    'MEDIA',
    (Encode-Field $artist),
    (Encode-Field $title),
    (Encode-Field $source),
    [string]$position,
    [string]$duration,
    [string]$playback,
    (Encode-Field $browserTitle)
  )
  Write-Output ($fields -join '|')
}
try {
  $browserTitle = ''
  try {
    $browserWindows = @(Get-Process -Name chrome, brave, msedge, firefox, opera -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle })
    $spotifyWindow = $browserWindows | Where-Object { $_.MainWindowTitle -match 'Spotify' } | Select-Object -First 1
    if (-not $spotifyWindow) {
      $spotifyWindow = $browserWindows | Where-Object { $_.MainWindowTitle -match '[•·]' -and $_.MainWindowTitle -match ' - ' } | Select-Object -First 1
    }
    if ($spotifyWindow) { $browserTitle = Clean-Text $spotifyWindow.MainWindowTitle }
  } catch {}
  $manager = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType=WindowsRuntime]::RequestAsync().GetAwaiter().GetResult()
  $sessions = @($manager.GetSessions())
  $session = $sessions | Where-Object { $_.SourceAppId -and $_.SourceAppId.ToLower().Contains('spotify') } | Select-Object -First 1
  if (-not $session) {
    $current = $manager.GetCurrentSession()
    if ($current) {
      $source = [string]$current.SourceAppId
      if ($source -match 'chrome|brave|msedge|firefox|opera') {
        if ($spotifyWindow) { $session = $current }
      }
    }
  }
  if (-not $session) {
    if ($browserTitle) {
      Write-Media '' '' 'spotify-web-title' 0 0 4 $browserTitle
    } else { Write-Output 'NONE' }
    exit
  }
  $properties = $session.TryGetMediaPropertiesAsync().GetAwaiter().GetResult()
  $timeline = $session.GetTimelineProperties()
  $playback = [int]$session.GetPlaybackInfo().PlaybackStatus
  $artistText = Clean-Text $properties.Artist
  $titleText = Clean-Text $properties.Title
  $sourceText = Clean-Text $session.SourceAppId
  Write-Media $artistText $titleText $sourceText ([int64]$timeline.Position.TotalMilliseconds) ([int64]$timeline.EndTime.TotalMilliseconds) $playback $browserTitle
} catch {
  if ($browserTitle) {
    Write-Media '' '' 'spotify-web-title' 0 0 4 $browserTitle
  } else { Write-Output 'NONE' }
}
`;

function parseBrowserTitle(title) {
  let clean = String(title || '')
    .replace(/\s+-\s+(brave|chrome|chromium|msedge|edge|firefox|opera|vivaldi|arc)(\s+browser)?\s*$/i, '')
    .replace(/\s*[-|]\s*Spotify(\s*Free|\s*Premium|\s*-\s*Web Player)?\s*$/i, '')
    .replace(/[–—]/g, '-')
    .trim();
  const bulletParts = clean.split(/\s*[•·]\s*/);
  if (bulletParts.length === 2) clean = `${bulletParts[1]} - ${bulletParts[0]}`;
  const separator = clean.indexOf(' - ');
  if (separator <= 0) return null;
  const artist = clean.slice(0, separator).trim();
  const song = clean.slice(separator + 3).trim();
  if (!artist || !song || /^(spotify|home|search|your library|web player)$/i.test(song)) return null;
  return { artist, title: song };
}

function parseLrc(text) {
  const lines = [];
  const timestamps = /\[(\d{1,2}):(\d{2})(?:[.:](\d{2,3}))?\]/g;
  for (const raw of String(text || '').split(/\r?\n/)) {
    timestamps.lastIndex = 0;
    const matches = [...raw.matchAll(timestamps)];
    const lyric = raw.replace(timestamps, '').trim();
    if (!lyric) continue;
    for (const match of matches) {
      const fraction = match[3] ? Number(match[3]) * (match[3].length === 2 ? 10 : 1) : 0;
      lines.push({
        time: (Number(match[1]) * 60 + Number(match[2])) * 1000 + fraction,
        text: lyric,
      });
    }
  }
  return lines.sort((a, b) => a.time - b.time);
}

function readMedia() {
  if (process.platform !== 'win32') return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', MEDIA_SCRIPT], {
      windowsHide: true,
      timeout: MEDIA_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
    }, (_error, stdout) => {
      const output = String(stdout || '').replace(/[\x00-\x1F\x7F]/g, '').trim();
      if (!output || output === 'NONE') return resolve(null);
      try {
        const fields = output.split('|');
        if (fields.length !== 8 || fields[0] !== 'MEDIA') return resolve(null);
        const decode = (value) => Buffer.from(value, 'base64').toString('utf8').replace(/[\x00-\x1F\x7F]/g, ' ').trim();
        const media = {
          artist: decode(fields[1]),
          title: decode(fields[2]),
          source: decode(fields[3]),
          positionMs: Number(fields[4]),
          durationMs: Number(fields[5]),
          playback: Number(fields[6]),
          browserTitle: decode(fields[7]),
        };
        if (media.browserTitle && !media.title) {
          const parsed = parseBrowserTitle(media.browserTitle);
          if (!parsed) return resolve(null);
          return resolve({
            ...parsed,
            source: 'spotify-web-title',
            positionMs: 0,
            durationMs: 0,
            paused: false,
          });
        }
        if (!media.title || Number(media.playback) === 3 || Number(media.playback) === 1) return resolve(null);
        resolve({
          artist: String(media.artist || '').trim(),
          title: String(media.title || '').trim(),
          source: String(media.source || ''),
          positionMs: Math.max(0, Number(media.positionMs) || 0),
          durationMs: Math.max(0, Number(media.durationMs) || 0),
          paused: Number(media.playback) === 5,
        });
      } catch {
        resolve(null);
      }
    });
  });
}

async function fetchLyrics(artist, title) {
  if (!artist || !title) return { synced: [], plain: [] };
  const query = new URLSearchParams({ artist_name: artist, track_name: title });
  try {
    const response = await fetch(`https://lrclib.net/api/get?${query}`, {
      signal: AbortSignal.timeout(LYRIC_TIMEOUT_MS),
      headers: { 'User-Agent': 'ExecutorKingjo/1.0' },
    });
    if (!response.ok) return { synced: [], plain: [] };
    const data = await response.json();
    return {
      synced: parseLrc(data.syncedLyrics),
      plain: String(data.plainLyrics || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean),
    };
  } catch {
    return { synced: [], plain: [] };
  }
}

class DiscordLyricsPresence {
  constructor(onStatus = () => {}) {
    this.onStatus = onStatus;
    this.client = null;
    this.timer = null;
    this.busy = false;
    this.trackKey = '';
    this.track = null;
    this.lyrics = { synced: [], plain: [] };
    this.startedAt = 0;
    this.lastActivity = '';
    this.state = 'stopped';
    this.message = 'Berhenti';
    this.output = [];
  }

  status() {
    return {
      state: this.state,
      message: this.message,
      track: this.track ? `${this.track.artist} - ${this.track.title}` : '',
      output: this.output.slice(-8),
    };
  }

  publish(state, message) {
    if (state) this.state = state;
    if (message) this.message = message;
    this.onStatus(this.status());
  }

  log(message) {
    this.output.push(message);
    this.output = this.output.slice(-8);
    this.onStatus(this.status());
  }

  async start(clientId) {
    const id = String(clientId || '').trim();
    if (!/^\d{17,20}$/.test(id)) return { ok: false, error: 'Application ID harus berupa angka 17–20 digit.' };
    if (this.client) return { ok: false, error: 'Rich Presence sudah berjalan.' };

    this.output = [];
    this.publish('starting', 'Menyambungkan ke Discord Desktop…');
    const client = new DiscordRPC.Client({ transport: 'ipc' });
    this.client = client;
    client.on('error', (error) => {
      if (this.client !== client) return;
      this.publish('error', error.message || 'Koneksi RPC gagal.');
      this.log(error.message || 'Koneksi RPC gagal.');
    });
    client.on('disconnected', () => {
      if (this.client !== client) return;
      this.stop('Discord Desktop terputus.');
    });

    try {
      await client.login({ clientId: id });
      if (this.client !== client) return { ok: false, error: 'Koneksi dibatalkan.' };
      this.publish('running', 'Terhubung. Menunggu Spotify…');
      this.log('Terhubung melalui Discord IPC. Token akun tidak digunakan.');
      await this.update();
      this.timer = setInterval(() => this.update(), UPDATE_INTERVAL_MS);
      this.timer.unref();
      return { ok: true, status: this.status() };
    } catch (error) {
      if (this.client === client) this.client = null;
      try { await client.destroy(); } catch {}
      const message = /Could not connect|RPC_CONNECTION_TIMEOUT/i.test(error.message)
        ? 'Discord Desktop tidak terdeteksi. Buka aplikasi Discord Desktop lalu coba lagi.'
        : error.message;
      this.publish('error', message);
      this.log(message);
      return { ok: false, error: message, status: this.status() };
    }
  }

  lyricAt(positionMs) {
    if (this.lyrics.synced.length) {
      let current = '';
      for (const line of this.lyrics.synced) {
        if (positionMs < line.time) break;
        current = line.text;
      }
      return current;
    }
    if (this.lyrics.plain.length) {
      const index = Math.floor(Math.max(0, positionMs) / 4000) % this.lyrics.plain.length;
      return this.lyrics.plain[index];
    }
    return '';
  }

  async update() {
    if (this.busy || !this.client) return;
    this.busy = true;
    try {
      const media = await readMedia();
      if (!this.client) return;
      if (!media) {
        if (this.lastActivity) await this.client.clearActivity();
        this.trackKey = '';
        this.track = null;
        this.lastActivity = '';
        this.publish('running', 'Terhubung. Menunggu Spotify…');
        return;
      }

      const key = `${media.artist}\u0000${media.title}`;
      if (key !== this.trackKey) {
        this.trackKey = key;
        this.track = media;
        this.lyrics = { synced: [], plain: [] };
        this.startedAt = Date.now() - media.positionMs;
        this.log(`Spotify: ${media.artist ? media.artist + ' - ' : ''}${media.title}`);
        fetchLyrics(media.artist, media.title).then((lyrics) => {
          if (this.trackKey !== key) return;
          this.lyrics = lyrics;
          const count = lyrics.synced.length || lyrics.plain.length;
          this.log(count ? `Lirik tersedia (${count} baris).` : 'Lirik tidak ditemukan; judul lagu tetap ditampilkan.');
          this.update();
        });
      } else {
        this.track = media;
      }

      const positionMs = media.positionMs || Math.max(0, Date.now() - this.startedAt);
      const lyric = this.lyricAt(positionMs);
      const details = `${media.artist ? media.artist + ' - ' : ''}${media.title}`.slice(0, 128);
      const state = media.paused ? 'Dijeda' : (lyric || 'Memutar Spotify').slice(0, 128);
      const startTimestamp = new Date(Date.now() - positionMs);
      const activityKey = `${details}\u0000${state}\u0000${media.paused}`;
      if (activityKey !== this.lastActivity) {
        await this.client.setActivity({
          details,
          state,
          startTimestamp,
          endTimestamp: media.durationMs > positionMs
            ? new Date(Date.now() + media.durationMs - positionMs)
            : undefined,
          instance: false,
        });
        this.lastActivity = activityKey;
      }
      this.publish('running', media.paused ? 'Spotify dijeda.' : 'Menampilkan lagu dan lirik di Discord Activity.');
    } catch (error) {
      if (this.client) {
        this.publish('error', error.message || 'Gagal memperbarui Rich Presence.');
        this.log(error.message || 'Gagal memperbarui Rich Presence.');
      }
    } finally {
      this.busy = false;
    }
  }

  async stop(message = 'Rich Presence dihentikan.') {
    clearInterval(this.timer);
    this.timer = null;
    const client = this.client;
    this.client = null;
    this.track = null;
    this.trackKey = '';
    this.lastActivity = '';
    if (client) {
      try { await client.clearActivity(); } catch {}
      try { await client.destroy(); } catch {}
    }
    this.publish('stopped', message);
    this.log(message);
    return { ok: true, status: this.status() };
  }
}

module.exports = { DiscordLyricsPresence, parseLrc, parseBrowserTitle, readMedia, MEDIA_SCRIPT };