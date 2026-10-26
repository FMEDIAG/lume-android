// ¿La categoría elegida a mano no cuadra con lo que la IA ve en la foto?
// Bloquea la tasación, así que solo salta si la IA está muy segura, y nunca con "Auto" ni "Otro"
// (la salida de emergencia: si la IA se equivoca, el usuario elige "Otro" y puede tasar).
export const MISMATCH_MIN_CONFIDENCE = 70; // la detectada debe superar este %
export const PLAUSIBLE_CHOSEN_CONFIDENCE = 30; // si la elegida ya era candidata con este %, no se avisa

export function isCategoryMismatch(opts: {
  chosen: string;
  suggested: string | null;
  confidence: number | null;
  candidates: Array<{ category: string; confidence: number }>;
}): boolean {
  const { chosen, suggested, confidence, candidates } = opts;
  if (!suggested) return false;
  if (chosen === "auto" || chosen === "other" || suggested === "other") return false;
  if (chosen === suggested) return false;
  if ((confidence ?? 0) < MISMATCH_MIN_CONFIDENCE) return false;
  const chosenAsCandidate = candidates.find((c) => c.category === chosen);
  if ((chosenAsCandidate?.confidence ?? 0) >= PLAUSIBLE_CHOSEN_CONFIDENCE) return false;
  return true;
}
