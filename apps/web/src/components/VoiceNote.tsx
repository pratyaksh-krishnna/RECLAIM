import { useEffect, useRef, useState } from 'react';
import { Loader2, Lock, Pause, Play } from 'lucide-react';
import { fetchAudioObjectUrl } from '../lib/api';
import { cn } from '../lib/cn';
import { Eyebrow, Tooltip } from './ui/primitives';

/* -------------------------------------------------------------------------- */
/*  Provenance                                                                */
/* -------------------------------------------------------------------------- */

/**
 * The values the server injects, in both the written and the spoken register.
 *
 * The written half (₹2,499.00, a URL, inv_d4c775ba-254, a date) is what the
 * email body carries. The spoken half exists because the same values are said
 * differently: formatINRForSpeech drops the glyph and the decimal, and
 * formatInvoiceRefForSpeech says "ending 254", because a synthesiser misreads
 * the first and no listener can hold the second. Without the spoken patterns a
 * transcript would render with no provenance marking at all, in a console whose
 * whole job is saying who produced what.
 *
 * The "ending …" pattern requires a digit, so an agent writing "ending soon" is
 * not mistaken for a server value — and the free-slot lint bans digits in agent
 * text outright, so anything numeric here came from the server.
 */
const IMMUTABLE = String.raw`₹[\d,.]+|https?:\/\/\S+|(?:INV|inv)[-_]\S+|\d{1,2} [A-Z][a-z]+ \d{4}|\d[\d,]* rupees?(?: \d{1,2} paise?)?|\d{1,2} paise?|ending [0-9A-Za-z]*\d[0-9A-Za-z]*`;

const SPLIT_IMMUTABLE = new RegExp(`(${IMMUTABLE})`, 'g');
const IS_IMMUTABLE = new RegExp(`^(?:${IMMUTABLE})$`);

export interface Run {
  text: string;
  /** true when the server injected this value and no agent could alter it */
  immutable: boolean;
}

/** Split a message into agent-written and server-injected runs, in order. */
export function splitRuns(text: string): Run[] {
  return text
    .split(SPLIT_IMMUTABLE)
    .filter((part) => part.length > 0)
    .map((part) => ({ text: part, immutable: IS_IMMUTABLE.test(part) }));
}

const LOCK_LABEL =
  'Immutable slot — injected by the server from database state. The AI cannot write or alter this value.';

/** A server-injected value, set apart from the words around it. */
export function ImmutableChip({ children }: { children: string }) {
  return (
    <Tooltip label={LOCK_LABEL}>
      <span className="cursor-help rounded border border-brass/30 bg-brass/10 px-1 font-medium text-brass">
        <Lock size={9} className="mr-1 inline align-[-1px]" />
        {children}
      </span>
    </Tooltip>
  );
}

/* -------------------------------------------------------------------------- */
/*  The script bar                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Not a waveform. A waveform here would have to be invented — the audio is
 * opus and nothing decodes it in the browser — so the bars would encode
 * nothing but decoration.
 *
 * This bar IS the script. Each run takes width in proportion to its character
 * count, coloured by who wrote it: steel for the agent's words, brass for the
 * values the server injected. Speech runs at a roughly even rate, so the brass
 * tick really does sit near the moment the amount is spoken, and the playhead
 * arriving there is the message's provenance playing out in time.
 *
 * The same instrument idea as Meter: a figure is never shown bare.
 */
function ScriptBar({ runs, progress }: { runs: Run[]; progress: number }) {
  const total = runs.reduce((n, r) => n + r.text.length, 0) || 1;
  return (
    <span className="relative block h-2.5 flex-1 overflow-hidden rounded-sm bg-ink/[0.06]">
      {/* the whole script, dimmed */}
      <span className="absolute inset-0 flex">
        {runs.map((r, i) => (
          <span
            key={i}
            className={cn('block h-full opacity-30', r.immutable ? 'bg-brass' : 'bg-steel')}
            style={{ width: `${(r.text.length / total) * 100}%` }}
          />
        ))}
      </span>
      {/* what has been spoken, at full strength — a wipe, not a transition, so
          it tracks timeupdate exactly instead of lagging behind it */}
      <span
        className="absolute inset-y-0 left-0 overflow-hidden"
        style={{ width: `${Math.min(100, Math.max(0, progress * 100))}%` }}
      >
        <span className="absolute inset-y-0 left-0 flex" style={{ width: `${100 / Math.max(progress, 0.0001)}%` }}>
          {runs.map((r, i) => (
            <span
              key={i}
              className={cn('block h-full', r.immutable ? 'bg-brass' : 'bg-steel')}
              style={{ width: `${(r.text.length / total) * 100}%` }}
            />
          ))}
        </span>
      </span>
    </span>
  );
}

/* -------------------------------------------------------------------------- */
/*  The player                                                                */
/* -------------------------------------------------------------------------- */

