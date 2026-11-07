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
    tg.onEvent?.('themeChanged', () => applyTheme(tg.themeParams));
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
