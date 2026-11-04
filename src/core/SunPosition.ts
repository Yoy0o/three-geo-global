import { Vector3 } from 'three';
import { DEG2RAD, TWO_PI } from './math';

/** Days since the J2000.0 epoch (2000-01-01 12:00 TT, ignoring the TT/UTC offset). */
function daysSinceJ2000(date: Date): number {
  return date.getTime() / 86_400_000 + 2440587.5 - 2451545.0;
}

/** Greenwich mean sidereal time in radians: rotation of ECEF relative to an inertial frame. */
export function greenwichMeanSiderealTime(date: Date): number {
  const n = daysSinceJ2000(date);
  const gmstHours = 18.697374558 + 24.06570982441908 * n;
  const rad = ((gmstHours % 24) / 24) * TWO_PI;
  return rad < 0 ? rad + TWO_PI : rad;
}

/**
 * Unit vector from the Earth's center towards the Sun in ECEF coordinates.
 * Low-precision solar ephemeris (about 0.01 deg), which is plenty for lighting.
 */
export function sunDirectionECEF(date: Date, result = new Vector3()): Vector3 {
  const n = daysSinceJ2000(date);
  const L = (280.46 + 0.9856474 * n) * DEG2RAD; // mean longitude
  const g = (357.528 + 0.9856003 * n) * DEG2RAD; // mean anomaly
  const lambda = L + (1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * DEG2RAD; // ecliptic longitude
  const epsilon = (23.439 - 0.0000004 * n) * DEG2RAD; // obliquity of the ecliptic

  const rightAscension = Math.atan2(Math.cos(epsilon) * Math.sin(lambda), Math.cos(lambda));
  const declination = Math.asin(Math.sin(epsilon) * Math.sin(lambda));

  const lon = rightAscension - greenwichMeanSiderealTime(date);
  const cosDec = Math.cos(declination);
  return result.set(cosDec * Math.cos(lon), cosDec * Math.sin(lon), Math.sin(declination));
}
