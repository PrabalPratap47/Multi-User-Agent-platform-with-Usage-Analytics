interface ApiErrorShape {
  response?: {
    status?: number;
    data?: { error?: string; details?: { fields?: Array<{ field: string; message: string }> } };
  };
  message?: string;
}

/** A readable message for a failed API call, including per-field validation messages. */
export function apiErrorMessage(err: unknown, fallback = 'The request failed.'): string {
  const e = err as ApiErrorShape;
  if (!e?.response) {
    return 'Could not reach the server. Check that the backend is running and try again.';
  }
  const { status, data } = e.response;
  if (status === 403) return 'You do not have access to this item.';
  const fields = data?.details?.fields;
  if (fields?.length) {
    return fields.map(f => (f.field ? `${f.field}: ${f.message}` : f.message)).join('; ');
  }
  return data?.error ?? fallback;
}
