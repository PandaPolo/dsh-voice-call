/**
 * dsh-voice client plugin: registers the `voice-note` conversation node
 * Definition and the audio-card renderer into the web chat. Registrations are
 * reversible effects — unloading restores stock rendering.
 *
 * @module @dsh-voice/bundle/client
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client';
import { voiceNoteDefinition } from './definition.ts';
import { VoiceNoteView } from './view.tsx';

/** Services the client plugin needs: the Definition registry and slots. */
export const inject = ['conversationEvents', 'slots'] as const;

/** Mount the node Definition and the chat renderer. */
export function apply(ctx: ClientContext): void {
  ctx.conversationEvents.register(voiceNoteDefinition);
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
    name: 'conversation.chat.node',
    key: 'voice-note',
    // The chat-node slot's `t` seat is typed to the ui-conversation namespace.
    locale: 'conversation',
  }, VoiceNoteView));
}
