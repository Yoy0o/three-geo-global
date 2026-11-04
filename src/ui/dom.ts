type Attrs = Record<string, string | number | boolean | undefined | null | EventListener>;
type Child = Node | string | null | undefined | false;

/** Tiny hyperscript helper: h('div', { class: 'x', onclick: fn }, 'text', child). */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key.startsWith('on') && typeof value === 'function') {
      el.addEventListener(key.slice(2), value as EventListener);
    } else if (key === 'class') {
      el.className = String(value);
    } else if (value === true) {
      el.setAttribute(key, '');
    } else if (key === 'value' && 'value' in el) {
      (el as HTMLInputElement).value = String(value);
    } else {
      el.setAttribute(key, String(value));
    }
  }
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    el.append(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return el;
}

export function toggle(label: string, checked: boolean, onChange: (v: boolean) => void, title?: string): HTMLLabelElement {
  const input = h('input', { type: 'checkbox' });
  input.checked = checked;
  input.addEventListener('change', () => onChange(input.checked));
  return h('label', { class: 'toggle', title }, input, h('span', { class: 'toggle-track' }), h('span', { class: 'toggle-label' }, label));
}

export function slider(
  label: string,
  opts: { min: number; max: number; step: number; value: number; format?: (v: number) => string },
  onInput: (v: number) => void,
): { root: HTMLElement; input: HTMLInputElement; setValue: (v: number) => void } {
  const out = h('output', { class: 'slider-value' });
  const fmt = opts.format ?? ((v: number) => String(v));
  const input = h('input', { type: 'range', min: opts.min, max: opts.max, step: opts.step });
  input.value = String(opts.value);
  out.textContent = fmt(opts.value);
  input.addEventListener('input', () => {
    const v = Number(input.value);
    out.textContent = fmt(v);
    onInput(v);
  });
  const root = h('label', { class: 'slider' }, h('span', { class: 'slider-label' }, label), input, out);
  return {
    root,
    input,
    setValue: (v: number) => {
      input.value = String(v);
      out.textContent = fmt(v);
    },
  };
}

export function section(title: string, ...children: Child[]): HTMLElement {
  return h('section', { class: 'panel-section' }, h('h3', {}, title), ...children);
}
