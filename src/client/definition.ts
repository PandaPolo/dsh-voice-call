/**
 * The `voice-note` conversation node Definition — the pure, replay-safe half
 * of the audio card. Single-event business: `noteId` is the stable
 * Definition-local id and there are no update events in v0.1, so `start`
 * adopts the full state and `update` never fires. `buildViewNode` consumes
 * only `context.state`; the presenter is pure over the ref + transcript, so
 * replay reproduces the card without re-reading audio. A missing or deleted
 * audio file degrades to a transcript-only card (the ref is dropped by
 * {@link transcriptOnlyCard} when playback fails at runtime).
 *
 * @module dsh-voice/client/definition
 */
import type { SessionEventLike } from '@deepseek-ai/dsh-api-session-controller/client';
import type { ChatConversationViewNode } from '@deepseek-ai/dsh-client-ui-chat/client';
import type {
  ConversationLocation,
  ConversationNodeContext,
  ConversationNodeDefinition,
} from '@deepseek-ai/dsh-client-ui-conversation/client';
import type { VoiceNoteCardData, VoiceNoteEventData } from './types.ts';

/** The `voice-note` chat node payload, registered into the UI payload map. */
export interface VoiceNoteChatData extends VoiceNoteCardData {}

declare module '@deepseek-ai/dsh-client-ui-chat/client' {
  interface ChatNodeDataMap {
    'voice-note': VoiceNoteChatData;
  }
}

declare module '@deepseek-ai/dsh-client-ui-conversation/client' {
  interface ConversationStepDataMap {
    'voice-note': VoiceNoteChatData;
  }
}

/** Engine State for one note: the card payload plus its log coordinates. */
export interface VoiceNoteState extends VoiceNoteCardData {
  readonly turn: number;
  readonly step: number;
}

/** The Definition-local stable identity of one `voice/note` event. */
export function noteIdOf(event: SessionEventLike): string | null {
  if (event.type !== 'voice/note') return null;
  const data = event.data as unknown as VoiceNoteEventData;
  return String(data.noteId);
}

/** Resolve the engine-owned location of a Context (start match preferred). */
export function locationOf(context: ConversationNodeContext<VoiceNoteState>): ConversationLocation {
  return context.start?.location ?? context.matches[0]?.location ?? { kind: 'unresolved' };
}

/** Project engine State to the renderer payload (pure). */
export function viewData(state: VoiceNoteState): VoiceNoteChatData {
  return {
    noteId: state.noteId,
    direction: state.direction,
    transcript: state.transcript,
    backend: state.backend,
    audioRef: state.audioRef,
    ...(state.durationMs !== undefined ? { durationMs: state.durationMs } : {}),
  };
}

/** The degraded card: audio dropped, transcript retained. Pure. */
export function transcriptOnlyCard(data: VoiceNoteChatData): VoiceNoteChatData {
  return { ...data, audioRef: null };
}

/** The `voice-note` Definition — one start event per note, no updates. */
export const voiceNoteDefinition: ConversationNodeDefinition<VoiceNoteState> = {
  kind: 'voice-note',
  target: 'chat',
  match: (event) => {
    const id = noteIdOf(event);
    if (id === null) return null;
    return { id, role: 'start' };
  },
  start: (_context, match) => {
    if (match.event.type !== 'voice/note') throw new Error('voice-note requires voice/note');
    const data = match.event.data as unknown as VoiceNoteEventData;
    const audioRef = {
      path: data.audioRef.path,
      mime: data.audioRef.mime,
      ...(data.audioRef.durationMs !== undefined ? { durationMs: data.audioRef.durationMs } : {}),
    };
    return {
      noteId: data.noteId,
      turn: data.turn,
      step: data.step,
      direction: data.direction,
      transcript: data.transcript,
      backend: data.backend,
      audioRef,
      ...(data.audioRef.durationMs !== undefined ? { durationMs: data.audioRef.durationMs } : {}),
    };
  },
  update: (context) => context.state,
  publication: () => 'immediate',
  buildLocationData: (context, scope) => {
    if (scope !== 'step' || context.state === undefined) return null;
    return {
      kind: 'step',
      turn: context.state.turn,
      step: context.state.step,
      key: 'voice-note',
      value: viewData(context.state),
    };
  },
  buildViewNode: (context): ChatConversationViewNode | null => {
    if (context.state === undefined) return null;
    return {
      key: context.key,
      kind: 'voice-note',
      id: context.id,
      target: 'chat',
      anchorSeq: context.start?.event.seq ?? context.matches[0]?.event.seq ?? 0,
      location: locationOf(context),
      visibility: 'visible',
      data: viewData(context.state),
    };
  },
};
