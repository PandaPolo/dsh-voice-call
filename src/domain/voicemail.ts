/**
 * FUTURE voicemail domain (v0.3): missed calls left as messages the human can
 * replay, plus the read-receipt back-channel that tells the agent the human
 * actually listened. RESERVED in v0.1 — the interfaces below are the upgrade
 * contract; nothing is implemented until the voicemail feature lands.
 *
 * Storage layout (stable across versions):
 *
 *   ~/.dsh/voice/
 *     calls/<callId>.wav        # the synthesized message
 *     voicemail.json            # index: callId → {text, voice, savedAt, readAt}
 *
 * The index file is append-friendly JSON so a v0.3 upgrade can read v0.1-era
 * audio files if they were left in place (they always are — audio is plain
 * files and never deleted by the plugin).
 *
 * @module dsh-voice-call/domain/voicemail
 */

/** One saved voicemail entry. */
export interface VoicemailEntry {
  readonly callId: string;
  readonly text: string;
  readonly voice: string;
  readonly savedAt: number;
  /** Set once the human has played the message (the read receipt). */
  readonly readAt?: number;
}

/** The voicemail store contract (implemented in v0.3). */
export interface VoicemailStore {
  /** Save one missed call as a voicemail entry. */
  save(entry: VoicemailEntry): Promise<void>;
  /** List all saved messages, newest first. */
  list(): Promise<readonly VoicemailEntry[]>;
  /** Mark one message as read; returns false when unknown. */
  markRead(callId: string, at?: number): Promise<boolean>;
  /** Whether the store has any unread messages. */
  hasUnread(): Promise<boolean>;
}

/** The voicemail index file name under the audio root (stable). */
export const VOICEMAIL_INDEX = 'voicemail.json' as const;

/** The voicemail audio subdirectory under the audio root (stable). */
export const VOICEMAIL_DIR = 'calls' as const;
