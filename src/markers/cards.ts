export interface CardOptions {
  title: string;
  subtitle?: string;
  /** 'card': speech bubble with a leader line (default); 'pin': dot + text; 'tag': compact pill. */
  style?: 'card' | 'pin' | 'tag';
  /** Accent color (CSS). */
  color?: string;
  /** Short text or emoji before the title. */
  icon?: string;
  /** Status badge text, e.g. "告警". */
  badge?: string;
  badgeColor?: string;
}

/**
 * Builds a top card (顶牌) element. The bottom center of the element is the
 * anchor point (use pivot [0.5, 1] with MarkerManager), so the leader line
 * of the card ends exactly on the object.
 */
export function createCard(options: CardOptions): HTMLElement {
  const style = options.style ?? 'card';
  const root = document.createElement('div');
  root.className = `tg-card tg-${style}`;
  if (options.color) root.style.setProperty('--accent', options.color);

  const body = document.createElement('div');
  body.className = 'tg-body';
  if (options.icon) {
    const icon = document.createElement('span');
    icon.className = 'tg-icon';
    icon.textContent = options.icon;
    body.append(icon);
  }
  const text = document.createElement('div');
  text.className = 'tg-text';
  const title = document.createElement('strong');
  title.textContent = options.title;
  text.append(title);
  if (options.subtitle && style !== 'tag') {
    const sub = document.createElement('span');
    sub.textContent = options.subtitle;
    text.append(sub);
  }
  body.append(text);
  if (options.badge) {
    const badge = document.createElement('em');
    badge.className = 'tg-badge';
    badge.textContent = options.badge;
    if (options.badgeColor) badge.style.background = options.badgeColor;
    body.append(badge);
  }
  root.append(body);
  if (style === 'card') {
    const stem = document.createElement('i');
    stem.className = 'tg-stem';
    root.append(stem);
  } else if (style === 'pin') {
    const dot = document.createElement('i');
    dot.className = 'tg-dot';
    root.append(dot);
  }
  return root;
}
