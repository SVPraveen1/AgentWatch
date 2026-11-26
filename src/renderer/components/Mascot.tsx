import React, { useEffect, useRef, useState } from 'react';
import type { SessionRecord } from '../../shared/types';
import './mascot.css';

export type MascotMood = 'sleeping' | 'working' | 'alert' | 'cheer';

export function deriveMascotMood(params: {
  sessions: SessionRecord[];
  pendingCount: number;
  lastTurnFinishedAt: number;
  now?: number;
}): MascotMood {
  const now = params.now ?? Date.now();
  if (
    params.pendingCount > 0 ||
    params.sessions.some((s) => s.state === 'needs_you' || s.state === 'error')
  ) {
    return 'alert';
  }
  if (now - params.lastTurnFinishedAt < 3000) {
    return 'cheer';
  }
  if (params.sessions.some((s) => s.state === 'working')) {
    return 'working';
  }
  return 'sleeping';
}

export interface MascotProps {
  mood: MascotMood;
  visible: boolean;
  reduceMotion: boolean;
  size?: number;
}

/**
 * Original geometric beacon-bot mascot ("Pip") rendered in crisp inline SVG.
 * Uses GPU-composited CSS transforms and throttled cursor eye-tracking.
 */
export const Mascot: React.FC<MascotProps> = ({
  mood,
  visible,
  reduceMotion,
  size = 24,
}) => {
  const [blinking, setBlinking] = useState(false);
  const [clicked, setClicked] = useState(false);
  const [occasionalCheer, setOccasionalCheer] = useState(false);
  const [pupilOffset, setPupilOffset] = useState({ x: 0, y: 0 });
  const rootRef = useRef<HTMLDivElement | null>(null);

  const animationsPaused = !visible || reduceMotion;

  // Random blinking while awake and visible
  useEffect(() => {
    if (animationsPaused || mood === 'sleeping') {
      setBlinking(false);
      return;
    }
    let timer: ReturnType<typeof setTimeout>;
    let endTimer: ReturnType<typeof setTimeout>;

    const scheduleBlink = () => {
      const delay = 2600 + Math.floor(Math.random() * 2800);
      timer = setTimeout(() => {
        setBlinking(true);
        endTimer = setTimeout(() => {
          setBlinking(false);
          scheduleBlink();
        }, 140);
      }, delay);
    };
    scheduleBlink();
    return () => {
      clearTimeout(timer);
      clearTimeout(endTimer);
    };
  }, [animationsPaused, mood]);

  // Occasional spontaneous cheer while working
  useEffect(() => {
    if (animationsPaused || mood !== 'working') return;
    const id = setInterval(() => {
      setOccasionalCheer(true);
      setTimeout(() => setOccasionalCheer(false), 750);
    }, 22_000);
    return () => clearInterval(id);
  }, [animationsPaused, mood]);

  // Throttled global cursor tracking while visible (no polling when hidden or sleeping)
  useEffect(() => {
    if (animationsPaused || mood === 'sleeping' || !window.agentwatch?.getCursorPosition) {
      setPupilOffset({ x: 0, y: 0 });
      return;
    }
    let active = true;
    const poll = async () => {
      try {
        const pt = await window.agentwatch!.getCursorPosition();
        if (!active) return;
        const maxOffset = 2.0;
        // x, y returned by IPC are relative to overlay top-center when available, else screen deltas.
        const dx = Math.max(-1, Math.min(1, pt.x / 240));
        const dy = Math.max(-1, Math.min(1, pt.y / 240));
        setPupilOffset({
          x: Number((dx * maxOffset).toFixed(2)),
          y: Number((dy * maxOffset).toFixed(2)),
        });
      } catch {
        // Ignore IPC errors during close.
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), 90);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [animationsPaused, mood]);

  const effectiveMood: MascotMood = occasionalCheer ? 'cheer' : mood;
  const bodyColor =
    effectiveMood === 'alert'
      ? 'var(--status-needs-you)'
      : effectiveMood === 'cheer'
        ? 'var(--status-done)'
        : effectiveMood === 'working'
          ? 'var(--accent-primary)'
          : 'var(--text-muted)';

  const moodClass = clicked
    ? 'aw-mascot--clicked'
    : effectiveMood === 'cheer'
      ? 'aw-mascot--cheer'
      : effectiveMood === 'alert'
        ? 'aw-mascot--alert'
        : effectiveMood === 'working'
          ? 'aw-mascot--working'
          : '';

  return (
    <div
      ref={rootRef}
      role="img"
      aria-label={`AgentWatch mascot (${effectiveMood})`}
      className={`aw-mascot ${moodClass} ${animationsPaused ? 'aw-mascot--paused' : ''}`}
      onClick={(e) => {
        e.stopPropagation();
        if (reduceMotion) return;
        setClicked(true);
        setTimeout(() => setClicked(false), 460);
      }}
      style={{ width: size, height: size }}
    >
      <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden="true">
        {/* Signal antenna */}
        <line x1="16" y1="7" x2="16" y2="3" stroke={bodyColor} strokeWidth="2" strokeLinecap="round" />
        <circle cx="16" cy="2.6" r="2" fill={bodyColor} />

        {/* Cheer sparkles */}
        {effectiveMood === 'cheer' && !reduceMotion && (
          <>
            <path d="M5 9L7 11M27 9L25 11" stroke="var(--status-done)" strokeWidth="1.8" strokeLinecap="round" />
            <circle cx="4.5" cy="14" r="1.2" fill="var(--status-done)" />
            <circle cx="27.5" cy="14" r="1.2" fill="var(--status-done)" />
          </>
        )}

        {/* Alert halo */}
        {effectiveMood === 'alert' && (
          <circle cx="16" cy="18" r="12" stroke="var(--status-needs-you)" strokeWidth="1.4" strokeDasharray="3 2" opacity="0.7" />
        )}

        {/* Rounded hexagonal-pill chassis (original character silhouette) */}
        <rect
          x="5"
          y="7"
          width="22"
          height="20"
          rx="8"
          fill="var(--bg-surface-elevated)"
          stroke={bodyColor}
          strokeWidth="2"
        />

        {/* Side ear-fin accents */}
        <rect x="2.5" y="14" width="2.5" height="6" rx="1.2" fill={bodyColor} />
        <rect x="27" y="14" width="2.5" height="6" rx="1.2" fill={bodyColor} />

        {/* Visor */}
        <rect x="8.5" y="12" width="15" height="8" rx="4" fill="var(--bg-canvas)" />

        {/* Eyes */}
        {effectiveMood === 'sleeping' ? (
          <>
            <path d="M10.5 16 Q12.2 17.6 14 16" stroke="var(--text-secondary)" strokeWidth="1.6" strokeLinecap="round" />
            <path d="M18 16 Q19.8 17.6 21.5 16" stroke="var(--text-secondary)" strokeWidth="1.6" strokeLinecap="round" />
            {!reduceMotion && (
              <text x="24" y="9" fontSize="6" fontWeight="700" fill="var(--text-muted)" className="aw-mascot-zzz">
                z
              </text>
            )}
          </>
        ) : blinking ? (
          <>
            <line x1="10.5" y1="16" x2="14" y2="16" stroke="var(--text-primary)" strokeWidth="1.8" strokeLinecap="round" />
            <line x1="18" y1="16" x2="21.5" y2="16" stroke="var(--text-primary)" strokeWidth="1.8" strokeLinecap="round" />
          </>
        ) : (
          <>
            <circle
              cx={12.3 + pupilOffset.x}
              cy={16 + pupilOffset.y}
              r={effectiveMood === 'alert' ? 2.1 : 1.7}
              fill={effectiveMood === 'alert' ? 'var(--status-needs-you)' : 'var(--text-primary)'}
            />
            <circle
              cx={19.7 + pupilOffset.x}
              cy={16 + pupilOffset.y}
              r={effectiveMood === 'alert' ? 2.1 : 1.7}
              fill={effectiveMood === 'alert' ? 'var(--status-needs-you)' : 'var(--text-primary)'}
            />
          </>
        )}

        {/* Mouth expression */}
        {effectiveMood === 'cheer' || clicked ? (
          <path d="M13 22.5 Q16 25 19 22.5" stroke={bodyColor} strokeWidth="1.6" strokeLinecap="round" />
        ) : effectiveMood === 'alert' ? (
          <circle cx="16" cy="23.2" r="1.3" fill="var(--status-needs-you)" />
        ) : (
          <line x1="14" y1="23" x2="18" y2="23" stroke="var(--text-muted)" strokeWidth="1.4" strokeLinecap="round" />
        )}
      </svg>
    </div>
  );
};
