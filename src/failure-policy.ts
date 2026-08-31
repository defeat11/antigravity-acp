/**
 * Stable operational failure taxonomy shared by account-routing call sites.
 * Only `quota_exhausted` is account-specific enough to justify failover.
 */

export type OperationalFailureKind =
  | "auth_required"
  | "quota_exhausted"
  | "model_capacity"
  | "network_error"
  | "permission_error"
  | "verify_failed"
  | "unknown";

export function classifyOperationalFailure(value: unknown): OperationalFailureKind {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? "");

  if (/not logged (?:in|into)|auth(?:entication)?[_ ]?required|login required|credential|unauthorized|failed to get oauth token|api key is missing/i.test(text)) {
    return "auth_required";
  }
  if (/MODEL_CAPACITY_EXHAUSTED|No capacity available|model capacity|servers? (?:are )?busy|service unavailable/i.test(text)) {
    return "model_capacity";
  }
  if (/quota|rate.?limit|out of (?:credit|quota)|usage limit|weekly limit|five.?hour limit|RESOURCE_EXHAUSTED|\b429\b|payment required|billing/i.test(text)) {
    return "quota_exhausted";
  }
  if (/EACCES|EPERM|permission denied|access is denied|operation not permitted/i.test(text)) {
    return "permission_error";
  }
  if (/verify (?:failed|failure)|tests? failed|assertion failed/i.test(text)) {
    return "verify_failed";
  }
  if (/ECONNRESET|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|network|socket|fetch failed|connection (?:closed|lost|failed)|dns/i.test(text)) {
    return "network_error";
  }
  return "unknown";
}

export function shouldFailOverAccount(value: unknown): boolean {
  return classifyOperationalFailure(value) === "quota_exhausted";
}
