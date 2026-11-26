"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.computeOverlayBounds = computeOverlayBounds;
function computeOverlayBounds(params) {
    const target = (params.monitorId !== null
        ? params.displays.find((d) => d.id === params.monitorId)
        : undefined) ?? params.primaryDisplay;
    const w = Math.max(160, Math.round(params.width));
    const h = Math.max(40, Math.round(params.height));
    const x = Math.round(target.bounds.x + (target.bounds.width - w) / 2);
    const y = Math.round(target.bounds.y + Math.max(0, Math.min(200, params.offsetTop)));
    return { x, y, width: w, height: h };
}
