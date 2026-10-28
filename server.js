const express = require('express');
const cors = require('cors');
const { exec } = require('child_process');
const https = require('https');
const http = require('http');
const fs = require('fs');

const app = express();
app.use(cors());

const PORT = process.env.PORT || 7860;
const urlCache = new Map();

// Filtro estricto de pistas no musicales y formatos no deseados
const BAD = [
  'mix', 'mashup', 'compilation', 'medley', 'megamix', 'hours', 'hora', 'horas',
  'extended', 'full album', 'playlist', 'non stop', 'nonstop', 'continuous',
  '1 hour', '2 hours', '3 hours', '10 hours', 'loop', 'bass boosted',
  'podcast', 'episodio', 'episode', 'review', 'tutorial', 'gameplay', 'walkthrough',
  'reaccion', 'reaction', 'directo', 'livestream', 'stream', 'en vivo', 'live stream',
  'entrevista', 'interview', 'unboxing', 'meme', 'asmr', 'documentary', 'documental',
  'audiobook', 'audiolibro', 'parodia', 'parody', 'bloopers', 'trailer', 'teaser',
  'sound effect', 'sfx', 'ringtone', 'shorts', 'tiktok', 'preview', 'snippet'
];

function getAudioUrl(videoId, cb) {
  const cookiePath = fs.existsSync('cookies.txt') ? '--cookies cookies.txt' : '';
  
  // Emulación de cliente móvil Android/iOS (igual que Metrolist / NewPipe) para saltar bloqueos de IP
  const cmdAndroid = `yt-dlp ${cookiePath} --extractor-args "youtube:player_client=ios,android,web" -f "ba/b" -g "https://www.youtube.com/watch?v=${videoId}"`;

  exec(cmdAndroid, (err, stdout) => {
    if (!err && stdout && stdout.trim()) {
      const url = stdout.trim().split('\n')[0];
      return cb(null, url);
    }

    // Fallback estándar con cookies
    const cmdStandard = `yt-dlp ${cookiePath} -f "bestaudio/best" -g "https://www.youtube.com/watch?v=${videoId}"`;
    exec(cmdStandard, (err2, stdout2) => {
      if (err2 || !stdout2 || !stdout2.trim()) {
        console.error('Error al resolver audio:', err2 ? err2.message : 'Sin URL');
        return cb(err2 || new Error('No se pudo extraer el audio'));
      }
      cb(null, stdout2.trim().split('\n')[0]);
    });
  });
}

// Health check para saber si la máquina virtual está activa
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    service: 'Neon Dash YouTube Cloud Backend',
    uptime: Math.round(process.uptime()) + 's',
    port: PORT
  });
});

app.get('/health', (req, res) => res.send('OK'));

app.get('/api/search', (req, res) => {
  const q = req.query.q;
  if (!q) return res.status(400).json({ error: 'Falta parámetro q' });

  // Búsqueda en YouTube Music con ytsearch
  const cookiePath = fs.existsSync('cookies.txt') ? '--cookies cookies.txt' : '';
  const searchCmd = `yt-dlp ${cookiePath} --extractor-args "youtube:player_client=ios,android,web" "ytsearch15:${q}" --flat-playlist --dump-json --no-warnings`;

  exec(searchCmd, { maxBuffer: 1024 * 1024 * 10 }, (err, stdout) => {
    if (err) {
      console.error('Error en búsqueda:', err.message);
      return res.status(500).json({ error: 'Error en búsqueda' });
    }

    const lines = stdout.trim().split('\n');
    const results = lines.map(line => {
      try {
        const d = JSON.parse(line);
        const t = (d.title || '').toLowerCase();
        
        // REGLA CRÍTICA: Filtrar duraciones que no sean canciones completas (60s a 360s)
        if (d.duration && (d.duration < 60 || d.duration > 360)) return null;
        if (BAD.some(w => t.includes(w))) return null;

        const uploader = (d.uploader || d.channel || '').trim();
        const uploaderLower = uploader.toLowerCase();

        // Detección de pistas oficiales (Topic de YouTube Music, Vevo o Audio Oficial)
        const isOfficial = uploader.endsWith(' - Topic') ||
                           uploaderLower.includes('vevo') ||
                           t.includes('official audio') ||
                           t.includes('official music video') ||
                           Boolean(d.track && d.artist);

        let thumb = d.thumbnail;
        if (d.thumbnails && d.thumbnails.length) {
          thumb = d.thumbnails[d.thumbnails.length - 1].url;
        }

        return {
          id: d.id,
          title: d.title,
          artist: uploader || 'YouTube Music',
          thumbnail: thumb,
          duration: d.duration,
          isOfficial: Boolean(isOfficial),
          source: 'youtube'
        };
      } catch (e) {
        return null;
      }
    }).filter(Boolean);

    // Priorizar pistas oficiales al principio
    results.sort((a, b) => (b.isOfficial ? 1 : 0) - (a.isOfficial ? 1 : 0));

    // Precaché del primer resultado para arranque instantáneo
    if (results[0]) {
      const firstId = results[0].id;
      if (!urlCache.has(firstId)) {
        getAudioUrl(firstId, (e, u) => {
          if (!e && u) urlCache.set(firstId, { url: u, t: Date.now() });
        });
      }
    }

    res.json({ results });
  });
});

function handleStream(req, res) {
  const id = req.params.id || req.query.id;
  if (!id) return res.status(400).json({ error: 'Falta id' });

  // Cache en memoria por 2 horas
  if (urlCache.has(id)) {
    const c = urlCache.get(id);
    if (Date.now() - c.t < 2 * 3600 * 1000) {
      return proxyStream(c.url, req, res);
    }
    urlCache.delete(id);
  }

  getAudioUrl(id, (err, url) => {
    if (err || !url) return res.status(500).json({ error: 'Error extrayendo stream' });
    urlCache.set(id, { url, t: Date.now() });
    proxyStream(url, req, res);
  });
}

app.get('/api/stream/:id', handleStream);
app.get('/api/stream', handleStream);

function proxyStream(url, req, res) {
  const client = url.startsWith('https') ? https : http;
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
  };
  if (req.headers.range) headers['Range'] = req.headers.range;

  client.get(url, { headers }, upstream => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Range, Accept');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges');
    if (upstream.headers['content-type']) res.setHeader('Content-Type', upstream.headers['content-type']);
    if (upstream.headers['content-length']) res.setHeader('Content-Length', upstream.headers['content-length']);
    if (upstream.headers['content-range']) res.setHeader('Content-Range', upstream.headers['content-range']);
    if (upstream.headers['accept-ranges']) res.setHeader('Accept-Ranges', upstream.headers['accept-ranges']);
    res.status(upstream.statusCode);
    upstream.pipe(res);
  }).on('error', err => {
    console.error('proxyStream error:', err.message);
    if (!res.headersSent) res.status(500).end();
  });
}

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Neon Dash Cloud Backend corriendo 24/7 en puerto ${PORT}`);
});
