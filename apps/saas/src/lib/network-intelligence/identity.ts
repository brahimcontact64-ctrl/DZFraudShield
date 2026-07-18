export type IdentityConfidence = "HIGH" | "MEDIUM" | "LOW";

export type IdentityCandidate = {
  id: string;
  phoneHashMatch: boolean;
  normalizedName?: string | null;
  normalizedAddress?: string | null;
  wilaya?: string | null;
  commune?: string | null;
};

export type IdentityInsights = {
  confidence: IdentityConfidence;
  confidenceScore: number;
  linkedIdentityCount: number;
  phoneIdentityCount: number;
  suspiciousIdentityChanges: boolean;
  reasons: string[];
};

function tokenize(value: string | null | undefined): Set<string> {
  const normalized = (value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ");

  if (!normalized) {
    return new Set();
  }

  return new Set(normalized.split(" ").filter(Boolean));
}

function jaccardSimilarity(a: string | null | undefined, b: string | null | undefined): number {
  const setA = tokenize(a);
  const setB = tokenize(b);

  if (setA.size === 0 || setB.size === 0) {
    return 0;
  }

  let intersection = 0;
  for (const token of setA) {
    if (setB.has(token)) {
      intersection += 1;
    }
  }

  const union = setA.size + setB.size - intersection;
  if (union <= 0) {
    return 0;
  }

  return intersection / union;
}

function normalizeArea(value: string | null | undefined): string {
  return (value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\b(commune|wilaya|de|da[iy]ra)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function buildIdentityInsights(params: {
  normalizedName?: string | null;
  normalizedAddress?: string | null;
  wilaya?: string | null;
  commune?: string | null;
  candidates: IdentityCandidate[];
}): IdentityInsights {
  const reasons: string[] = [];

  const deduped = new Map<string, IdentityCandidate>();
  for (const candidate of params.candidates) {
    deduped.set(candidate.id, candidate);
  }

  const candidates = Array.from(deduped.values());
  const linkedIdentityCount = candidates.length;
  const phoneIdentityCount = candidates.filter((candidate) => candidate.phoneHashMatch).length + 1;

  let strongestSignal = 0;
  let hadAddressAlias = false;
  let hadNameAlias = false;

  for (const candidate of candidates) {
    let score = 0;

    if (candidate.phoneHashMatch) {
      score += 45;
    }

    const nameSimilarity = jaccardSimilarity(params.normalizedName, candidate.normalizedName);
    if (nameSimilarity >= 0.7) {
      score += 20;
    } else if (nameSimilarity >= 0.4) {
      score += 10;
      hadNameAlias = true;
    }

    const addressSimilarity = jaccardSimilarity(params.normalizedAddress, candidate.normalizedAddress);
    if (addressSimilarity >= 0.75) {
      score += 20;
    } else if (addressSimilarity >= 0.4) {
      score += 10;
      hadAddressAlias = true;
    }

    if (normalizeArea(params.wilaya) && normalizeArea(params.wilaya) === normalizeArea(candidate.wilaya)) {
      score += 10;
    }

    if (normalizeArea(params.commune) && normalizeArea(params.commune) === normalizeArea(candidate.commune)) {
      score += 5;
    } else {
      const communeSimilarity = jaccardSimilarity(normalizeArea(params.commune), normalizeArea(candidate.commune));
      if (communeSimilarity >= 0.5) {
        score += 3;
      }
    }

    strongestSignal = Math.max(strongestSignal, score);
  }

  let confidenceScore = Math.max(20, strongestSignal);

  if (phoneIdentityCount >= 3) {
    confidenceScore -= 20;
    reasons.push(`Phone linked to ${phoneIdentityCount} identities`);
  }

  if (phoneIdentityCount >= 4) {
    confidenceScore -= 10;
    reasons.push("Potential phone-rotation evasion pattern");
  }

  if (linkedIdentityCount >= 4) {
    confidenceScore -= 10;
    reasons.push(`Identity linked to ${linkedIdentityCount} network profiles`);
  }

  if (linkedIdentityCount >= 6) {
    confidenceScore -= 10;
    reasons.push("Possible merchant hopping pattern");
  }

  if (hadAddressAlias) {
    reasons.push("Address partially matches another risky identity profile");
  }

  if (hadNameAlias) {
    reasons.push("Name variation matches known profile");
  }

  confidenceScore = Math.max(0, Math.min(100, Math.round(confidenceScore)));

  let confidence: IdentityConfidence;
  if (confidenceScore >= 75) {
    confidence = "HIGH";
  } else if (confidenceScore >= 45) {
    confidence = "MEDIUM";
  } else {
    confidence = "LOW";
  }

  const suspiciousIdentityChanges = confidence === "LOW" || phoneIdentityCount >= 3 || linkedIdentityCount >= 4;

  if (candidates.length === 0) {
    reasons.push("No historical identity links found");
  } else if (reasons.length === 0) {
    reasons.push("Strong deterministic identity linkage");
  }

  return {
    confidence,
    confidenceScore,
    linkedIdentityCount,
    phoneIdentityCount,
    suspiciousIdentityChanges,
    reasons
  };
}

export type ClusterInsights = {
  score: number;
  summary: string;
  reasons: string[];
  addressLinkedRefusedCustomers: number;
  phoneIdentityCount: number;
};

export function buildClusterInsights(params: {
  addressLinkedRefusedCustomers: number;
  phoneIdentityCount: number;
  multiMerchantIncidents: number;
}): ClusterInsights {
  const reasons: string[] = [];
  let score = 0;

  if (params.addressLinkedRefusedCustomers >= 2) {
    score += 20;
    reasons.push(`Address linked to ${params.addressLinkedRefusedCustomers} refused customers`);
  }

  if (params.phoneIdentityCount >= 3) {
    score += 15;
    reasons.push(`Phone reused across ${params.phoneIdentityCount} identities`);
  }

  if (params.multiMerchantIncidents >= 3) {
    score += 10;
    reasons.push(`Seen in ${params.multiMerchantIncidents} merchant incident records`);
  }

  if (params.multiMerchantIncidents >= 5) {
    score += 10;
    reasons.push("Escalated merchant hopping signal");
  }

  if (score >= 35) {
    reasons.unshift("High-risk fraud cluster detected");
  } else if (score >= 20) {
    reasons.unshift("Medium-risk linked cluster detected");
  } else {
    reasons.push("No strong cluster signal");
  }

  const summary = score >= 35 ? "HIGH_CLUSTER_RISK" : score >= 20 ? "MEDIUM_CLUSTER_RISK" : "LOW_CLUSTER_RISK";

  return {
    score: Math.max(0, Math.min(100, score)),
    summary,
    reasons,
    addressLinkedRefusedCustomers: params.addressLinkedRefusedCustomers,
    phoneIdentityCount: params.phoneIdentityCount
  };
}
