// Обгортка над Telegram Web App. У звичайному браузері тихо нічого не робить.

/**
 * Ініціалізує Telegram WebApp (якщо сторінку відкрито всередині Telegram).
 * Повертає об'єкт WebApp або null.
 */
export function initTelegram() {
  const tg = window.Telegram?.WebApp;
  if (!tg) return null;

  try {
    tg.ready();
    tg.expand();
    applyTheme(tg.themeParams);
    // Схема теми (світла/темна) — для логотипу; у звичайному браузері platform === 'unknown'
    if (tg.platform && tg.platform !== 'unknown') document.documentElement.dataset.scheme = tg.colorScheme || 'light';
    tg.onEvent?.('themeChanged', () => {
      applyTheme(tg.themeParams);
      if (tg.platform !== 'unknown') document.documentElement.dataset.scheme = tg.colorScheme || 'light';
    });
  } catch (err) {
    console.warn('Telegram WebApp не ініціалізувався:', err);
  }
  return tg;
}

/** Переносить кольори теми Telegram у CSS-змінні. Порожні значення пропускаємо. */
function applyTheme(p = {}) {
  const style = document.documentElement.style;
  const map = {
    bg_color: '--bg',
    secondary_bg_color: '--surface',
    text_color: '--text',
    hint_color: '--hint',
    button_color: '--accent',
    button_text_color: '--accent-text',
  };
  for (const [key, cssVar] of Object.entries(map)) {
    if (p[key]) style.setProperty(cssVar, p[key]);
  }
}

/**
 * Параметр прямого посилання на міні-застосунок: t.me/<бот>/<застосунок>?startapp=<назва>__<ключ КП>.
 * Telegram передає його в initDataUnsafe.start_param (і в адресі як tgWebAppStartParam).
 * Повертає { model, kp } або null.
 */
export function startParam() {
  const tg = window.Telegram?.WebApp;
  const raw = tg?.initDataUnsafe?.start_param || new URLSearchParams(window.location.search).get('tgWebAppStartParam') || '';
  const m = /^([a-zA-Z0-9-]{1,64})(?:__([A-Za-z0-9_-]{43}))?$/.exec(raw);
  return m ? { model: m[1], kp: m[2] || null } : null;
}
