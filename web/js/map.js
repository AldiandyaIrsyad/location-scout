// 2D overview map (Leaflet, global L): area square, surroundings square, camera + view cone, pin.
import { bboxFor } from './geo.js';

export class MiniMap {
  constructor(el, { onPin }) {
    this.map = L.map(el, { zoomControl: true, attributionControl: true }).setView([-6.1754, 106.8272], 16);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    }).addTo(this.map);
    this.area = L.rectangle([[0, 0], [0, 0]], { color: '#f08a2c', weight: 2, fill: false }).addTo(this.map);
    this.far = L.rectangle([[0, 0], [0, 0]], { color: '#3b82f6', weight: 1, dashArray: '4 4', fill: false });
    this.cone = L.polygon([], { color: '#f08a2c', weight: 1, fillOpacity: 0.25, interactive: false }).addTo(this.map);
    this.cam = L.marker([0, 0], { icon: L.divIcon({ className: '', html: '<div class="cam-marker"></div>', iconSize: [14, 14], iconAnchor: [7, 7] }), interactive: false, keyboard: false }).addTo(this.map);
    this.pin = null;
    this.map.on('click', (e) => onPin?.(e.latlng.lat, e.latlng.lng));
    // Leaflet needs a size refresh once layout settles.
    new ResizeObserver(() => this.map.invalidateSize()).observe(el);
  }

  setArea(lat, lon, size, farKm) {
    const b = bboxFor(lat, lon, size);
    this.area.setBounds([[b.south, b.west], [b.north, b.east]]);
    if (farKm > 0) {
      const f = bboxFor(lat, lon, farKm * 1000);
      this.far.setBounds([[f.south, f.west], [f.north, f.east]]).addTo(this.map);
    } else {
      this.far.remove();
    }
    this.map.fitBounds(this.area.getBounds(), { padding: [30, 30] });
  }

  /** Camera position and view cone (yaw in radians, 0 = north, + = east; hfov in radians). */
  setCamera(lat, lon, yaw, hfov, reachM) {
    this.cam.setLatLng([lat, lon]);
    const pts = [[lat, lon]];
    const mPerLat = 110574, mPerLon = 111320 * Math.cos((lat * Math.PI) / 180);
    for (let i = 0; i <= 8; i++) {
      const a = yaw - hfov / 2 + (hfov * i) / 8;
      pts.push([lat + (Math.cos(a) * reachM) / mPerLat, lon + (Math.sin(a) * reachM) / mPerLon]);
    }
    this.cone.setLatLngs(pts);
  }

  setPin(lat, lon) {
    if (lat == null) {
      this.pin?.remove();
      this.pin = null;
      return;
    }
    if (!this.pin) this.pin = L.marker([lat, lon], { keyboard: false }).addTo(this.map);
    else this.pin.setLatLng([lat, lon]);
  }
}
