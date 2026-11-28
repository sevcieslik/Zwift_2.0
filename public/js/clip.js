// Kept as a no-op hook: materials call addClip(), which used to cross-fade our terrain with
// Google 3D Tiles. Google tiles are gone, so it now leaves the material untouched (no shader cost).
export const CLIP = { on: { value: 0 } };
export function addClip(m) { return m; }
