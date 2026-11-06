/**
 * Marker / top card (顶牌) DOM templates. Every style anchors at the bottom
 * center of its element (MarkerManager pivot [0.5, 1]): the leader line's end,
 * the tip of a pin, or the center of a dot, disc or ground ring (those
 * elements end at their symbol's center and the rest overflows). Styles live
 * in style.css as `.tg-<style>`.
 */
import type { MarkerStyleName } from './points';

export interface CardOptions {
  title: string;
  subtitle?: string;
  /**
   * - 'card': speech bubble with a leader line (default)
   * - 'pin': text pill over a dot
   * - 'tag': compact pill
   * - 'poi': map pin (teardrop) with the icon inside, text above
   * - 'pulse': dot with expanding rings, for alarms and live points
   * - 'beacon': light pillar standing on a ground ring, visible from afar
   * - 'badge': round disc with an icon or number (also used for clusters)
   * - 'label': text with a halo over a small dot, no box (dense points)
   */
  style?: MarkerStyleName;
  /** Accent color (CSS). */
  color?: string;
  /** Short text or emoji before the title (inside the symbol for poi / badge). */
  icon?: string;
  /** Status badge text, e.g. "告警". */
  badge?: string;
  badgeColor?: string;
}

const PIN_PATH = 'M12 0C5.37 0 0 5.37 0 12c0 8.4 10.5 18.9 11.2 19.6a1.1 1.1 0 0 0 1.6 0C13.5 30.9 24 20.4 24 12 24 5.37 18.63 0 12 0z';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

/** Text block: title, optional subtitle and status badge (icon in front unless the symbol shows it). */
function body(options: CardOptions, withIcon: boolean, withSubtitle: boolean): HTMLElement {
  const b = el('div', 'tg-body');
  if (withIcon && options.icon) b.append(el('span', 'tg-icon', options.icon));
  const text = el('div', 'tg-text');
  text.append(el('strong', '', options.title));
  if (options.subtitle && withSubtitle) text.append(el('span', '', options.subtitle));
  b.append(text);
  if (options.badge) {
    const badge = el('em', 'tg-status', options.badge);
    if (options.badgeColor) badge.style.background = options.badgeColor;
    b.append(badge);
  }
  return b;
}

/**
 * Builds a marker element. The bottom center of the element is the anchor
 * point (pivot [0.5, 1] with MarkerManager). An empty `title` draws only the
 * symbol (poi, pulse, beacon, badge).
 */
export function createCard(options: CardOptions): HTMLElement {
  const style = options.style ?? 'card';
  const root = el('div', `tg-card tg-${style}`);
  if (options.color) root.style.setProperty('--accent', options.color);
  const hasText = options.title !== '' || !!options.subtitle;

  switch (style) {
    case 'poi': {
      if (hasText) root.append(body(options, false, true));
      const drop = el('i', 'tg-drop');
      const svgNs = 'http://www.w3.org/2000/svg';
      const svg = document.createElementNS(svgNs, 'svg');
      svg.setAttribute('viewBox', '0 0 24 32');
      const path = document.createElementNS(svgNs, 'path');
      path.setAttribute('d', PIN_PATH);
      svg.append(path);
      drop.append(svg, el('b', '', options.icon ?? ''));
      root.append(drop);
      break;
    }
    case 'pulse': {
      if (hasText) root.append(body(options, true, true));
      const dot = el('i', 'tg-pulse-dot');
      dot.append(el('b', ''), el('b', ''));
      root.append(dot);
      break;
    }
    case 'beacon':
      if (hasText) root.append(body(options, true, true));
      root.append(el('i', 'tg-beam'), el('i', 'tg-ring'));
      break;
    case 'badge':
      if (hasText) root.append(body(options, false, false));
      root.append(el('i', 'tg-disc', options.icon ?? ''));
      break;
    case 'label': {
      const text = el('span', 'tg-label-text', options.icon ? `${options.icon} ${options.title}` : options.title);
      root.append(text, el('i', 'tg-dot'));
      break;
    }
    default:
      root.append(body(options, true, style !== 'tag'));
      if (style === 'card') root.append(el('i', 'tg-stem'));
      else if (style === 'pin') root.append(el('i', 'tg-dot'));
  }
  return root;
}

/** Cluster marker: a disc showing how many points it stands for, sized by the count. */
export function createClusterCard(count: number, color?: string): HTMLElement {
  const root = el('div', 'tg-card tg-cluster');
  if (color) root.style.setProperty('--accent', color);
  setClusterCount(root, count);
  return root;
}

/** Updates a cluster marker's count (call `marker.invalidateSize()` afterwards). */
export function setClusterCount(root: HTMLElement, count: number): void {
  const size = Math.round(Math.min(56, 26 + 7 * Math.log10(Math.max(1, count)) * 2));
  root.style.setProperty('--size', `${size}px`);
  const text = count >= 10_000 ? `${Math.round(count / 1000)}k` : count >= 1000 ? `${(count / 1000).toFixed(1)}k` : String(count);
  let disc = root.firstElementChild as HTMLElement | null;
  if (!disc) {
    disc = el('i', 'tg-disc');
    root.append(disc);
  }
  disc.textContent = text;
}
