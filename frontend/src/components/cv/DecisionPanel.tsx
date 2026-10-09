import { useState, type FormEvent } from 'react';
import { cvService } from '../../services/cvService.js';
import { apiErrorMessage } from '../../utils/apiError.js';
import { CV_CATEGORIES, type CvDecisionRecord, type CvDecisionRequest, type CvRecommendation, type DecisionType } from '../../types/index.js';

const OPTIONS: Array<{ type: DecisionType; label: string; hint: string; active: string }> = [
  { type: 'ACCEPT', label: 'Accept', hint: 'Keep the AI recommendation as the final decision.', active: 'bg-green-600 text-white border-green-600' },
  { type: 'MODIFY', label: 'Modify', hint: 'Choose different categories. A reason is required.', active: 'bg-indigo-600 text-white border-indigo-600' },
  { type: 'REJECT', label: 'Reject', hint: 'No category is accepted. A reason is required.', active: 'bg-red-600 text-white border-red-600' },
];

interface FieldErrors {
  decisionType?: string;
  primary?: string;
  categories?: string;
  reason?: string;
}

function sameSet(a: string[], b: string[]) {
  return a.length === b.length && a.every(x => b.includes(x));
}

export function DecisionPanel({
  recommendation,
  onDecided,
  onCancel,
}: {
  recommendation: CvRecommendation;
  onDecided: (decision: CvDecisionRecord) => void;
  onCancel?: () => void;
}) {
  const [decisionType, setDecisionType] = useState<DecisionType | null>(null);
  const [primary, setPrimary] = useState(recommendation.primaryCategory);
  const [secondary, setSecondary] = useState<string[]>(recommendation.secondaryCategories);
  const [reason, setReason] = useState('');
  const [attempted, setAttempted] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

  const reasonRequired = decisionType === 'MODIFY' || decisionType === 'REJECT';

  function validate(): FieldErrors {
    const errors: FieldErrors = {};
    if (!decisionType) errors.decisionType = 'Choose Accept, Modify or Reject.';
    if (decisionType === 'MODIFY') {
      if (!primary) errors.primary = 'Choose a primary category.';
      if (primary === recommendation.primaryCategory && sameSet(secondary, recommendation.secondaryCategories)) {
        errors.categories = 'Change the primary and/or secondary categories - otherwise use Accept.';
      }
    }
    if (reasonRequired && !reason.trim()) {
      errors.reason = `A reason is required to ${decisionType === 'MODIFY' ? 'modify' : 'reject'} a recommendation.`;
    }
    return errors;
  }

  const errors = attempted ? validate() : {};
  const hasErrors = Object.keys(errors).length > 0;

  const choosePrimary = (value: string) => {
    setPrimary(value);
    setSecondary(current => current.filter(c => c !== value));
  };

  const toggleSecondary = (category: string) => {
    setSecondary(current => (current.includes(category) ? current.filter(c => c !== category) : [...current, category]));
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setAttempted(true);
    setServerError(null);
    if (Object.keys(validate()).length > 0 || !decisionType) return;

    const body: CvDecisionRequest = { decisionType };
    if (decisionType === 'MODIFY') {
      body.finalPrimaryCategory = primary;
      body.finalSecondaryCategories = secondary;
    }
    if (reason.trim()) body.reason = reason.trim();

    setSubmitting(true);
    try {
      const decision = await cvService.makeDecision(recommendation.id, body);
      onDecided(decision);
    } catch (err) {
      setServerError(apiErrorMessage(err, 'Could not save the decision.'));
    } finally {
      setSubmitting(false);
    }
  };

  const idPrefix = `decision-${recommendation.id}`;

  return (
    <form onSubmit={handleSubmit} noValidate className="space-y-4 rounded-lg border border-gray-200 bg-gray-50 p-4">
      <fieldset>
        <legend className="text-sm font-semibold text-gray-800">Your decision</legend>
        <p id={`${idPrefix}-rule`} className="mt-1 text-xs text-gray-600">
          Accept keeps the AI recommendation. <strong className="font-semibold">Modify and Reject require a reason.</strong>
        </p>
        <div
          className="mt-2 flex flex-wrap gap-2"
          role="radiogroup"
          aria-label="Decision"
          aria-describedby={`${idPrefix}-rule${errors.decisionType ? ` ${idPrefix}-type-error` : ''}`}
        >
          {OPTIONS.map(option => (
            <button
              key={option.type}
              type="button"
              role="radio"
              aria-checked={decisionType === option.type}
              onClick={() => setDecisionType(option.type)}
              disabled={submitting}
              className={`rounded-md border px-4 py-2 text-sm font-semibold disabled:opacity-50 ${
                decisionType === option.type ? option.active : 'border-gray-300 bg-white text-gray-700 hover:bg-gray-100'
              }`}
            >
              {decisionType === option.type && <span aria-hidden="true">✓ </span>}
              {option.label.toUpperCase()}
            </button>
          ))}
        </div>
        {decisionType && <p className="mt-1 text-xs text-gray-600">{OPTIONS.find(o => o.type === decisionType)?.hint}</p>}
        {errors.decisionType && (
          <p id={`${idPrefix}-type-error`} className="mt-1 text-sm text-red-700">
            {errors.decisionType}
          </p>
        )}
      </fieldset>

      {decisionType === 'MODIFY' && (
        <div className="space-y-3">
          <div>
            <label htmlFor={`${idPrefix}-primary`} className="block text-sm font-medium text-gray-700">
              Final primary category
            </label>
            <select
              id={`${idPrefix}-primary`}
              value={primary}
              onChange={e => choosePrimary(e.target.value)}
              aria-invalid={!!(errors.primary || errors.categories)}
              aria-describedby={errors.primary ? `${idPrefix}-primary-error` : errors.categories ? `${idPrefix}-categories-error` : undefined}
              className="mt-1 w-full max-w-sm rounded-md border border-gray-300 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              {CV_CATEGORIES.map(c => (
                <option key={c} value={c}>
                  {c}
                  {c === recommendation.primaryCategory ? ' (AI recommendation)' : ''}
                </option>
              ))}
            </select>
            {errors.primary && (
              <p id={`${idPrefix}-primary-error`} className="mt-1 text-sm text-red-700">
                {errors.primary}
              </p>
            )}
          </div>

          <fieldset>
            <legend className="text-sm font-medium text-gray-700">Final secondary categories (optional)</legend>
            <div className="mt-1 grid grid-cols-1 gap-1 sm:grid-cols-2 lg:grid-cols-3">
              {CV_CATEGORIES.filter(c => c !== primary).map(c => (
                <label key={c} className="flex items-center gap-2 text-sm text-gray-700">
                  <input type="checkbox" checked={secondary.includes(c)} onChange={() => toggleSecondary(c)} className="h-4 w-4" />
                  {c}
                </label>
              ))}
            </div>
          </fieldset>
          {errors.categories && (
            <p id={`${idPrefix}-categories-error`} className="text-sm text-red-700">
              {errors.categories}
            </p>
          )}
        </div>
      )}

      {decisionType && (
        <div>
          <label htmlFor={`${idPrefix}-reason`} className="block text-sm font-medium text-gray-700">
            Reason {reasonRequired ? <span className="text-red-700">(required)</span> : <span className="text-gray-500">(optional)</span>}
          </label>
          <textarea
            id={`${idPrefix}-reason`}
            value={reason}
            onChange={e => setReason(e.target.value)}
            rows={3}
            required={reasonRequired}
            disabled={submitting}
            aria-invalid={!!errors.reason}
            aria-describedby={errors.reason ? `${idPrefix}-reason-error` : undefined}
            className={`mt-1 w-full rounded-md border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 ${
              errors.reason ? 'border-red-400' : 'border-gray-300'
            }`}
            placeholder={reasonRequired ? 'Explain why you are changing this recommendation' : 'Optional note'}
          />
          {errors.reason && (
            <p id={`${idPrefix}-reason-error`} className="mt-1 text-sm text-red-700">
              {errors.reason}
            </p>
          )}
        </div>
      )}

      {serverError && (
        <p role="alert" className="rounded border border-red-200 bg-red-50 p-2 text-sm text-red-700">
          {serverError}
        </p>
      )}

      <div className="flex flex-wrap gap-2">
        <button
          type="submit"
          disabled={submitting || (attempted && hasErrors)}
          className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {submitting ? 'Saving...' : 'Submit decision'}
        </button>
        {onCancel && (
          <button type="button" onClick={onCancel} className="rounded-md border border-gray-300 bg-white px-4 py-2 text-sm text-gray-700 hover:bg-gray-100">
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}
