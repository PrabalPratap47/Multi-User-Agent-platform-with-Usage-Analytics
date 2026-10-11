import type { CvCategory, DecisionType, SentimentLabel } from '../../types/index.js';

/** Decision outcomes use one palette everywhere (badges, panels, charts): green / indigo / red. */
export const DECISION_COLORS: Record<DecisionType, string> = {
  ACCEPT: '#15803d', // green-700
  MODIFY: '#4f46e5', // indigo-600
  REJECT: '#dc2626', // red-600
};

/** Matches the sentiment badges: green / gray / red. */
export const SENTIMENT_COLORS: Record<SentimentLabel, string> = {
  POSITIVE: '#15803d', // green-700
  NEUTRAL: '#6b7280', // gray-500
  NEGATIVE: '#dc2626', // red-600
};

/**
 * Treemap tiles: a coordinated cool-to-warm set, distinct from the blue
 * confidence bars, each dark enough for white labels (WCAG AA, >= 4.5:1).
 */
export const CATEGORY_COLORS: Record<CvCategory, string> = {
  PSS: '#1d4ed8', // blue-700
  DCS: '#0e7490', // cyan-700
  'Front-End Developer': '#7c3aed', // violet-600
  'Back-End Developer': '#4338ca', // indigo-700
  'Web Automation': '#047857', // emerald-700
  'Mobile Automation': '#0f766e', // teal-700
  'AI Engineer': '#be185d', // pink-700
  'Chatbot Application Tester': '#b45309', // amber-700
  Other: '#475569', // slate-600
};
