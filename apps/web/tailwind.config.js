/** @type {import('tailwindcss').Config} */

/*
 * "Day Desk" — the same ledger desk, under daylight.
 *
 * The palette is not the night one inverted. On paper, weight comes from ink
 * density rather than glow, so every signal is darkened until it carries its
 * meaning against white instead of shouting off a dark ground. Money is still
 * brass; each signal still means exactly one thing — sage recovered, marigold
 * needs a person, crimson frozen or refused, peri holdout, steel an agent's
 * reasoning. Nothing else gets colour, so colour never has to be decoded twice.
 *
 * Brass and marigold sit deeper than the rest because both are set as small
 * text on a 10–15% wash of themselves (the brass chip, the amber badge, the
 * approvals count). Lightening either past ~34% drops those pairs under 4.5:1.
 */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        /* grounds, light to dark */
        paper: 'hsl(228 32% 97%)', // page ground — tinted, never pure white
        panel: 'hsl(0 0% 100%)', // the card sitting on it
        raise: 'hsl(228 30% 95%)', // hover / recessed fill
        rule: 'hsl(228 20% 87%)', // hairline
        ash: 'hsl(226 13% 45%)', // secondary text
        ink: 'hsl(226 42% 15%)', // primary text — deep indigo, not black

        /* the ledger */
        brass: 'hsl(36 72% 32%)',

        /* signals — one meaning each */
        steel: 'hsl(206 68% 38%)', // an agent reasoned this — a proposal, not a fact
        sage: 'hsl(158 60% 29%)', // recovered / allowed / kept
        marigold: 'hsl(27 80% 34%)', // a person is needed
        crimson: 'hsl(355 65% 45%)', // denied / frozen / lost
        peri: 'hsl(244 48% 52%)', // holdout — observed, never touched
      },
      borderColor: {
        DEFAULT: 'hsl(228 20% 87%)',
      },
      fontFamily: {
        sans: ['Archivo', 'system-ui', 'sans-serif'],
        mono: ['"IBM Plex Mono"', 'ui-monospace', 'monospace'],
      },
      fontSize: {
        '2xs': ['0.6875rem', { lineHeight: '1rem' }],
      },
      borderRadius: {
        panel: '10px',
      },
      transitionTimingFunction: {
        desk: 'cubic-bezier(0.32, 0.72, 0, 1)',
      },
      boxShadow: {
        /* tinted with the ground hue, lit from above — never generic black */
        panel: '0 1px 2px 0 hsl(228 25% 35% / 0.05), 0 4px 14px -8px hsl(228 25% 30% / 0.14)',
        lift: '0 2px 4px 0 hsl(228 25% 35% / 0.07), 0 18px 34px -14px hsl(228 25% 28% / 0.22)',
      },
      keyframes: {
        rise: {
          from: { opacity: '0', transform: 'translateY(6px)' },
          to: { opacity: '1', transform: 'none' },
        },
        breathe: {
          '0%, 100%': { opacity: '1', transform: 'scale(1)' },
          '50%': { opacity: '0.35', transform: 'scale(0.82)' },
        },
      },
      animation: {
        rise: 'rise 380ms cubic-bezier(0.22, 1, 0.36, 1) both',
        breathe: 'breathe 2.4s ease-in-out infinite',
      },
    },
  },
  plugins: [],
};
