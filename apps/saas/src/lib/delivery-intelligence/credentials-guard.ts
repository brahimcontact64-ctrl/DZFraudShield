import { createHash } from "node:crypto";

const ZR_PROVIDER_CODE = "zr_express";
const YALIDINE_PROVIDER_CODE = "yalidine";
const PROCOLIS_PROVIDER_CODE = "procolis";

const PLACEHOLDER_TOKENS = ["tenant-audit", "key-audit", "test", "mock", "placeholder", "demo"];

export class DeliveryCredentialValidationError extends Error {
  public readonly issues: string[];

  constructor(message: string, issues: string[]) {
    super(message);
    this.name = "DeliveryCredentialValidationError";
    this.issues = issues;
  }
}

function normalizeValue(value: string | null | undefined): string {
  return String(value ?? "").trim();
}

function lowerValue(value: string | null | undefined): string {
  return normalizeValue(value).toLowerCase();
}

function firstNonEmpty(...values: Array<string | null | undefined>): string {
  for (const value of values) {
    const normalized = normalizeValue(value);
    if (normalized) {
      return normalized;
    }
  }
  return "";
}

function detectToken(value: string): string | null {
  for (const token of PLACEHOLDER_TOKENS) {
    if (value.includes(token)) {
      return token;
    }
  }
  return null;
}

function safeHash(value: string | null | undefined): string | null {
  const normalized = normalizeValue(value);
  if (!normalized) {
    return null;
  }
  return createHash("sha256").update(normalized).digest("hex");
}

export function resolveZrCredentialValues(credentials: Record<string, string>) {
  const tenantId = normalizeValue(credentials.tenantId ?? credentials.tenant ?? credentials["X-Tenant"]);
  const apiKey = normalizeValue(credentials.apiKey ?? credentials.secretKey ?? credentials.key ?? credentials.token);
  const tenantHeaderName = normalizeValue(credentials.tenantHeaderName) || "X-Tenant";
  const apiHeaderName = normalizeValue(credentials.headerName ?? credentials.secretHeaderName) || "X-Api-Key";

  return {
    tenantId,
    apiKey,
    tenantHeaderName,
    apiHeaderName,
  };
}

export function resolveYalidineCredentialValues(credentials: Record<string, string>) {
  const tenantId = firstNonEmpty(
    credentials.tenantId,
    credentials.apiId,
    credentials.api_id,
    credentials.tenant,
    credentials.id,
    credentials["X-API-ID"]
  );

  const apiKey = firstNonEmpty(
    credentials.apiKey,
    credentials.apiToken,
    credentials.api_token,
    credentials.token,
    credentials.key,
    credentials.secretKey,
    credentials["X-API-TOKEN"]
  );

  return {
    tenantId,
    apiKey,
  };
}

export function normalizeYalidineCredentialsForStorage(provider: string, credentials: Record<string, string>) {
  if (provider === PROCOLIS_PROVIDER_CODE) {
    return {
      token: firstNonEmpty(credentials.token, credentials.apiToken, credentials["token"]),
      key: firstNonEmpty(credentials.key, credentials.apiKey, credentials.secretKey, credentials["key"]),
    };
  }

  if (provider !== YALIDINE_PROVIDER_CODE) {
    return credentials;
  }

  const resolved = resolveYalidineCredentialValues(credentials);
  return {
    tenantId: resolved.tenantId,
    apiKey: resolved.apiKey,
  };
}

export function buildYalidineRuntimeCredentials(provider: string, credentials: Record<string, string>) {
  if (provider !== YALIDINE_PROVIDER_CODE) {
    return credentials;
  }

  const normalized = normalizeYalidineCredentialsForStorage(provider, credentials);
  const runtime: Record<string, string> = {
    ...normalized,
    headerName: "X-API-TOKEN",
  };

  if (normalized.tenantId) {
    runtime.customHeaders = JSON.stringify({ "X-API-ID": normalized.tenantId });
  }

  return runtime;
}

export function detectPlaceholderCredentials(provider: string, credentials: Record<string, string>) {
  if (provider !== ZR_PROVIDER_CODE) {
    return {
      hasPlaceholders: false,
      issues: [] as string[],
    };
  }

  const issues: string[] = [];
  for (const [key, rawValue] of Object.entries(credentials)) {
    const normalized = lowerValue(rawValue);
    if (!normalized) {
      continue;
    }
    const matchedToken = detectToken(normalized);
    if (matchedToken) {
      issues.push(`Credential ${key} contains forbidden placeholder pattern: ${matchedToken}`);
    }
  }

  return {
    hasPlaceholders: issues.length > 0,
    issues,
  };
}

export function validateZrCredentialsForSave(provider: string, credentials: Record<string, string>) {
  if (provider !== ZR_PROVIDER_CODE) {
    return;
  }

  const { tenantId, apiKey } = resolveZrCredentialValues(credentials);
  const missing: string[] = [];
  if (!tenantId) {
    missing.push("tenantId");
  }
  if (!apiKey) {
    missing.push("apiKey");
  }

  const placeholderResult = detectPlaceholderCredentials(provider, credentials);
  const issues = [...placeholderResult.issues];
  if (missing.length > 0) {
    issues.unshift(`Missing required ZR credentials: ${missing.join(", ")}`);
  }

  if (issues.length > 0) {
    throw new DeliveryCredentialValidationError(
      "Invalid ZR Express credentials. Placeholder/test credentials are not allowed.",
      issues,
    );
  }
}

export function buildCredentialFingerprints(provider: string, credentials: Record<string, string>) {
  if (provider !== ZR_PROVIDER_CODE) {
    return {
      tenantId: null,
      apiKey: null,
    };
  }

  const resolved = resolveZrCredentialValues(credentials);
  return {
    tenantId: safeHash(resolved.tenantId),
    apiKey: safeHash(resolved.apiKey),
  };
}
