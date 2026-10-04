// Simple line icons. stroke follows the text colour.
const svg = (body, size = 24) =>
  `<svg class="icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

export const icon = {
  today: (s) => svg('<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4.5"/>', s),
  add: (s) => svg('<circle cx="12" cy="12" r="9"/><path d="M12 8v8M8 12h8"/>', s),
  saved: (s) => svg('<path d="M6 3.5h12a1 1 0 0 1 1 1V21l-7-4.5L5 21V4.5a1 1 0 0 1 1-1z"/>', s),
  history: (s) => svg('<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>', s),
  settings: (s) => svg('<path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/>', s),
  camera: (s) => svg('<path d="M3 8.5A1.5 1.5 0 0 1 4.5 7h2.3l1.6-2.2h7.2L17.2 7h2.3A1.5 1.5 0 0 1 21 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z"/><circle cx="12" cy="13" r="3.6"/>', s),
  image: (s) => svg('<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="9.5" r="1.6"/><path d="M21 16l-5-5-9 9"/>', s),
  type: (s) => svg('<path d="M4 20h4L19 9a2.1 2.1 0 0 0-3-3L5 17z"/><path d="M14 7l3 3"/>', s),
  barcode: (s) => svg('<path d="M3 5v14M6.5 5v14M9 5v14M12.5 5v14M15 5v14M18.5 5v14M21 5v14"/>', s),
  back: (s) => svg('<path d="M15 5l-7 7 7 7"/>', s),
  next: (s) => svg('<path d="M9 5l7 7-7 7"/>', s),
  trash: (s) => svg('<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>', s),
  check: (s) => svg('<path d="M5 12.5l4.5 4.5L19 7.5"/>', s),
  plus: (s) => svg('<path d="M12 5v14M5 12h14"/>', s),
  minus: (s) => svg('<path d="M5 12h14"/>', s),
  refresh: (s) => svg('<path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7"/>', s),
  share: (s) => svg('<path d="M12 3v12M7.5 7.5L12 3l4.5 4.5"/><path d="M5 12v7a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-7"/>', s),
  wifiOff: (s) => svg('<path d="M3 3l18 18M8.5 16.4a5 5 0 0 1 7 0M5 12.9a10 10 0 0 1 4.2-2.4M19 12.9a10 10 0 0 0-2.7-1.9M2 9.3a15 15 0 0 1 4.3-2.8M22 9.3A15 15 0 0 0 11 5.1"/><circle cx="12" cy="20" r=".6"/>', s),
  close: (s) => svg('<path d="M6 6l12 12M18 6L6 18"/>', s),
  star: (s) => svg('<path d="M12 3.5l2.6 5.4 5.9.8-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.8z"/>', s),
};
