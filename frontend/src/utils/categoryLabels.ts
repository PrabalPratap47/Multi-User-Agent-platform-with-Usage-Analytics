/**
 * Display names for CV category identifiers. Presentation only: the
 * identifiers themselves (e.g. "PSS") are what the API, database, prompts
 * and decision requests use, and are never replaced.
 */
const CATEGORY_DISPLAY_NAMES: Record<string, string> = {
  PSS: 'Passenger Service System',
  DCS: 'Departure Control System',
};

export function categoryLabel(category: string): string {
  return CATEGORY_DISPLAY_NAMES[category] ?? category;
}
