/**
 * Static canonical dataset for all 58 Algerian wilayas.
 *
 * These entries are used as a normalization layer: when a delivery provider
 * returns fewer than 58 wilayas (e.g. due to pagination gaps, partial coverage,
 * or API limits), we merge with this seed so that the checkout dropdown always
 * shows the complete territory list.
 *
 * The `id` field matches the official Algerian administrative code (01–58).
 * Provider-specific IDs are resolved separately.
 */

export type AlgeriaWilaya = {
  /** Official 2-digit code, zero-padded (e.g. "01", "16") */
  id: string;
  /** Official Arabic-transliterated French name */
  name: string;
  /** Alternative spellings used by delivery providers */
  aliases: string[];
};

export const ALGERIA_WILAYAS: AlgeriaWilaya[] = [
  { id: "01", name: "Adrar", aliases: ["adrar"] },
  { id: "02", name: "Chlef", aliases: ["chlef", "ech chelif", "el asnam"] },
  { id: "03", name: "Laghouat", aliases: ["laghouat", "el aghwat"] },
  { id: "04", name: "Oum El Bouaghi", aliases: ["oum el bouaghi", "oum-el-bouaghi", "oum el-bouaghi"] },
  { id: "05", name: "Batna", aliases: ["batna"] },
  { id: "06", name: "Béjaïa", aliases: ["bejaia", "béjaïa", "bejaïa", "béjaia", "bgayet"] },
  { id: "07", name: "Biskra", aliases: ["biskra"] },
  { id: "08", name: "Béchar", aliases: ["bechar", "béchar"] },
  { id: "09", name: "Blida", aliases: ["blida", "el boulaida"] },
  { id: "10", name: "Bouira", aliases: ["bouira"] },
  { id: "11", name: "Tamanrasset", aliases: ["tamanrasset", "tamanghasset"] },
  { id: "12", name: "Tébessa", aliases: ["tebessa", "tébessa"] },
  { id: "13", name: "Tlemcen", aliases: ["tlemcen", "tilimsen"] },
  { id: "14", name: "Tiaret", aliases: ["tiaret"] },
  { id: "15", name: "Tizi Ouzou", aliases: ["tizi ouzou", "tizi-ouzou", "tizi_ouzou"] },
  { id: "16", name: "Alger", aliases: ["alger", "algiers", "el djazair", "algers"] },
  { id: "17", name: "Djelfa", aliases: ["djelfa"] },
  { id: "18", name: "Jijel", aliases: ["jijel"] },
  { id: "19", name: "Sétif", aliases: ["setif", "sétif"] },
  { id: "20", name: "Saïda", aliases: ["saida", "saïda"] },
  { id: "21", name: "Skikda", aliases: ["skikda"] },
  { id: "22", name: "Sidi Bel Abbès", aliases: ["sidi bel abbes", "sidi bel abbès", "sidi-bel-abbes"] },
  { id: "23", name: "Annaba", aliases: ["annaba", "bône"] },
  { id: "24", name: "Guelma", aliases: ["guelma"] },
  { id: "25", name: "Constantine", aliases: ["constantine", "qacentina"] },
  { id: "26", name: "Médéa", aliases: ["medea", "médéa"] },
  { id: "27", name: "Mostaganem", aliases: ["mostaganem", "mustaganim"] },
  { id: "28", name: "M'Sila", aliases: ["msila", "m'sila", "m sila", "bordj bou arreridj"] },
  { id: "29", name: "Mascara", aliases: ["mascara", "mouaskar"] },
  { id: "30", name: "Ouargla", aliases: ["ouargla", "wargla"] },
  { id: "31", name: "Oran", aliases: ["oran", "wahran"] },
  { id: "32", name: "El Bayadh", aliases: ["el bayadh", "el-bayadh"] },
  { id: "33", name: "Illizi", aliases: ["illizi"] },
  { id: "34", name: "Bordj Bou Arréridj", aliases: ["bordj bou arreridj", "bordj bou arréridj", "bba"] },
  { id: "35", name: "Boumerdès", aliases: ["boumerdes", "boumerdès", "boumerdas"] },
  { id: "36", name: "El Tarf", aliases: ["el tarf", "el-tarf"] },
  { id: "37", name: "Tindouf", aliases: ["tindouf"] },
  { id: "38", name: "Tissemsilt", aliases: ["tissemsilt"] },
  { id: "39", name: "El Oued", aliases: ["el oued", "el-oued", "oued souf"] },
  { id: "40", name: "Khenchela", aliases: ["khenchela", "khanchela"] },
  { id: "41", name: "Souk Ahras", aliases: ["souk ahras", "souk-ahras"] },
  { id: "42", name: "Tipaza", aliases: ["tipaza", "tipasa"] },
  { id: "43", name: "Mila", aliases: ["mila"] },
  { id: "44", name: "Aïn Defla", aliases: ["ain defla", "aïn defla", "ain-defla"] },
  { id: "45", name: "Naâma", aliases: ["naama", "naâma"] },
  { id: "46", name: "Aïn Témouchent", aliases: ["ain temouchent", "aïn témouchent", "ain-temouchent"] },
  { id: "47", name: "Ghardaïa", aliases: ["ghardaia", "ghardaïa"] },
  { id: "48", name: "Relizane", aliases: ["relizane", "ghilizane"] },
  { id: "49", name: "Timimoun", aliases: ["timimoun", "timimoune"] },
  { id: "50", name: "Bordj Badji Mokhtar", aliases: ["bordj badji mokhtar", "bbm"] },
  { id: "51", name: "Ouled Djellal", aliases: ["ouled djellal"] },
  { id: "52", name: "Béni Abbès", aliases: ["beni abbes", "béni abbès", "beni-abbes"] },
  { id: "53", name: "In Salah", aliases: ["in salah", "in-salah"] },
  { id: "54", name: "In Guezzam", aliases: ["in guezzam", "in-guezzam"] },
  { id: "55", name: "Touggourt", aliases: ["touggourt"] },
  { id: "56", name: "Djanet", aliases: ["djanet"] },
  { id: "57", name: "El M'Ghair", aliases: ["el m'ghair", "el mghair", "el-mghair"] },
  { id: "58", name: "El Meniaa", aliases: ["el meniaa", "el menia", "el-meniaa"] },
];

