// Web Bluetooth: smart trainers (FTMS), power meters (Cycling Power) and HR straps.
// Works in Chrome / Edge on Windows, macOS, Android, ChromeOS (not iOS Safari).

const FTMS = 0x1826;
const INDOOR_BIKE_DATA = 0x2ad2;
const FTMS_CONTROL_POINT = 0x2ad9;
const CYCLING_POWER = 0x1818;
const CP_MEASUREMENT = 0x2a63;
const HEART_RATE = 0x180d;
const HR_MEASUREMENT = 0x2a37;

export const bluetoothAvailable = () => !!(navigator.bluetooth && navigator.bluetooth.requestDevice);

export class Trainer extends EventTarget {
  constructor() {
    super();
    this.device = null;
    this.controlPoint = null;
    this.mode = null; // 'ftms' | 'power'
    this.power = 0;
    this.cadence = 0;
    this.lastData = 0;
    this._queue = Promise.resolve();
    this._lastCrank = null;
  }

  get connected() { return !!(this.device && this.device.gatt.connected); }
  get name() { return this.device ? this.device.name || 'Trener' : ''; }
  get canControl() { return !!this.controlPoint; }

  async connect() {
    this.device = await navigator.bluetooth.requestDevice({
      filters: [{ services: [FTMS] }, { services: [CYCLING_POWER] }],
      optionalServices: [FTMS, CYCLING_POWER],
    });
    this.device.addEventListener('gattserverdisconnected', () => {
      this.controlPoint = null;
      this.dispatchEvent(new Event('disconnected'));
    });
    const server = await this.device.gatt.connect();
    let ftms = null;
    try { ftms = await server.getPrimaryService(FTMS); } catch { /* not an FTMS device */ }

    if (ftms) {
      this.mode = 'ftms';
      const data = await ftms.getCharacteristic(INDOOR_BIKE_DATA);
      data.addEventListener('characteristicvaluechanged', (e) => this._onIndoorBikeData(e.target.value));
      await data.startNotifications();
      try {
        this.controlPoint = await ftms.getCharacteristic(FTMS_CONTROL_POINT);
        await this.controlPoint.startNotifications(); // required for indications
        await this._write([0x00]); // Request control
        await this._write([0x07]); // Start / resume
      } catch (err) {
        console.warn('FTMS control not available', err);
        this.controlPoint = null;
      }
    } else {
      this.mode = 'power';
      const cps = await server.getPrimaryService(CYCLING_POWER);
      const meas = await cps.getCharacteristic(CP_MEASUREMENT);
      meas.addEventListener('characteristicvaluechanged', (e) => this._onCyclingPower(e.target.value));
      await meas.startNotifications();
    }
    this.dispatchEvent(new Event('connected'));
  }

  disconnect() {
    if (!this.device || !this.device.gatt.connected) return;
    // FTMS: give control back (op 0x01 Reset) before dropping the link, so the trainer is free for other apps
    const done = () => { try { this.device.gatt.disconnect(); } catch {} };
    if (this.controlPoint) {
      try { this.controlPoint.writeValue(new Uint8Array([0x01])).then(done, done); } catch { done(); }
      setTimeout(done, 300);
    } else done();
  }

  /** Send simulated gradient to the trainer (FTMS op 0x11). grade e.g. 0.05 */
  setSimulation(grade, { crr = 0.004, cw = 0.51, wind = 0 } = {}) {
    if (!this.controlPoint) return Promise.resolve();
    const buf = new DataView(new ArrayBuffer(7));
    buf.setUint8(0, 0x11);
    buf.setInt16(1, Math.round(wind * 1000), true);
    buf.setInt16(3, Math.round(Math.max(-0.2, Math.min(0.2, grade)) * 10000), true);
    buf.setUint8(5, Math.round(crr * 10000));
    buf.setUint8(6, Math.round(cw * 100));
    return this._write(new Uint8Array(buf.buffer));
  }

  _write(bytes) {
    const cp = this.controlPoint;
    this._queue = this._queue
      .then(() => cp && cp.writeValueWithResponse(new Uint8Array(bytes)))
      .then(() => new Promise((r) => setTimeout(r, 60)))
      .catch((e) => console.warn('FTMS write failed', e));
    return this._queue;
  }

  _emit() {
    this.lastData = performance.now();
    this.dispatchEvent(new Event('data'));
  }

  _onIndoorBikeData(dv) {
    const flags = dv.getUint16(0, true);
    let o = 2;
    if (!(flags & 0x0001)) o += 2; // instantaneous speed
    if (flags & 0x0002) o += 2; // average speed
    if (flags & 0x0004) { this.cadence = dv.getUint16(o, true) / 2; o += 2; }
    if (flags & 0x0008) o += 2; // average cadence
    if (flags & 0x0010) o += 3; // total distance
    if (flags & 0x0020) o += 2; // resistance level
    if (flags & 0x0040) { this.power = Math.max(0, dv.getInt16(o, true)); o += 2; }
    this._emit();
  }

  _onCyclingPower(dv) {
    const flags = dv.getUint16(0, true);
    this.power = Math.max(0, dv.getInt16(2, true));
    let o = 4;
    if (flags & 0x01) o += 1; // pedal power balance
    if (flags & 0x04) o += 2; // accumulated torque
    if (flags & 0x10) o += 6; // wheel revolution data
    if (flags & 0x20) {
      const revs = dv.getUint16(o, true);
      const time = dv.getUint16(o + 2, true); // 1/1024 s
      if (this._lastCrank) {
        const dr = (revs - this._lastCrank.revs + 65536) % 65536;
        const dt = ((time - this._lastCrank.time + 65536) % 65536) / 1024;
        if (dt > 0) this.cadence = (dr / dt) * 60;
        else if (performance.now() - this._lastCrank.at > 3000) this.cadence = 0;
      }
      if (!this._lastCrank || revs !== this._lastCrank.revs) this._lastCrank = { revs, time, at: performance.now() };
    }
    this._emit();
  }
}

export class HeartRate extends EventTarget {
  disconnect() { try { if (this.device && this.device.gatt.connected) this.device.gatt.disconnect(); } catch {} }
  constructor() { super(); this.device = null; this.hr = 0; }
  get connected() { return !!(this.device && this.device.gatt.connected); }
  async connect() {
    this.device = await navigator.bluetooth.requestDevice({ filters: [{ services: [HEART_RATE] }] });
    this.device.addEventListener('gattserverdisconnected', () => this.dispatchEvent(new Event('disconnected')));
    const server = await this.device.gatt.connect();
    const svc = await server.getPrimaryService(HEART_RATE);
    const ch = await svc.getCharacteristic(HR_MEASUREMENT);
    ch.addEventListener('characteristicvaluechanged', (e) => {
      const dv = e.target.value;
      this.hr = dv.getUint8(0) & 1 ? dv.getUint16(1, true) : dv.getUint8(1);
      this.dispatchEvent(new Event('data'));
    });
    await ch.startNotifications();
    this.dispatchEvent(new Event('connected'));
  }
}
