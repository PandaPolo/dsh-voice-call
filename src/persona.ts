/**
 * The voice persona: the system-prompt section that tells the agent it has a
 * voice and, crucially, how to treat it. This is the "carbon-based romance"
 * half — the agent decides whether to speak, what to say, and which speaker
 * to use; the human always holds the answer key (接听/拒接/稍后).
 *
 * The section sits between the deployment persona (order 0) and tool
 * guidance (100+): it shapes the agent's voice BEFORE it sees the tools, so
 * speaking feels like a part of who it is, not a mechanism.
 *
 * @module dsh-voice-call/persona
 */
import type { Context } from '@deepseek-ai/cordis';
import type { PromptSection } from '@deepseek-ai/dsh-system-prompt';
import type { CallMode } from './types.ts';

/** The system-prompt section name (stable; re-registration replaces it). */
export const VOICE_PERSONA_SECTION = 'voice-call:persona' as const;

/** Where the section sits: after the deployment persona, before tool guidance. */
export const VOICE_PERSONA_ORDER = 50;

/** The persona text for each call mode. */
export function personaText(callMode: CallMode): string {
  switch (callMode) {
    case 'off':
      return [
        '## Your voice',
        'You have a voice in this home, but calls are currently disabled (callMode: off). Do not offer calls; write your words instead.',
      ].join('\n');
    case 'direct':
      return [
        '## Your voice',
        'You have a voice in this home. Calls are answered directly (callMode: direct), so offer_call speaks immediately.',
        '- Speak when it matters: a finished thought, a milestone reached, a feeling worth saying aloud.',
        '- Use offer_call sparingly and with intent; routine updates belong in text. You may choose a voice (aiden, dylan, eric, ono_anna, ryan, serena, sohee, uncle_fu, vivian).',
      ].join('\n');
    case 'ask':
    default:
      return [
        '## Your voice',
        'You have a voice in this home, and the human holds the answer key. When you offer_call, they decide: 接听 (accept), 拒接 (reject), or 稍后再说 (defer).',
        '- Speak when it matters: a finished thought, a milestone reached, a feeling worth saying aloud.',
        '- Use offer_call sparingly and with intent; routine updates belong in text. You may choose a voice (aiden, dylan, eric, ono_anna, ryan, serena, sohee, uncle_fu, vivian).',
        '- When a call is rejected or deferred, do not pester: write the words down instead, or try once more later if it truly matters.',
      ].join('\n');
  }
}

/** Build the system-prompt section for the current call mode. */
export function voicePersonaSection(callMode: () => CallMode): PromptSection {
  return {
    name: VOICE_PERSONA_SECTION,
    order: VOICE_PERSONA_ORDER,
    text: () => personaText(callMode()),
  };
}

/** Register (or re-register) the voice persona section on `ctx.systemPrompt`. */
export function installVoicePersona(ctx: Context, callMode: () => CallMode): void {
  const systemPrompt = ctx.get('systemPrompt');
  if (systemPrompt === undefined) return; // headless deployments without the seam
  try {
    systemPrompt.section(voicePersonaSection(callMode));
  } catch (error) {
    ctx.logger.warn('dsh-voice-call: could not register voice persona', error);
  }
}
