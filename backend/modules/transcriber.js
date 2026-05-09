'use strict';

const fs   = require('fs');
const path = require('path');

const OPENAI_TRANSCRIBE = 'https://api.openai.com/v1/audio/transcriptions';

function toSrtTime(sec) {
  const h  = Math.floor(sec / 3600);
  const m  = Math.floor((sec % 3600) / 60);
  const s  = Math.floor(sec % 60);
  const ms = Math.round((sec % 1) * 1000);
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')},${String(ms).padStart(3,'0')}`;
}

function toVttTime(sec) {
  return toSrtTime(sec).replace(',', '.');
}

function generateSrt(segments) {
  return segments.map((seg, i) => {
    const text = seg.text.trim();
    return `${i + 1}\n${toSrtTime(seg.start)} --> ${toSrtTime(seg.end)}\n${text}`;
  }).join('\n\n') + '\n';
}

function generateVtt(segments) {
  const lines = ['WEBVTT', ''];
  segments.forEach((seg, i) => {
    lines.push(`${i + 1}`);
    lines.push(`${toVttTime(seg.start)} --> ${toVttTime(seg.end)}`);
    lines.push(seg.text.trim());
    lines.push('');
  });
  return lines.join('\n');
}

async function transcribeFile(filePath, language = 'pt') {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY não configurada. Adicione no Railway.');

  const fileBuffer = fs.readFileSync(filePath);
  const fileName   = path.basename(filePath);
  const ext        = path.extname(fileName).toLowerCase().replace('.', '');
  const mimeTypes  = { mp3:'audio/mpeg', mp4:'video/mp4', m4a:'audio/mp4', wav:'audio/wav', ogg:'audio/ogg', webm:'audio/webm', oga:'audio/ogg' };
  const mimeType   = mimeTypes[ext] || 'application/octet-stream';

  const form = new FormData();
  form.append('file', new Blob([fileBuffer], { type: mimeType }), fileName);
  form.append('model', 'whisper-1');
  form.append('response_format', 'verbose_json');
  form.append('language', language);
  form.append('timestamp_granularities[]', 'segment');

  const res  = await fetch(OPENAI_TRANSCRIBE, {
    method : 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body   : form
  });

  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || `Whisper API erro ${res.status}`);

  const segments          = data.segments || [];
  const text              = data.text     || segments.map(s => s.text).join(' ');
  const duration          = data.duration || (segments.length ? segments[segments.length - 1].end : 0);
  const language_detected = data.language || language;

  return {
    text,
    language : language_detected,
    duration : Math.round(duration),
    segments,
    srt      : segments.length ? generateSrt(segments) : null,
    vtt      : segments.length ? generateVtt(segments) : null,
    wordCount: text.split(/\s+/).filter(Boolean).length
  };
}

module.exports = { transcribeFile };
