// Simple, Zwift-like cycling physics: power -> speed on a given gradient.
const G = 9.81;
const RHO = 1.225; // air density

export class Physics {
  constructor({ riderKg = 75, bikeKg = 8, cda = 0.32, crr = 0.004 } = {}) {
    this.riderKg = riderKg;
    this.bikeKg = bikeKg;
    this.cda = cda;
    this.crr = crr;
    this.v = 0; // m/s
  }
  get mass() { return this.riderKg + this.bikeKg; }

  /**
   * Advance simulation.
   * @param {number} power watts
   * @param {number} grade e.g. 0.05 = 5%
   * @param {number} dt seconds
   * @param {number} draft 0..1 — fraction of air drag saved by drafting
   * @returns distance travelled (m)
   */
  step(power, grade, dt, draft = 0) {
    const m = this.mass;
    const theta = Math.atan(grade);
    const v = this.v;
    const fDrive = power / Math.max(v, 1.0); // cap force at very low speed
    const fAir = 0.5 * RHO * this.cda * (1 - draft) * v * v;
    const fRoll = this.crr * m * G * Math.cos(theta);
    const fGrav = m * G * Math.sin(theta);
    const fBrake = power < 1 && v < 0.3 ? v * m / Math.max(dt, 0.01) : 0;
    const a = (fDrive - fAir - (v > 0.05 ? fRoll : 0) - fGrav - fBrake) / (m + 1.2); // +wheel inertia
    this.v = Math.max(0, Math.min(30, v + a * dt));
    return ((v + this.v) / 2) * dt;
  }
}

/** Draft benefit (0..~0.35) given gap in metres to the nearest rider ahead. */
export function draftFactor(gap) {
  if (gap <= 0.3 || gap > 12) return 0;
  if (gap < 2) return 0.33;
  return 0.33 * (1 - (gap - 2) / 10);
}
