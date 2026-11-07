// Єдиний набір іконок застосунку: 24×24, тонка лінія 1.8, заокруглені кінці,
// одна легка заливка фірмовим золотом (CSS-змінна --icon-accent). Колір лінії — currentColor.

const svg = (body) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
const ACC = 'fill="var(--icon-accent)" fill-opacity=".35" stroke="none"';

export const ICONS = {
  // ---- Панель над сценою ----
  scan: svg(`
    <path d="M4 8V5.5A1.5 1.5 0 0 1 5.5 4H8M16 4h2.5A1.5 1.5 0 0 1 20 5.5V8M20 16v2.5a1.5 1.5 0 0 1-1.5 1.5H16M8 20H5.5A1.5 1.5 0 0 1 4 18.5V16"/>
    <rect x="7.5" y="7.5" width="9" height="9" rx="1" ${ACC}/>
    <path d="M7.5 12h9"/>`),
  block: svg(`
    <path d="M12 12.5 19.5 8.5v8L12 20.5z" ${ACC}/>
    <path d="M12 3.5 19.5 7.5v9L12 20.5 4.5 16.5v-9z"/>
    <path d="M4.5 7.5 12 11.5l7.5-4M12 11.5v9"/>`),
  open: svg(`
    <rect x="4" y="3.5" width="9.5" height="17" rx="1"/>
    <path d="M13.5 3.5 19.5 5.5v13l-6 2z" ${ACC}/>
    <path d="M13.5 3.5 19.5 5.5v13l-6 2"/>
    <path d="M16.5 11v2"/>`),
  close: svg(`
    <rect x="4" y="3.5" width="16" height="17" rx="1" ${ACC}/>
    <rect x="4" y="3.5" width="16" height="17" rx="1"/>
    <path d="M12 3.5v17M10 11v2M14 11v2"/>`),
  hide: svg(`
    <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" ${ACC}/>
    <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/>
    <circle cx="12" cy="12" r="3"/>
    <path d="M4 20 20 4"/>`),
  show: svg(`
    <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" ${ACC}/>
    <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/>
    <circle cx="12" cy="12" r="3"/>`),

  // ---- Розділ «Вигляд» ----
  texture: svg(`
    <rect x="4" y="4" width="16" height="16" rx="2" ${ACC}/>
    <rect x="4" y="4" width="16" height="16" rx="2"/>
    <path d="M4 10c3 .8 5-1.2 8-.6s5 1.4 8 .6M4 15.5c3 .8 5-1.2 8-.6s5 1.4 8 .6"/>`),
  xray: svg(`
    <path d="M12 3.5 19.5 7.5v9L12 20.5 4.5 16.5v-9z" ${ACC}/>
    <path d="M12 3.5 19.5 7.5v9L12 20.5 4.5 16.5v-9z"/>
    <path d="M4.5 7.5 12 11.5l7.5-4M12 11.5v9"/>
    <path d="M4.5 16.5 12 12.5l7.5 4M12 12.5v-9" stroke-dasharray="1.6 1.8" stroke-width="1.2"/>`),
  dims: svg(`
    <rect x="8" y="8" width="12" height="12" rx="1" ${ACC}/>
    <rect x="8" y="8" width="12" height="12" rx="1"/>
    <path d="M8 4h12M8 3v2M20 3v2M4 8v12M3 8h2M3 20h2"/>`),
  facades: svg(`
    <rect x="4" y="3.5" width="16" height="17" rx="1" ${ACC}/>
    <rect x="4" y="3.5" width="16" height="17" rx="1"/>
    <path d="M12 3.5v17M10 10.5v3M14 10.5v3"/>`),
  walls: svg(`
    <path d="M4 6.5 11 4v13l-7 3z" ${ACC}/>
    <path d="M4 6.5 11 4l9 2.5v14L11 17 4 20z"/>
    <path d="M11 4v13"/>`),
  spin: svg(`
    <path d="M12 8.5 15.5 10.5v4L12 16.5l-3.5-2v-4z" ${ACC}/>
    <path d="M12 8.5 15.5 10.5v4L12 16.5l-3.5-2v-4z"/>
    <path d="M20.5 12.5c0 2.5-3.8 4.5-8.5 4.5M3.5 11.5C3.5 9 7.3 7 12 7"/>
    <path d="M10 15.5 12 17l-1.6 1.8M14 8.5 12 7l1.6-1.8"/>`),
  client: svg(`
    <circle cx="12" cy="8.5" r="3.5" ${ACC}/>
    <circle cx="12" cy="8.5" r="3.5"/>
    <path d="M5 20c.8-3.8 3.6-5.5 7-5.5s6.2 1.7 7 5.5"/>`),
  explode: svg(`
    <rect x="9" y="9" width="6" height="6" rx="1" ${ACC}/>
    <rect x="9" y="9" width="6" height="6" rx="1"/>
    <path d="M7 7 4 4M17 7l3-3M7 17l-3 3M17 17l3 3M4 7V4h3M20 7V4h-3M4 17v3h3M20 17v3h-3"/>`),
};
