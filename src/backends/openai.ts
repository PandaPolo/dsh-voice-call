/**
 * The OpenAI-compatible `whisper-1` STT backend — the sole STT path that
 * sends audio off-machine, and only when the user configures it. Reads the
 * API key through the standard credential seam (the same
 * `OPENAI_API_KEY`-style reference a polyglot preset would use), falling back
 * to the launching environment when no credentials service is mounted.
 *
 * @module dsh-voice/backends/openai
 */
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import { credentialRef } from '@deepseek-ai/dsh-credentials';
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment';
import type { SttBackend, SttOutcome } from './types.ts';

/** Resolve the API key for a credential reference, or undefined when absent. */
export async function resolveApiKey(ctx: Context, ref: string): Promise<string | undefined> {
  const credentials = ctx.get('credentials');
  if (credentials !== undefined) {
    const hit = await credentials.resolve(credentialRef(ref));
    if (hit !== undefined && hit.value !== '') return hit.value;
    return undefined;
  }
  const ambient = launchEnvironmentOf(ctx).get(ref);
  if (ambient !== undefined && ambient.value !== '') return ambient.value;
  return undefined;
}

/** The OpenAI-compatible whisper-1 speech-to-text backend. */
export class OpenAiSttBackend implements SttBackend {
  readonly id = 'openai' as const;

  private readonly ctx: Context;
  private readonly options: {
    readonly baseUrl: string;
    readonly apiKeyEnv: string;
    readonly model: string;
    readonly fetchImpl?: typeof fetch;
  };

  constructor(
    ctx: Context,
    options: {
      readonly baseUrl: string;
      readonly apiKeyEnv: string;
      readonly model: string;
      readonly fetchImpl?: typeof fetch;
    },
  ) {
    this.ctx = ctx;
    this.options = options;
  }

  async transcribe(file: string, signal?: AbortSignal): Promise<SttOutcome> {
    const key = await resolveApiKey(this.ctx, this.options.apiKeyEnv);
    if (key === undefined) {
      throw new Error(`openai: no API key for ${this.options.apiKeyEnv} — store it through the credentials service or export it in the launching environment`);
    }
    const bytes = await readFile(file);
    const form = new FormData();
    form.append('file', new Blob([bytes]), basename(file));
    form.append('model', this.options.model);
    const fetchImpl = this.options.fetchImpl ?? fetch;
    const response = await fetchImpl(`${this.options.baseUrl.replace(/\/$/, '')}/audio/transcriptions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}` },
      body: form,
      signal,
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`openai: transcription failed (HTTP ${response.status})${detail !== '' ? `: ${detail.slice(0, 300)}` : ''}`);
    }
    const data = (await response.json()) as { text?: unknown };
    if (typeof data.text !== 'string' || data.text.trim() === '') {
      throw new Error('openai: transcription returned no text');
    }
    return { transcript: data.text.trim(), backend: this.id, detail: this.options.model };
  }
}
