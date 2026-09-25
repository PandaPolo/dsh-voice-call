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
import { mountCallCard } from './callcard.tsx';
import { BUNDLE_NAME, VoiceCallSettingsCard } from './settings.tsx';
import { voiceNoteDefinition } from './definition.ts';
import { VoiceNoteView } from './view.tsx';

/** Services the client plugin needs: the Definition registry and slots. */
export const inject = ['uiConversation', 'slots'] as const;

/** The client-side config-form service, over the face this plugin uses. */
interface ConfigFormsService {
  get(entryId: string): import('./settings.tsx').ConfigFormHandle;
}

/** Structural view of the `slots` service (browser slot registry). */
interface SlotRegistry {
  register(meta: {
    readonly name: string;
    readonly key: string;
    readonly locale?: string;
    /** Values merged into the contribution's props on every render. */
    readonly inject?: () => unknown;
  }, component: unknown): void;
  inject(name: string, contributor: () => void): () => void;
}

/** Mount the node Definition, the chat renderer, and the v0.2 call-card overlay. */
export function apply(ctx: Context): void {
  ctx.uiConversation.events.register(voiceNoteDefinition);
  const slots = ctx.get('slots') as SlotRegistry | undefined;
  if (slots !== undefined) {
    slots.inject('conversation.chat.node', () => slots.register({
      name: 'conversation.chat.node',
      key: 'voice-note',
      // The chat-node slot's `t` seat is typed to the ui-conversation namespace.
      locale: 'conversation',
    }, VoiceNoteView));
  }
  // The call-card overlay rides its own transport (`/voice/call` routes); it
  // degrades independently — no webserver routes, no card, v0.1 keeps working.
  ctx.effect(() => mountCallCard(), 'call-card overlay');
  // The plugin page's configuration card, keyed by this bundle's package name.
  // It rides `ctx.inject(['configForms'])` for the same reason the web routes do
  // on the server: the settings service may boot after this bundle, and a host
  // without a settings UI must simply never show the card. The card takes its
  // write handle from that service because the host renders this slot without
  // one (see `settings.tsx`).
  ctx.inject(['configForms'], (scoped) => {
    const forms = (scoped as unknown as { configForms?: ConfigFormsService }).configForms;
    const slotsOfScoped = (scoped as unknown as { slots?: SlotRegistry }).slots ?? slots;
    if (forms === undefined || slotsOfScoped === undefined) return;
    try {
      const handle = forms.get(BUNDLE_NAME);
      slotsOfScoped.inject('plugins.bundle.config', () => slotsOfScoped.register({
        name: 'plugins.bundle.config',
        key: BUNDLE_NAME,
        inject: () => ({ configForm: handle }),
      }, VoiceCallSettingsCard));
    } catch (error) {
      console.warn('dsh-voice-call: the host has no plugin configuration slot — settings card disabled', error);
    }
  });
}
