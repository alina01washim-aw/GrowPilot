/**
 * Vapor Pressure Deficit (VPD) calculation.
 *
 * VPD tells a grower how "thirsty" the air is relative to the substrate/fruit,
 * which is a much better cultivation signal than raw temp/humidity alone.
 *
 * @param tempC   Air temperature in Celsius
 * @param rh      Relative humidity in percent (0-100)
 * @returns VPD in kPa, rounded to 3 decimal places
 * @throws {RangeError} If inputs are invalid or out of reasonable bounds
 */
export function calculateVpd(tempC: number, rh: number): number {
  // Validate inputs
  if (!Number.isFinite(tempC) || !Number.isFinite(rh)) {
    throw new RangeError(`Invalid VPD inputs: tempC=${tempC}, rh=${rh}`);
  }

  // Check reasonable bounds for mushroom cultivation
  if (tempC < -10 || tempC > 50) {
    throw new RangeError(`Temperature ${tempC}°C is out of range (-10 to 50°C)`);
  }

  if (rh < 0 || rh > 100) {
    throw new RangeError(`Humidity ${rh}% is out of range (0 to 100%)`);
  }

  // Saturation vapor pressure (kPa) - Tetens/Magnus approximation
  const svp = 0.61078 * Math.exp((17.27 * tempC) / (tempC + 237.3));
  // Actual vapor pressure (kPa)
  const avp = svp * (rh / 100);
  const vpd = svp - avp;
  
  // Final sanity check
  if (!Number.isFinite(vpd)) {
    throw new RangeError(`VPD calculation produced invalid result: ${vpd}`);
  }

  return Math.round(vpd * 1000) / 1000;
}

// ─── True Crop Surface VPD (industry standard for mushroom cultivation) ──────
//
// Air-side VPD (above) only measures the ambient air. The grow-relevant signal
// is the vapor pressure deficit at the substrate/fruit surface:
//
//   surface_vpd = SVP(compost) − AVP(air)
//
// where SVP uses the Arden Buck equation and AVP is the air's actual vapor
// pressure at ambient RH. A positive surface VPD means the crop is losing
// moisture to the air (evaporation); a negative value means the air is more
// humid than the surface (condensation risk).

export type VpdStatusCode =
  | "DARK_GREEN"
  | "LIGHT_GREEN"
  | "YELLOW"
  | "ORANGE"
  | "RED";

export interface SurfaceVpdInputs {
  /** SHT40 ambient air temperature (°C). */
  airTempC: number;
  /** SHT40 relative humidity (%). */
  airRhPct: number;
  /** DS18B20 compost/substrate temperature (°C). */
  compostTempC: number;
}

export interface VpdTargets {
  /** Lower edge of the ideal surface VPD band (kPa). */
  targetMinKpa: number;
  /** Upper edge of the ideal surface VPD band (kPa). */
  targetMaxKpa: number;
  /** Tolerance (kPa) before a deviation escalates toward red. */
  warningMarginKpa: number;
}

/** Saturated vapor pressure via the Arden Buck equation (kPa). */
export function saturatedVaporPressureKpa(tempC: number): number {
  if (!Number.isFinite(tempC)) {
    throw new RangeError(`Invalid temperature for SVP: ${tempC}`);
  }
  return 0.61078 * Math.exp((17.27 * tempC) / (tempC + 237.3));
}

/** Actual vapor pressure of air at a given RH (kPa). */
export function actualVaporPressureKpa(tempC: number, rhPct: number): number {
  if (!Number.isFinite(rhPct) || rhPct < 0 || rhPct > 100) {
    throw new RangeError(`Humidity ${rhPct}% is out of range (0 to 100%)`);
  }
  return saturatedVaporPressureKpa(tempC) * (rhPct / 100);
}

/**
 * True crop surface VPD (kPa): SVP at compost temperature minus AVP of the air.
 * Rounded to 3 decimal places.
 */
