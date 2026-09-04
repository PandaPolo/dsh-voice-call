/**
 * dsh-voice client plugin: registers the `voice-note` conversation node
 * Definition and the audio-card renderer into the web chat. Registrations are
 * reversible effects — unloading restores stock rendering.
 *
 * The slot service's public typing is not re-exported through the client
 * packages, so this mirrors the host's `webServer` seam elsewhere in the
 * plugin: a structural cast over `ctx.get('slots')`. The runtime shape is
 * pinned by the host's own browser bundles (workflow-run registers its chat
 * node through the exact same two calls).
 *
 * @module @dsh-voice/bundle/client
 */
import type { Context } from '@deepseek-ai/cordis';
import { voiceNoteDefinition } from './definition.ts';
import { VoiceNoteView } from './view.tsx';

/** Services the client plugin needs: the Definition registry and slots. */
export const inject = ['uiConversation', 'slots'] as const;

/** Structural view of the `slots` service (browser slot registry). */
interface SlotRegistry {
  register(meta: { readonly name: string; readonly key: string; readonly locale?: string }, component: unknown): void;
  inject(name: string, contributor: () => void): () => void;
}

/** Mount the node Definition and the chat renderer. */
export function apply(ctx: Context): void {
  ctx.uiConversation.events.register(voiceNoteDefinition);
  const slots = ctx.get('slots') as SlotRegistry | undefined;
  if (slots === undefined) return;
  slots.inject('conversation.chat.node', () => slots.register({
    name: 'conversation.chat.node',
    key: 'voice-note',
    // The chat-node slot's `t` seat is typed to the ui-conversation namespace.
    locale: 'conversation',
  }, VoiceNoteView));
}
