/**
 * The `voice-note` audio card renderer: play/pause on the referenced file,
 * duration, backend badge, and the transcript as caption. Pure over
 * `node.data` — the presenter never re-reads audio and never touches session
 * state. When the file is missing or unplayable (the user `rm`'d it, or the
 * host route is absent), the card degrades to a transcript-only card.
 *
 * @module dsh-voice/client/view
 */
import { createElement, useEffect, useRef, useState } from 'react';
import type { ChatNodeViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client';
import { transcriptOnlyCard } from './definition.ts';
import { audioUrlOf } from './types.ts';

/** Format a duration in ms as m:ss. */
export function formatDuration(durationMs: number | undefined): string {
  if (durationMs === undefined || !Number.isFinite(durationMs)) return '';
  const total = Math.round(durationMs / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

/** The audio card for one `voice-note` node. */
export function VoiceNoteView({ node }: ChatNodeViewProps<'voice-note'>): JSX.Element {
  const data = node.data;
  const [playing, setPlaying] = useState(false);
  const [failed, setFailed] = useState(false);
  const player = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    return () => {
      // Unmount never leaves audio playing.
      player.current?.pause();
    };
  }, []);

  const card = failed ? transcriptOnlyCard(data) : data;
  const src = card.audioRef === null ? undefined : audioUrlOf(card.audioRef.path);
  const duration = card.audioRef?.durationMs ?? card.durationMs;

  const toggle = (): void => {
    const el = player.current;
    if (el === null) return;
    if (el.paused) {
      void el.play().catch(() => setFailed(true));
    } else {
      el.pause();
    }
  };

  const directionLabel = card.direction === 'in' ? 'You spoke' : 'Agent spoke';
  const directionGlyph = card.direction === 'in' ? '🎙' : '🔊';

  return createElement(
    'div',
    { style: styles.row },
    src !== undefined
      ? createElement('audio', {
          ref: player,
          src,
          preload: 'none',
          onPlay: () => setPlaying(true),
          onPause: () => setPlaying(false),
          onError: () => setFailed(true),
          onEnded: () => setPlaying(false),
          style: { display: 'none' },
        })
      : null,
    src !== undefined
      ? createElement(
          'button',
          { type: 'button', onClick: toggle, 'aria-label': playing ? 'Pause' : 'Play', style: styles.playButton },
          playing ? '❚❚' : '▶',
        )
      : createElement('span', { style: styles.missing }, '—'),
    createElement(
      'div',
      { style: styles.body },
      createElement(
        'div',
        { style: styles.meta },
        createElement('span', { style: styles.direction }, `${directionGlyph} ${directionLabel}`),
        duration !== undefined ? createElement('span', { style: styles.duration }, formatDuration(duration)) : null,
        createElement('span', { style: styles.badge }, card.backend),
      ),
      createElement('p', { style: styles.transcript }, card.transcript),
    ),
  );
}

const styles: Record<string, React.CSSProperties> = {
  row: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: '10px',
    padding: '10px 12px',
    borderRadius: '10px',
    border: '1px solid var(--dsw-alias-border-l2, rgba(140,155,190,0.22))',
    background: 'var(--dsw-specific-surface-2, rgba(255,255,255,0.03))',
    maxWidth: '560px',
  },
  playButton: {
    flex: 'none',
    width: '34px',
    height: '34px',
    borderRadius: '50%',
    border: '0',
    cursor: 'pointer',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: '12px',
    color: 'var(--dsw-alias-label-primary, #e8edf7)',
    background: 'var(--dsw-alias-accent-strong, #2dd4bf)',
    marginTop: '2px',
  },
  missing: {
    flex: 'none',
    width: '34px',
    height: '34px',
    borderRadius: '50%',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: '12px',
    color: 'var(--dsw-alias-label-tertiary, #8b94a6)',
    border: '1px solid var(--dsw-alias-border-l2, rgba(140,155,190,0.22))',
    marginTop: '2px',
  },
  body: { minWidth: '0', flex: '1' },
  meta: { display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '2px', flexWrap: 'wrap' },
  direction: {
    fontSize: '11px',
    fontWeight: 600,
    letterSpacing: '0.04em',
    textTransform: 'uppercase',
    color: 'var(--dsw-alias-label-tertiary, #8b94a6)',
  },
  duration: {
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    fontSize: '11px',
    color: 'var(--dsw-alias-label-tertiary, #8b94a6)',
  },
  badge: {
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    fontSize: '10px',
    letterSpacing: '0.06em',
    textTransform: 'uppercase',
    padding: '2px 7px',
    borderRadius: '999px',
    color: 'var(--dsw-alias-label-secondary, #c3ccdd)',
    border: '1px solid var(--dsw-alias-border-l2, rgba(140,155,190,0.22))',
  },
  transcript: {
    margin: '0',
    fontSize: '13px',
    lineHeight: '1.45',
    color: 'var(--dsw-alias-label-primary, #e8edf7)',
    overflowWrap: 'anywhere',
  },
};