export function calculateSurfaceVpd(inputs: SurfaceVpdInputs): number {
  const { airTempC, airRhPct, compostTempC } = inputs;
  if (!Number.isFinite(airTempC) || !Number.isFinite(compostTempC)) {
    throw new RangeError(
      `Invalid surface VPD inputs: airTempC=${airTempC}, compostTempC=${compostTempC}`,
    );
  }
  if (airTempC < -10 || airTempC > 50) {
    throw new RangeError(`Air temperature ${airTempC}°C is out of range (-10 to 50°C)`);
  }
  if (compostTempC < -10 || compostTempC > 60) {
    throw new RangeError(`Compost temperature ${compostTempC}°C is out of range (-10 to 60°C)`);
  }

  const svpCompost = saturatedVaporPressureKpa(compostTempC);
  const avpAir = actualVaporPressureKpa(airTempC, airRhPct);
  const vpd = svpCompost - avpAir;

  if (!Number.isFinite(vpd)) {
    throw new RangeError(`Surface VPD calculation produced invalid result: ${vpd}`);
  }
  return Math.round(vpd * 1000) / 1000;
}

/**
 * BP-monitor style 5-zone classification:
 *
 *   DARK_GREEN   — dead center of the ideal band
 *   LIGHT_GREEN  — inside the band, near an edge
 *   YELLOW       — slightly outside the band (within warning margin)
 *   ORANGE       — outside by up to 2× the warning margin
 *   RED          — severely out of range
 *
 * Low side = too humid / condensation risk; high side = too dry / drying risk.
 */
export function classifySurfaceVpd(
  vpdKpa: number,
  targets: VpdTargets,
): VpdStatusCode {
  const { targetMinKpa: min, targetMaxKpa: max, warningMarginKpa: m } = targets;
  if (!Number.isFinite(vpdKpa) || !Number.isFinite(min) || !Number.isFinite(max) || !Number.isFinite(m)) {
    throw new RangeError(`Invalid classification inputs: vpd=${vpdKpa}, targets=${JSON.stringify(targets)}`);
  }
  if (min >= max || m <= 0) {
    throw new RangeError(`Invalid VPD targets: min=${min}, max=${max}, margin=${m}`);
  }

  const width = max - min;
  const center = (min + max) / 2;
  const centerHalf = Math.max(width * 0.25, 0.02);

  if (vpdKpa >= center - centerHalf && vpdKpa <= center + centerHalf) {
    return "DARK_GREEN";
  }
  if (vpdKpa >= min && vpdKpa <= max) {
    return "LIGHT_GREEN";
  }
  if ((vpdKpa >= min - m && vpdKpa < min) || (vpdKpa > max && vpdKpa <= max + m)) {
    return "YELLOW";
  }
  if ((vpdKpa >= min - 2 * m && vpdKpa < min - m) || (vpdKpa > max + m && vpdKpa <= max + 2 * m)) {
    return "ORANGE";
  }
  return "RED";
}

/** Grower-friendly explanation for a zone, split by low/high side. */
export function surfaceVpdMessage(
  code: VpdStatusCode,
  vpdKpa: number,
  targets: VpdTargets,
): string {
  const above = vpdKpa > targets.targetMaxKpa;
  switch (code) {
    case "DARK_GREEN":
      return "Optimal — surface evaporation perfectly balanced.";
    case "LIGHT_GREEN":
      return "Acceptable — within target range, near the edge.";
    case "YELLOW":
      return above
        ? "Mild — air slightly dry; surface evaporation a touch high."
        : "Mild — air slightly humid; surface evaporation a touch low.";
    case "ORANGE":
      return above
        ? "Moderate — surface drying; pinhead desiccation risk rising."
        : "Moderate — condensation/stagnation risk rising; increase airflow.";
    case "RED":
      return above
        ? "Critical — severe drying; pinheads will desiccate."
        : "Critical — near-saturated air; fungal infection risk.";
  }
}
