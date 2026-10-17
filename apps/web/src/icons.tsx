import type { SVGProps } from 'react';

/** 16-unit stroke icons drawn in the same language as Vela's chart chrome. */
const PATHS = {
  menu: <path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11" />,
  chevronDown: <path d="m4.5 6.5 3.5 3.5 3.5-3.5" />,
  chevronUp: <path d="m4.5 9.5 3.5-3.5 3.5 3.5" />,
  check: <path d="m3 8.4 3.2 3.2L13 4.6" />,
  close: <path d="m4 4 8 8M12 4l-8 8" />,
  plus: <path d="M8 3v10M3 8h10" />,
  more: <><circle cx="3.5" cy="8" r="1" fill="currentColor" stroke="none" /><circle cx="8" cy="8" r="1" fill="currentColor" stroke="none" /><circle cx="12.5" cy="8" r="1" fill="currentColor" stroke="none" /></>,
  search: <><circle cx="7" cy="7" r="4.5" /><path d="m10.4 10.4 3.1 3.1" /></>,
  gear: <><path d="M6.55 1.4h2.9l.32 1.72c.48.14.92.38 1.3.7l1.66-.55 1.45 2.5-1.35 1.1c.08.34.12.7.12 1.07s-.04.73-.12 1.07l1.35 1.1-1.45 2.5-1.66-.55a4.3 4.3 0 0 1-1.3.7L9.45 14.6h-2.9l-.32-1.72a4.3 4.3 0 0 1-1.3-.7l-1.66.55-1.45-2.5 1.35-1.1A4.4 4.4 0 0 1 3.05 7.94c0-.37.04-.73.12-1.07l-1.35-1.1 1.45-2.5 1.66.55c.38-.32.82-.56 1.3-.7L6.55 1.4z" /><circle cx="8" cy="8" r="2.2" /></>,
  fullscreen: <path d="M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10" />,
  exitFullscreen: <path d="M6 2.5V6H2.5M13.5 6H10V2.5M10 13.5V10h3.5M2.5 10H6v3.5" />,
  alarm: <><circle cx="8" cy="9" r="5" /><path d="M8 6.4V9l1.8 1.3M2.2 4.2 4.4 2.3M13.8 4.2l-2.2-1.9" /></>,
  replay: <><path d="M14 4.2v7.6L8.6 8z" /><path d="M7.4 4.2v7.6L2 8z" /></>,
  watchlist: <path d="M2.5 4h1M2.5 8h1M2.5 12h1M6 4h7.5M6 8h7.5M6 12h7.5" />,
  agent: <><path d="M2.5 3.5h11v7.5H8l-3 2.5V11H2.5z" /><path d="M5.5 6.4h5M5.5 8.4h3" /></>,
  help: <><circle cx="8" cy="8" r="6" /><path d="M6.3 6.3a1.8 1.8 0 1 1 2.5 1.6c-.5.3-.8.6-.8 1.2v.3" /><circle cx="8" cy="11.4" r=".6" fill="currentColor" stroke="none" /></>,
  cloud: <path d="M4.6 12.5h7a2.9 2.9 0 0 0 .3-5.8A4 4 0 0 0 4.2 6a3.3 3.3 0 0 0 .4 6.5z" />,
  cloudAlert: <><path d="M4.6 12.5h7a2.9 2.9 0 0 0 .3-5.8A4 4 0 0 0 4.2 6a3.3 3.3 0 0 0 .4 6.5z" /><path d="M8 7v2.3" /><circle cx="8" cy="10.9" r=".5" fill="currentColor" stroke="none" /></>,
  collapse: <path d="m4.5 6.5 3.5 3.5 3.5-3.5" />,
  maximize: <><rect x="2.5" y="2.5" width="11" height="11" rx="1" /><path d="M2.5 5.5h11" /></>,
  restore: <><rect x="2.5" y="5" width="8.5" height="8.5" rx="1" /><path d="M5 5V2.5h8.5V11H11" /></>,
  arrowUp: <path d="M8 13V3M4 7l4-4 4 4" />,
  arrowDown: <path d="M8 3v10M4 9l4 4 4-4" />,
  play: <path d="M5 3.2v9.6L12.5 8z" />,
  pause: <path d="M5.5 3.5v9M10.5 3.5v9" />,
  stepForward: <><path d="M3.5 3.5v9L10 8z" /><path d="M12.5 3.5v9" /></>,
  rewind: <><path d="M12.5 3.5v9L6 8z" /><path d="M3.5 3.5v9" /></>,
  stop: <rect x="4" y="4" width="8" height="8" rx="1" />,
  external: <path d="M9.5 2.5h4v4M13.5 2.5 7.5 8.5M11.5 9.5v3a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1h3" />,
  download: <path d="M8 2.5v8M4.5 7 8 10.5 11.5 7M2.5 13.5h11" />,
  upload: <path d="M8 10.5v-8M4.5 6 8 2.5 11.5 6M2.5 13.5h11" />,
  trash: <path d="M2.5 4.5h11M6 4.5V3h4v1.5M4 4.5l.7 9h6.6l.7-9" />,
  refresh: <path d="M13 3.5v3.2H9.8M3 12.5V9.3h3.2M12.6 6.6A5 5 0 0 0 3.6 6M3.4 9.4a5 5 0 0 0 9 .6" />,
  signOut: <path d="M6.5 2.5h-3a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h3M10.5 5l3 3-3 3M13.5 8H6" />,
  code: <path d="m5.5 4.5-3.5 3.5 3.5 3.5M10.5 4.5l3.5 3.5-3.5 3.5" />,
  chart: <path d="M2.5 13.5h11M4.5 11V8M7.5 11V4.5M10.5 11V6.5" />,
  info: <><circle cx="8" cy="8" r="6" /><path d="M8 7.2v4" /><circle cx="8" cy="5" r=".6" fill="currentColor" stroke="none" /></>,
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 18, ...props }: { name: IconName; size?: number } & Omit<SVGProps<SVGSVGElement>, 'name'>) {
  return <svg viewBox="0 0 16 16" width={size} height={size} fill="none" stroke="currentColor" strokeWidth={1.3} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" {...props}>{PATHS[name]}</svg>;
}

/** Inner markup for Vela's icon registry (it wraps the body in its own 16-unit SVG). */
export const VELA_ICON_BODIES = {
  'pineterm-alarm': '<circle cx="8" cy="9" r="5"/><path d="M8 6.4V9l1.8 1.3M2.2 4.2 4.4 2.3M13.8 4.2l-2.2-1.9"/>',
  'pineterm-replay': '<path d="M14 4.2v7.6L8.6 8z"/><path d="M7.4 4.2v7.6L2 8z"/>',
};
