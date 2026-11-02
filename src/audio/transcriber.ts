export interface Transcriber {
  transcribe(audio: Buffer, mime: string): Promise<string>;
}

const EXT: Record<string, string> = {
  'audio/ogg': 'ogg',
  'audio/opus': 'ogg',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/mp4': 'm4a',
  'audio/m4a': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/aac': 'aac',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/webm': 'webm',
  'audio/flac': 'flac',
  'audio/amr': 'amr',
};

/** Mime sem parâmetros (`audio/ogg; codecs=opus` vira `audio/ogg`). */
export function baseMime(mime: string): string {
  return mime.split(';')[0]!.trim().toLowerCase();
}

export function audioFileName(mime: string): string {
  return `audio.${EXT[baseMime(mime)] ?? 'bin'}`;
}

export const OPENAI_TRANSCRIBE_URL = 'https://api.openai.com/v1/audio/transcriptions';

/** Serve para a OpenAI e para qualquer provedor com a mesma interface de transcrição (ex.: Groq), trocando `url` e `model`. */
export function createOpenAITranscriber(o: { apiKey: string; model: string; url?: string; fetch?: typeof fetch }): Transcriber {
  const doFetch = o.fetch ?? fetch;
  return {
    async transcribe(audio, mime) {
      const base = baseMime(mime);
      const form = new FormData();
      form.set('model', o.model);
      form.set('language', 'pt');
      form.set('file', new Blob([new Uint8Array(audio)], { type: base }), audioFileName(base));
      const res = await doFetch(o.url ?? OPENAI_TRANSCRIBE_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${o.apiKey}` },
        body: form,
      });
      if (!res.ok) throw new Error(`transcrição falhou: HTTP ${res.status}`);
      const json = (await res.json()) as { text?: unknown };
      return typeof json.text === 'string' ? json.text : '';
    },
  };
}