function clock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '--:--';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function VoiceNote({
  caseId,
  communicationId,
  script,
  delivered,
}: {
  caseId: string;
  communicationId: string;
  script: string;
  /** false under WHATSAPP_MODE=mock: the audio is real, the delivery never happened */
  delivered: boolean;
}) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const objectUrl = useRef<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [loading, setLoading] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [duration, setDuration] = useState(Number.NaN);
  const [failed, setFailed] = useState(false);

  const runs = splitRuns(script);
  const progress = Number.isFinite(duration) && duration > 0 ? elapsed / duration : 0;

  // Fetched on first play, not on mount: a case with six notes would otherwise
  // pull every one of them before the reader asks for any.
  async function ensureLoaded(): Promise<HTMLAudioElement | null> {
    const el = audioRef.current;
    if (!el) return null;
    if (objectUrl.current) return el;
    setLoading(true);
    try {
      const url = await fetchAudioObjectUrl(caseId, communicationId);
      objectUrl.current = url;
      el.src = url;
      return el;
    } catch {
      setFailed(true);
      return null;
    } finally {
      setLoading(false);
    }
  }

  useEffect(
    () => () => {
      if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
    },
    [],
  );

  useEffect(() => {
    const el = audioRef.current;
    if (!el) return;
    const onTime = () => setElapsed(el.currentTime);
    const onMeta = () => setDuration(el.duration);
    const onEnd = () => {
      setPlaying(false);
      setElapsed(0);
    };
    // Only a real failure. The element renders with no src until first play,
    // and a src-less <audio> fires `error` on its own — which would light the
    // "could not be loaded" line and disable the play button before anyone had
    // tried to load anything.
    const onError = () => {
      if (objectUrl.current) setFailed(true);
    };
    el.addEventListener('timeupdate', onTime);
    el.addEventListener('loadedmetadata', onMeta);
    el.addEventListener('durationchange', onMeta);
    el.addEventListener('ended', onEnd);
    el.addEventListener('error', onError);
    return () => {
      el.removeEventListener('timeupdate', onTime);
      el.removeEventListener('loadedmetadata', onMeta);
      el.removeEventListener('durationchange', onMeta);
      el.removeEventListener('ended', onEnd);
      el.removeEventListener('error', onError);
    };
  }, []);

  async function toggle() {
    const current = audioRef.current;
    if (current && !current.paused) {
      current.pause();
      setPlaying(false);
      return;
    }
    const el = await ensureLoaded();
    if (!el) return;
    try {
      await el.play();
      setPlaying(true);
    } catch {
      setFailed(true);
    }
  }

  function seekTo(fraction: number) {
    const el = audioRef.current;
    if (!el || !Number.isFinite(el.duration)) return;
    el.currentTime = Math.min(1, Math.max(0, fraction)) * el.duration;
    setElapsed(el.currentTime);
  }

  return (
    <div>
      <audio ref={audioRef} preload="metadata" className="hidden" />

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => void toggle()}
          disabled={failed || loading}
          aria-label={playing ? 'Pause the voice note' : 'Play the voice note'}
          className={cn(
            'flex h-8 w-8 shrink-0 items-center justify-center rounded-full border transition-colors duration-200 ease-desk',
            'border-brass/35 bg-brass/10 text-brass hover:bg-brass/20',
            'disabled:pointer-events-none disabled:opacity-40',
          )}
        >
          {loading ? (
            <Loader2 size={13} className="animate-spin motion-reduce:animate-none" />
          ) : playing ? (
            <Pause size={13} />
          ) : (
            <Play size={13} className="ml-[1px]" />
          )}
        </button>

        <div
          role="slider"
          tabIndex={failed ? -1 : 0}
          aria-label="Position in the voice note"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(progress * 100)}
          className="flex flex-1 cursor-pointer items-center rounded-sm"
          onClick={(e) => {
            const box = e.currentTarget.getBoundingClientRect();
            seekTo((e.clientX - box.left) / box.width);
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowRight') seekTo(progress + 0.05);
            else if (e.key === 'ArrowLeft') seekTo(progress - 0.05);
            else if (e.key === ' ' || e.key === 'Enter') {
              e.preventDefault();
              void toggle();
            }
          }}
        >
          <ScriptBar runs={runs} progress={progress} />
        </div>

        <span className="tnum shrink-0 text-2xs text-ash">
          {clock(elapsed)} / {clock(duration)}
        </span>
      </div>

      {failed && (
        <p className="mt-2 text-2xs text-ash">
          This note&rsquo;s audio could not be loaded. The transcript below is what was synthesised.
        </p>
      )}

      {!delivered && (
        <p className="mt-2 text-2xs leading-relaxed text-ash">
          Synthesised and stored, but not delivered — WhatsApp sending is off
          (<span className="font-mono text-ink/70">WHATSAPP_MODE=mock</span>). Nobody received this.
        </p>
      )}

      <div className="mt-3">
        <Eyebrow className="text-ash">Transcript</Eyebrow>
        <p className="mt-1 whitespace-pre-wrap text-sm leading-relaxed text-ink/90">
          {runs.map((r, i) =>
            r.immutable ? <ImmutableChip key={i}>{r.text}</ImmutableChip> : <span key={i}>{r.text}</span>,
          )}
        </p>
      </div>
    </div>
  );
}
