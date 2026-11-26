export interface DisplayRect {
  id: number;
  bounds: { x: number; y: number; width: number; height: number };
}

export function computeOverlayBounds(params: {
  displays: DisplayRect[];
  primaryDisplay: DisplayRect;
  monitorId: number | null;
  offsetTop: number;
  width: number;
  height: number;
}): { x: number; y: number; width: number; height: number } {
  const target =
    (params.monitorId !== null
      ? params.displays.find((d) => d.id === params.monitorId)
      : undefined) ?? params.primaryDisplay;

  const w = Math.max(160, Math.round(params.width));
  const h = Math.max(40, Math.round(params.height));
  const x = Math.round(target.bounds.x + (target.bounds.width - w) / 2);
  const y = Math.round(target.bounds.y + Math.max(0, Math.min(200, params.offsetTop)));
  return { x, y, width: w, height: h };
}