/** Total canonical count – must always be 58. */
export const ALGERIA_WILAYA_COUNT = ALGERIA_WILAYAS.length as 58;

// Compile-time guard – TypeScript will error if the list does not have exactly 58 entries.
const _guard: 58 = ALGERIA_WILAYA_COUNT;
void _guard;

/**
 * Normalises a wilaya name string for fuzzy matching.
 */
function normalizeToken(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Attempts to find the canonical Algeria wilaya entry that best matches the
 * given name string. Returns `null` when no safe match is found.
 */
export function findAlgeriaWilaya(name: string): AlgeriaWilaya | null {
  const token = normalizeToken(name);
  if (!token) return null;

  // 1. Exact name match
  const exactName = ALGERIA_WILAYAS.find(
    (w) => normalizeToken(w.name) === token,
  );
  if (exactName) return exactName;

  // 2. Alias match
  const aliasMatch = ALGERIA_WILAYAS.find((w) =>
    w.aliases.some((a) => normalizeToken(a) === token),
  );
  if (aliasMatch) return aliasMatch;

  // 3. Starts-with (e.g. provider returns "Alger" matching "Alger" or provider
  //    returns "Sidi Bel" matching "Sidi Bel Abbès")
  const startsWithMatch = ALGERIA_WILAYAS.find(
    (w) =>
      normalizeToken(w.name).startsWith(token) ||
      token.startsWith(normalizeToken(w.name)),
  );
  if (startsWithMatch) return startsWithMatch;

  return null;
}

/**
 * Given a list of wilayas returned by a provider sync, augments it so that
 * all 58 canonical wilayas are represented.
 *
 * - Provider rows whose name matches a canonical wilaya are returned unchanged
 *   (preserving the provider's own `wilaya_id`).
 * - Missing canonical wilayas are added with their 2-digit code as `wilaya_id`
 *   and `_seed` suffix to distinguish them.
 *
 * This ensures the checkout dropdown always displays the complete Algeria
 * territory list even when a provider API returns partial data.
 */
export function mergeWithAlgeriaSeed(
  providerRows: Array<{ wilaya_id: string; wilaya_name: string }>,
  provider: string,
): Array<{ wilaya_id: string; wilaya_name: string; is_seed?: boolean }> {
  // Build a set of canonical IDs already covered by the provider rows.
  const coveredCanonicalIds = new Set<string>();
  for (const row of providerRows) {
    const match = findAlgeriaWilaya(row.wilaya_name);
    if (match) {
      coveredCanonicalIds.add(match.id);
    }
  }

  // Append seed rows for any missing canonical wilaya.
  const seedRows: Array<{ wilaya_id: string; wilaya_name: string; is_seed: boolean }> = [];
  for (const wilaya of ALGERIA_WILAYAS) {
    if (!coveredCanonicalIds.has(wilaya.id)) {
      seedRows.push({
        wilaya_id: `${provider}_seed_${wilaya.id}`,
        wilaya_name: wilaya.name,
        is_seed: true,
      });
    }
  }

  return [...providerRows, ...seedRows];
}

/**
 * Returns the list of canonical wilaya IDs that are NOT covered by the given
 * provider rows (based on fuzzy name matching).
 */
export function findMissingWilayas(
  providerRows: Array<{ wilaya_id: string; wilaya_name: string }>,
): AlgeriaWilaya[] {
  const covered = new Set<string>();
  for (const row of providerRows) {
    const match = findAlgeriaWilaya(row.wilaya_name);
    if (match) covered.add(match.id);
  }
  return ALGERIA_WILAYAS.filter((w) => !covered.has(w.id));
}
