/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        border: 'hsl(217 20% 88%)',
        muted: 'hsl(215 18% 46%)',
        surface: 'hsl(210 30% 98%)',
        ink: 'hsl(222 40% 12%)',
        accent: 'hsl(226 64% 45%)',
        good: 'hsl(152 55% 34%)',
        warn: 'hsl(36 90% 40%)',
        bad: 'hsl(0 65% 45%)',
      },
      fontFamily: {
        sans: ['"IBM Plex Sans"', 'system-ui', 'sans-serif'],
        mono: ['"IBM Plex Mono"', 'ui-monospace', 'monospace'],
      },
    },
  },
  plugins: [],
};
