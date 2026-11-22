export const OSM_TILE_SIZE = 256;
export const OSM_TILE_URL = 'https://tile.openstreetmap.org';

export type PreviewTile = { key: string; url: string; left: number; top: number };

export function mapCoordinates(latitude: unknown, longitude: unknown): { latitude: number; longitude: number } | null {
  const lat = typeof latitude === 'number' || typeof latitude === 'string' ? Number(latitude) : Number.NaN;
  const lon = typeof longitude === 'number' || typeof longitude === 'string' ? Number(longitude) : Number.NaN;
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  return { latitude: lat, longitude: lon };
}

export function previewTiles(
  latitude: number,
  longitude: number,
  width: number,
  height: number,
  zoom = 16,
): PreviewTile[] {
  if (![latitude, longitude, width, height, zoom].every(Number.isFinite) ||
      latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180 || width <= 0 || height <= 0 ||
      !Number.isInteger(zoom) || zoom < 0 || zoom > 19) return [];

  const tileCount = 2 ** zoom;
  const worldSize = tileCount * OSM_TILE_SIZE;
  const clampedLatitude = Math.max(-85.05112878, Math.min(85.05112878, latitude));
  const latitudeRadians = clampedLatitude * Math.PI / 180;
  const worldX = ((longitude + 180) / 360) * worldSize;
  const worldY = (1 - Math.asinh(Math.tan(latitudeRadians)) / Math.PI) / 2 * worldSize;
  const viewLeft = worldX - width / 2;
  const viewTop = worldY - height / 2;
  const firstX = Math.floor(viewLeft / OSM_TILE_SIZE);
  const lastX = Math.floor((viewLeft + width - 1e-6) / OSM_TILE_SIZE);
  const firstY = Math.max(0, Math.floor(viewTop / OSM_TILE_SIZE));
  const lastY = Math.min(tileCount - 1, Math.floor((viewTop + height - 1e-6) / OSM_TILE_SIZE));
  const tiles: PreviewTile[] = [];

  for (let y = firstY; y <= lastY; y += 1) {
    for (let x = firstX; x <= lastX; x += 1) {
      const wrappedX = ((x % tileCount) + tileCount) % tileCount;
      tiles.push({
        key: `${zoom}/${wrappedX}/${y}`,
        url: `${OSM_TILE_URL}/${zoom}/${wrappedX}/${y}.png`,
        left: x * OSM_TILE_SIZE - viewLeft,
        top: y * OSM_TILE_SIZE - viewTop,
      });
    }
  }
  return tiles;
}
