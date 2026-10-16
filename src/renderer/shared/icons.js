/**
 * Icon set — SVG equivalents of the SF Symbols used by the macOS original.
 *
 * Every icon is drawn on a 24x24 grid with a 1.8 stroke so it matches the
 * optical weight of the native symbols at the sizes the UI actually uses.
 */

const P = {
  /* ---- Inspector rail ---- */
  screen: `<rect x="2.5" y="4" width="19" height="13" rx="2.4"/><path d="M2.5 13.5 8 9.6l4.6 3.6L17 9.4l4.5 3.7"/>`,
  opening: `<rect x="3" y="8" width="14" height="12" rx="2.4"/><path d="M6.5 5.6h11a2.4 2.4 0 0 1 2.4 2.4v9"/><path d="M15.6 2.6l1.1 1.9 2 .7-1.5 1.5.2 2.1-1.8-1-1.9 1 .3-2.1-1.5-1.5 2-.7z"/>`,
  viewfinder: `<circle cx="12" cy="12" r="3.1"/><path d="M3.6 8.2V5.6a2 2 0 0 1 2-2h2.6M15.8 3.6h2.6a2 2 0 0 1 2 2v2.6M20.4 15.8v2.6a2 2 0 0 1-2 2h-2.6M8.2 20.4H5.6a2 2 0 0 1-2-2v-2.6"/>`,
  cursor: `<path d="M6.4 3.4l11.2 6.9-4.9 1.1-1.6 4.9z" fill="currentColor" stroke="none"/><path d="M15.6 15.2l3.4 5.4M19.8 13.6l3 2.1M13 19.8l2.1 3" stroke-linecap="round"/>`,
  camera: `<rect x="2.6" y="6.4" width="13.2" height="11.2" rx="2.6"/><path d="M15.8 12.2l5.6-3.4v6.8l-5.6-3.4z" fill="currentColor" stroke="none"/>`,
  speaker: `<path d="M4 9.4h3.4L12 5.6v12.8l-4.6-3.8H4z" fill="currentColor" stroke="none"/><path d="M15.4 9a4.2 4.2 0 0 1 0 6M18.2 6.4a8 8 0 0 1 0 11.2" stroke-linecap="round"/>`,

  /* ---- Frame sub tabs ---- */
  layers: `<path d="M12 3.4 3 8l9 4.6L21 8z"/><path d="M3.4 12.4 12 16.8l8.6-4.4"/><path d="M3.4 16.4 12 20.8l8.6-4.4"/>`,
  inset: `<rect x="2.6" y="4.6" width="18.8" height="14.8" rx="2.6"/><rect x="7" y="9" width="10" height="6" rx="1.4" fill="currentColor" stroke="none"/>`,
  mockup: `<rect x="2.6" y="4.4" width="18.8" height="15.2" rx="2.6"/><path d="M2.6 9.4h18.8"/><circle cx="5.6" cy="6.9" r="0.75" fill="currentColor" stroke="none"/><circle cx="8.1" cy="6.9" r="0.75" fill="currentColor" stroke="none"/>`,

  /* ---- Background tabs ---- */
  photo: `<rect x="2.6" y="4.4" width="18.8" height="15.2" rx="2.6"/><circle cx="8.6" cy="9.6" r="1.9"/><path d="M3 17.4l5-4.6 3.8 3.4 3.6-3.2 5 4.4"/>`,
  grid: `<rect x="3.4" y="3.4" width="17.2" height="17.2" rx="2.4"/><path d="M9.1 3.4v17.2M14.9 3.4v17.2M3.4 9.1h17.2M3.4 14.9h17.2"/>`,
  wave: `<rect x="2.6" y="5" width="18.8" height="14" rx="2.6"/><path d="M5.6 12h1.8l1.4-3.4 2 6.8 1.8-4.6 1.3 2.4h3.9" stroke-linecap="round" stroke-linejoin="round"/>`,
  photoPlus: `<rect x="2.6" y="6.4" width="15.2" height="13.2" rx="2.6"/><path d="M3 16.6l4.4-4 3.4 3 3-2.6 3.8 3.4"/><path d="M19 4.2v5.6M16.2 7h5.6" stroke-linecap="round"/>`,
  clipboard: `<rect x="5.4" y="4.6" width="13.2" height="16" rx="2.4"/><path d="M9.2 4.6V3.4a1.5 1.5 0 0 1 1.5-1.5h2.6a1.5 1.5 0 0 1 1.5 1.5v1.2z"/><path d="M9.2 11.4h5.6M9.2 15.2h3.6" stroke-linecap="round"/>`,

  /* ---- Recorder source types ---- */
  display: `<rect x="2.4" y="4.4" width="19.2" height="12.6" rx="2.2"/><path d="M8.4 20.2h7.2M12 17v3.2" stroke-linecap="round"/>`,
  window: `<rect x="2.6" y="4.6" width="18.8" height="14.8" rx="2.6"/><path d="M2.6 9.2h18.8"/>`,
  area: `<rect x="2.6" y="4.6" width="18.8" height="14.8" rx="2.6" stroke-dasharray="4 3"/>`,
  device: `<rect x="7" y="2.6" width="10" height="18.8" rx="2.4"/><path d="M10.6 18.6h2.8" stroke-linecap="round"/>`,
  mic: `<rect x="9" y="2.8" width="6" height="11" rx="3"/><path d="M5.6 11.4a6.4 6.4 0 0 0 12.8 0M12 17.8v3.4" stroke-linecap="round"/>`,
  folder: `<path d="M2.8 6.6a2 2 0 0 1 2-2h3.6l2.2 2.6h8.6a2 2 0 0 1 2 2v9.2a2 2 0 0 1-2 2H4.8a2 2 0 0 1-2-2z"/>`,
  note: `<rect x="3.4" y="3.4" width="17.2" height="17.2" rx="2.6"/><path d="M7.4 8.4h9.2M7.4 12h9.2M7.4 15.6h5.6" stroke-linecap="round"/>`,
  marker: `<path d="M6 3.6v17.2"/><path d="M6 5.4h11.6l-2.4 3.4 2.4 3.4H6z" fill="currentColor" stroke="none"/>`,

  /* ---- Editor chrome ---- */
  sidebar: `<rect x="2.8" y="4.4" width="18.4" height="15.2" rx="2.6"/><path d="M9.4 4.4v15.2"/>`,
  chevronDown: `<path d="M6.4 9.6 12 15l5.6-5.4" stroke-linecap="round" stroke-linejoin="round"/>`,
  chevronRight: `<path d="M9.6 5.6 15.4 12l-5.8 6.4" stroke-linecap="round" stroke-linejoin="round"/>`,
  copy: `<rect x="8.4" y="8.4" width="12.2" height="12.2" rx="2.4"/><path d="M15.6 5.6a2.4 2.4 0 0 0-2.4-2.4H5.8a2.4 2.4 0 0 0-2.4 2.4v7.4a2.4 2.4 0 0 0 2.4 2.4"/>`,
  undo: `<path d="M4 9.4h10.2a5.6 5.6 0 0 1 0 11.2H8.6" stroke-linecap="round" stroke-linejoin="round"/><path d="M7.4 5.6 3.6 9.4l3.8 3.8" stroke-linecap="round" stroke-linejoin="round"/>`,
  redo: `<path d="M20 9.4H9.8a5.6 5.6 0 0 0 0 11.2h5.6" stroke-linecap="round" stroke-linejoin="round"/><path d="M16.6 5.6l3.8 3.8-3.8 3.8" stroke-linecap="round" stroke-linejoin="round"/>`,
  sparkles: `<path d="M12 3.2l1.7 4.4 4.4 1.7-4.4 1.7L12 15.4l-1.7-4.4L5.9 9.3l4.4-1.7z" fill="currentColor" stroke="none"/><path d="M18.4 14.6l.9 2.3 2.3.9-2.3.9-.9 2.3-.9-2.3-2.3-.9 2.3-.9z" fill="currentColor" stroke="none"/>`,
  export: `<path d="M12 15.6V3.8" stroke-linecap="round"/><path d="M8 7.6 12 3.6l4 4" stroke-linecap="round" stroke-linejoin="round"/><path d="M4.6 13.4v4.4a2.4 2.4 0 0 0 2.4 2.4h10a2.4 2.4 0 0 0 2.4-2.4v-4.4" stroke-linecap="round"/>`,
  help: `<circle cx="12" cy="12" r="9.2"/><path d="M9.6 9.4a2.5 2.5 0 1 1 3.3 2.4c-.7.3-.9.9-.9 1.6" stroke-linecap="round"/><circle cx="12" cy="17" r="1.05" fill="currentColor" stroke="none"/>`,
  sun: `<circle cx="12" cy="12" r="4.2"/><path d="M12 2.6v2.6M12 18.8v2.6M2.6 12h2.6M18.8 12h2.6M5.4 5.4l1.8 1.8M16.8 16.8l1.8 1.8M18.6 5.4l-1.8 1.8M7.2 16.8l-1.8 1.8" stroke-linecap="round"/>`,
  moon: `<path d="M20.4 14.6A8.6 8.6 0 0 1 9.4 3.6a8.8 8.8 0 1 0 11 11z"/>`,
  crop: `<path d="M6.6 2.6v14.8h14.8" stroke-linecap="round"/><path d="M2.6 6.6h14.8v14.8" stroke-linecap="round"/>`,
  plus: `<path d="M12 5.4v13.2M5.4 12h13.2" stroke-linecap="round"/>`,
  minus: `<path d="M5.4 12h13.2" stroke-linecap="round"/>`,
  list: `<path d="M8.4 6.4h12M8.4 12h12M8.4 17.6h12" stroke-linecap="round"/><circle cx="4.4" cy="6.4" r="1.15" fill="currentColor" stroke="none"/><circle cx="4.4" cy="12" r="1.15" fill="currentColor" stroke="none"/><circle cx="4.4" cy="17.6" r="1.15" fill="currentColor" stroke="none"/>`,
  scissors: `<circle cx="6.6" cy="6.4" r="2.6"/><circle cx="6.6" cy="17.6" r="2.6"/><path d="M8.8 7.8 20 17.4M8.8 16.2 20 6.6" stroke-linecap="round"/>`,
  magnet: `<path d="M6 4.6v8.2a6 6 0 0 0 12 0V4.6" stroke-linecap="round"/><path d="M6 10.4h4.4M13.6 10.4H18" stroke-linecap="round"/>`,
  /* Eight-tooth gear, mirror-symmetric on both axes (the old path spiralled
     and rendered as an unrecognisable blob next to 通用). */
  settings: `<circle cx="12" cy="12" r="3.1"/><path d="M9.91 2.94A9.3 9.3 0 0 1 14.09 2.94L14.34 5.40L15.01 5.68L16.93 4.11A9.3 9.3 0 0 1 19.89 7.07L18.32 8.99L18.60 9.66L21.06 9.91A9.3 9.3 0 0 1 21.06 14.09L18.60 14.34L18.32 15.01L19.89 16.93A9.3 9.3 0 0 1 16.93 19.89L15.01 18.32L14.34 18.60L14.09 21.06A9.3 9.3 0 0 1 9.91 21.06L9.66 18.60L8.99 18.32L7.07 19.89A9.3 9.3 0 0 1 4.11 16.93L5.68 15.01L5.40 14.34L2.94 14.09A9.3 9.3 0 0 1 2.94 9.91L5.40 9.66L5.68 8.99L4.11 7.07A9.3 9.3 0 0 1 7.07 4.11L8.99 5.68L9.66 5.40L9.91 2.94z" stroke-linejoin="round"/>`,
  play: `<path d="M7.6 4.8 19 12 7.6 19.2z" fill="currentColor" stroke="none"/>`,
  pause: `<rect x="6.6" y="4.8" width="3.6" height="14.4" rx="1.2" fill="currentColor" stroke="none"/><rect x="13.8" y="4.8" width="3.6" height="14.4" rx="1.2" fill="currentColor" stroke="none"/>`,
  prevFrame: `<path d="M18.6 5.4 9.4 12l9.2 6.6z" fill="currentColor" stroke="none"/><path d="M5.8 4.8v14.4" stroke-linecap="round"/>`,
  nextFrame: `<path d="M5.4 5.4 14.6 12l-9.2 6.6z" fill="currentColor" stroke="none"/><path d="M18.2 4.8v14.4" stroke-linecap="round"/>`,
  stop: `<rect x="6.4" y="6.4" width="11.2" height="11.2" rx="2.4" fill="currentColor" stroke="none"/>`,
  check: `<path d="M4.8 12.6 9.6 17.4 19.2 7" stroke-linecap="round" stroke-linejoin="round"/>`,
  trash: `<path d="M4.6 6.8h14.8M9.6 6.8V4.6a1.6 1.6 0 0 1 1.6-1.6h1.6a1.6 1.6 0 0 1 1.6 1.6v2.2" stroke-linecap="round"/><path d="M6.6 6.8l.9 12.2a1.8 1.8 0 0 0 1.8 1.6h5.4a1.8 1.8 0 0 0 1.8-1.6l.9-12.2" stroke-linecap="round"/>`,
  close: `<path d="M6.2 6.2 17.8 17.8M17.8 6.2 6.2 17.8" stroke-linecap="round"/>`,
  eye: `<path d="M2.6 12S6 6.2 12 6.2 21.4 12 21.4 12 18 17.8 12 17.8 2.6 12 2.6 12z"/><circle cx="12" cy="12" r="3"/>`,
  eyeOff: `<path d="M4 4l16 16" stroke-linecap="round"/><path d="M9.6 6.6A9.4 9.4 0 0 1 12 6.2c6 0 9.4 5.8 9.4 5.8a17 17 0 0 1-3.3 3.9M6.4 8.2A16.6 16.6 0 0 0 2.6 12S6 17.8 12 17.8a9.6 9.6 0 0 0 3.4-.6" stroke-linecap="round"/>`,
  text: `<path d="M5 6.2V4.6h14v1.6M12 4.6v14.8M9 19.4h6" stroke-linecap="round"/>`,
  rotate: `<path d="M20 12a8 8 0 1 1-2.6-5.9" stroke-linecap="round"/><path d="M20.4 4.2v4.4h-4.4" stroke-linecap="round" stroke-linejoin="round"/>`,
  mirror: `<path d="M12 3.4v17.2" stroke-dasharray="2.6 2.6"/><path d="M9.4 6.6 4 12l5.4 5.4z"/><path d="M14.6 6.6 20 12l-5.4 5.4z"/>`,
  info: `<circle cx="12" cy="12" r="9.2"/><path d="M12 11v5.4" stroke-linecap="round"/><circle cx="12" cy="7.8" r="1.05" fill="currentColor" stroke="none"/>`,
  warning: `<path d="M12 3.9 21.3 19.7H2.7z" stroke-linejoin="round"/><path d="M12 10v4.6" stroke-linecap="round"/><circle cx="12" cy="17.2" r="0.55" fill="currentColor" stroke="none"/>`,
  refresh: `<path d="M20.4 12a8.4 8.4 0 1 1-2.5-6" stroke-linecap="round"/><path d="M20.6 3.6v5h-5" stroke-linecap="round" stroke-linejoin="round"/>`,
  save: `<path d="M5.4 3.6h10.2l4 4v12.8H5.4z"/><path d="M8.4 3.6v5.6h6.2V3.6"/><rect x="8.4" y="13" width="7.2" height="7.4" rx="1"/>`,
  open: `<path d="M2.8 6.6a2 2 0 0 1 2-2h3.6l2.2 2.6h8.6a2 2 0 0 1 2 2v9.2a2 2 0 0 1-2 2H4.8a2 2 0 0 1-2-2z"/><path d="M2.8 11.4h18.4"/>`,
  zoomIn: `<circle cx="10.8" cy="10.8" r="6.6"/><path d="M15.8 15.8 20.6 20.6M10.8 8.2v5.2M8.2 10.8h5.2" stroke-linecap="round"/>`,
  zoomOut: `<circle cx="10.8" cy="10.8" r="6.6"/><path d="M15.8 15.8 20.6 20.6M8.2 10.8h5.2" stroke-linecap="round"/>`,
  ratio: `<rect x="2.8" y="6" width="18.4" height="12" rx="2.2"/><path d="M7 10.4h2.4M7 10.4v3.2" stroke-linecap="round"/>`,
  image: `<rect x="2.6" y="4.4" width="18.8" height="15.2" rx="2.6"/><circle cx="8.4" cy="9.4" r="1.7"/><path d="M3 17.2l5-4.4 3.8 3.2 3.6-3 5 4.2"/>`,
  sticker: `<path d="M4 5.4a1.8 1.8 0 0 1 1.8-1.8h12.4A1.8 1.8 0 0 1 20 5.4v7.4L13 20H5.8A1.8 1.8 0 0 1 4 18.2z"/><path d="M20 12.8h-5.2a1.8 1.8 0 0 0-1.8 1.8V20"/>`,
  spark: `<path d="M12 3.6l1.9 5 5 1.9-5 1.9-1.9 5-1.9-5-5-1.9 5-1.9z" fill="currentColor" stroke="none"/>`,
  clock: `<circle cx="12" cy="12" r="9.2"/><path d="M12 6.8V12l3.6 2.4" stroke-linecap="round" stroke-linejoin="round"/>`,
  grip: `<circle cx="9" cy="7" r="1.15" fill="currentColor" stroke="none"/><circle cx="15" cy="7" r="1.15" fill="currentColor" stroke="none"/><circle cx="9" cy="12" r="1.15" fill="currentColor" stroke="none"/><circle cx="15" cy="12" r="1.15" fill="currentColor" stroke="none"/><circle cx="9" cy="17" r="1.15" fill="currentColor" stroke="none"/><circle cx="15" cy="17" r="1.15" fill="currentColor" stroke="none"/>`,
  link: `<path d="M10 14a3.6 3.6 0 0 0 5.2 0l3-3a3.7 3.7 0 0 0-5.2-5.2l-1 1" stroke-linecap="round"/><path d="M14 10a3.6 3.6 0 0 0-5.2 0l-3 3a3.7 3.7 0 0 0 5.2 5.2l1-1" stroke-linecap="round"/>`,
  wand: `<path d="M5 19 16 8" stroke-linecap="round"/><path d="M14.6 4.4l.9 2.1 2.1.9-2.1.9-.9 2.1-.9-2.1-2.1-.9 2.1-.9zM19.4 13l.6 1.4 1.4.6-1.4.6-.6 1.4-.6-1.4-1.4-.6 1.4-.6z" fill="currentColor" stroke="none"/>`,
};

export function icon(name, size = 18, extraClass = "") {
  const body = P[name] || P.info;
  return `<svg class="icon ${extraClass}" viewBox="0 0 24 24" width="${size}" height="${size}"
    fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"
    focusable="false">${body}</svg>`;
}

export function iconEl(name, size = 18, extraClass = "") {
  const span = document.createElement("span");
  span.className = "icon-wrap";
  span.innerHTML = icon(name, size, extraClass);
  return span.firstElementChild;
}

export const ICON_NAMES = Object.keys(P);
