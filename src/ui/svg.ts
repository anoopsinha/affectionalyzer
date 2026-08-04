const NS = 'http://www.w3.org/2000/svg';

type Attrs = Record<string, string | number>;

export function svgEl<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  parent?: Element,
): SVGElementTagNameMap[K] {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  parent?.appendChild(el);
  return el;
}

export function setAttrs(el: Element, attrs: Attrs): void {
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
}

/**
 * Charts here run with `overflow: visible` so end-labels can sit outside the
 * viewBox — which also means a mark parked off-canvas until it has real data
 * stays visible. Marks are hidden outright instead of hidden by position.
 */
export function showMark(el: Element, visible: boolean): void {
  el.classList.toggle('mark-hidden', !visible);
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  parent?: Element,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  parent?.appendChild(node);
  return node;
}

/** Round to a fixed number of decimals without exponent notation. */
export function fmt(v: number, decimals = 1): string {
  if (!Number.isFinite(v)) return '—';
  return v.toFixed(decimals);
}

/** Signed value with an explicit sign, for FAA and similar bipolar readouts. */
export function fmtSigned(v: number, decimals = 2): string {
  if (!Number.isFinite(v)) return '—';
  return `${v >= 0 ? '+' : ''}${v.toFixed(decimals)}`;
}
