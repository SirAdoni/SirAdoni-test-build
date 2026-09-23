type TouchReorderDropIndexOptions = {
  x: number;
  y: number;
  itemSelector: string;
  rootSelector: string;
  itemCount: number;
};

function closestElementFromPoint(x: number, y: number, selector: string) {
  const element = document.elementFromPoint(x, y);
  return element instanceof Element ? element.closest<HTMLElement>(selector) : null;
}

function readReorderIndex(element: HTMLElement | null) {
  if (!element) return null;
  const value = Number(element.dataset.touchReorderIndex);
  return Number.isInteger(value) && value >= 0 ? value : null;
}

export function getTouchReorderDropIndex({
  x,
  y,
  itemSelector,
  rootSelector,
  itemCount,
}: TouchReorderDropIndexOptions): number | null {
  const item = closestElementFromPoint(x, y, itemSelector);
  const itemIndex = readReorderIndex(item);
  if (item && itemIndex !== null) {
    const rect = item.getBoundingClientRect();
    return y < rect.top + rect.height / 2 ? itemIndex : itemIndex + 1;
  }

  const root = closestElementFromPoint(x, y, rootSelector);
  if (!root) return null;

  const items = Array.from(root.querySelectorAll<HTMLElement>(itemSelector));
  for (const [domIndex, candidate] of items.entries()) {
    const candidateIndex = readReorderIndex(candidate) ?? domIndex;
    const rect = candidate.getBoundingClientRect();
    if (y < rect.top) return candidateIndex;
    if (y <= rect.bottom) return y < rect.top + rect.height / 2 ? candidateIndex : candidateIndex + 1;
  }

  const lastIndex = readReorderIndex(items.at(-1) ?? null);
  return lastIndex === null ? itemCount : Math.min(itemCount, lastIndex + 1);
}
