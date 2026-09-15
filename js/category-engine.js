// ------------------------------------------------------------
// Category Engine (Fully Rewritten)
// ------------------------------------------------------------

import {
  buildCandidateUrls,
  fetchJsonWithFallback
} from "./resource-loader.js";

// Loaded dynamically via fetch()
let categories = [];
const categoriesById = new Map();

const CATEGORY_SOURCE_CONFIG = [
  {
    label: "generated categories",
    preferredAbsolutePath: "/castaway-cross/frontend/data/generated-categories.json",
    relativeFromModule: "../data/generated-categories.json"
  },
  {
    label: "manual categories",
    preferredAbsolutePath: "/castaway-cross/frontend/data/manual-categories.json",
    relativeFromModule: "../data/manual-categories.json"
  }
];

async function fetchCategorySource(sourceConfig) {
  const loadedCategories = await fetchJsonWithFallback({
    label: sourceConfig.label,
    candidates: buildCandidateUrls({
      preferredAbsolutePath: sourceConfig.preferredAbsolutePath,
      relativeFromModule: sourceConfig.relativeFromModule,
      moduleUrl: import.meta.url
    })
  });

  if (!Array.isArray(loadedCategories)) {
    throw new Error("Invalid category payload (expected an array)");
  }

  return loadedCategories;
}

// ------------------------------------------------------------
// Load generated-categories.json
// ------------------------------------------------------------
export async function loadCategories() {
  let lastError = null;

  for (let sourceIndex = 0; sourceIndex < CATEGORY_SOURCE_CONFIG.length; sourceIndex += 1) {
    const sourceConfig = CATEGORY_SOURCE_CONFIG[sourceIndex];

    try {
      const loaded = await fetchCategorySource(sourceConfig);

      categories = loaded;
      categoriesById.clear();
      categories.forEach(category => {
        categoriesById.set(category.id, category);
      });

      if (sourceIndex > 0) {
        console.warn(`[category-engine] Falling back to category source: ${sourceConfig.label}`);
      }

      return;
    } catch (error) {
      lastError = error;
      console.warn(`[category-engine] Failed to load categories from ${sourceConfig.label}`, error);
    }
  }

  throw new Error(
    `[category-engine] Unable to load categories from all configured sources. Last error: ${lastError?.message || "unknown"}`
  );
}

// ------------------------------------------------------------
// Accessors
// ------------------------------------------------------------
export function getCategoryById(id) {
  return categoriesById.get(id) || null;
}

export function getAllCategories() {
  return categories;
}

// ------------------------------------------------------------
// Main Evaluator
// ------------------------------------------------------------
export function evaluateCategory(c, category) {
  const { type, params = {} } = category;

  switch (type) {
    // Simple flags / demographics
    case "boolean_flag":
      return Boolean(c[params.field]);

    case "boolean_flag_equals":
      return evalBooleanFlagEquals(c, params);

    case "gender_equals":
      return c.gender === params.gender;

    case "age_bracket":
      return evalAgeBracket(c, params);

    // Placement
    case "placement_equals":
      return evalPlacementEquals(c, params);

    case "placement_range":
      return evalPlacementRange(c, params);

    // Season list presence / absence (made_merge, made_jury, made_ftc, etc.)
    case "season_list_nonempty":
      return Array.isArray(c[params.field]) && c[params.field].length > 0;

    case "season_list_empty":
      return Array.isArray(c[params.field]) && c[params.field].length === 0;

    case "season_list_count":
      return evalSeasonListCount(c, params);

    case "season_list_not_covering_all_seasons":
      return evalSeasonListNotCoveringAllSeasons(c, params);
    case "season_list_covering_all_seasons":
      return evalSeasonListCoveringAllSeasons(c, params);

    // Season played (per season ID, e.g. US36, AU07)
    case "season_played":
      return evalSeasonPlayed(c, params);

    case "season_group_played":
      return evalSeasonGroupPlayed(c, params);

    // Advantages
    case "advantage_held":
      return evalAdvantageHeld(c, params);

    case "advantage_used":
      return evalAdvantageUsed(c, params);

    case "advantage_success":
      return evalAdvantageSuccess(c, params);

    case "advantage_failed":
      return evalAdvantageFailed(c, params);

    case "advantage_found":
      return evalAdvantageFound(c, params);

    case "advantage_received":
      return evalAdvantageReceived(c, params);

    // Shot in the Dark
    case "sitd_used":
      return Array.isArray(c.shot_in_the_dark) && c.shot_in_the_dark.length > 0;

    case "sitd_success":
      return Array.isArray(c.shot_in_the_dark) &&
        c.shot_in_the_dark.some(s => s.successful);

    // Voting
    case "vote_correct_count":
      return evalVoteCorrectCount(c, params);

    case "vote_correct_all":
      return evalVoteCorrectAll(c);

    case "votes_against_count":
      return evalVotesAgainstCount(c, params);

    // Challenges
    case "immunity_wins_count":
      return evalImmunityWinsCount(c, params);

    case "immunity_flag":
      return evalImmunityFlag(c, params);

    case "sit_out_min_count":
      return evalSitOutMinCount(c, params);

    case "confessional_count":
      return evalConfessionalCount(c, params);

    // Firemaking
    case "firemaking_result":
      return evalFiremakingResult(c, params);

    // Tribe colors (color families)
    case "tribe_color":
      return evalTribeColor(c, params);

    case "castaway_id_in_set":
      return evalCastawayIdInSet(c, params);

    default:
      console.warn("Unknown category type:", type, category);
      return false;
  }
}

// ------------------------------------------------------------
// Evaluators (Aligned to contestants.json schema)
// ------------------------------------------------------------


function evalBooleanFlagEquals(c, { field, value }) {
  return Boolean(c[field]) === Boolean(value);
}

// Ages: [{ season, age }]
function evalAgeBracket(c, { min, max }) {
  const parsedMin = Number(min);
  const parsedMax = Number(max);
  if (!Number.isFinite(parsedMin) || !Number.isFinite(parsedMax)) return false;

  const ages = (Array.isArray(c.ages) ? c.ages : [])
    .map(entry => Number(entry?.age))
    .filter(age => Number.isFinite(age));

  if (ages.length === 0) return false;
  return ages.some(age => age >= parsedMin && age <= parsedMax);
}

// Placements: [{ season, place }]
function evalPlacementEquals(c, { place }) {
  return (c.placements || []).some(p => p.place === place);
}

function evalPlacementRange(c, { min, max }) {
  return (c.placements || []).some(p => {
    if (min != null && p.place < min) return false;
    if (max != null && p.place > max) return false;
    return true;
  });
}

// Seasons played: ["US36", "AU07", ...]
function evalSeasonPlayed(c, { season }) {
  const seasons = Array.isArray(c.seasons) ? c.seasons : [];
  return seasons.some(entry => entry === season || entry?.season === season);
}

function evalSeasonGroupPlayed(c, { seasons = [] }) {
  if (!Array.isArray(seasons) || seasons.length === 0) {
    return false;
  }

  const seasonSet = new Set(seasons);
  const contestantSeasons = Array.isArray(c.seasons) ? c.seasons : [];
  return contestantSeasons.some(entry => {
    if (typeof entry === "string") {
      return seasonSet.has(entry);
    }

    return seasonSet.has(entry?.season);
  });
}

function evalSeasonListNotCoveringAllSeasons(c, { field, exclude_seasons = [], exclude_if_in_fields = [] }) {
  const contestantSeasons = Array.isArray(c.seasons) ? c.seasons : [];
  if (contestantSeasons.length === 0) {
    return false;
  }

  const excludedSeasons = new Set(
    Array.isArray(exclude_seasons)
      ? exclude_seasons.filter(season => typeof season === "string" && season)
      : []
  );

  const excludedByOtherFields = Array.isArray(exclude_if_in_fields)
    ? exclude_if_in_fields
      .filter(fieldName => typeof fieldName === "string" && fieldName)
      .map(fieldName => new Set(Array.isArray(c[fieldName]) ? c[fieldName] : []))
    : [];

  const milestoneSeasons = new Set(
    Array.isArray(c[field])
      ? c[field]
      : []
  );

  return contestantSeasons.some(entry => {
    const season = typeof entry === "string" ? entry : entry?.season;
    return season && !excludedSeasons.has(season) && !milestoneSeasons.has(season) && !excludedByOtherFields.some(seasonSet => seasonSet.has(season));
  });
}

function evalSeasonListCoveringAllSeasons(c, { field }) {
  const contestantSeasons = Array.isArray(c.seasons) ? c.seasons : [];
  if (contestantSeasons.length === 0) {
    return false;
  }

  const milestoneSeasons = new Set(
    Array.isArray(c[field])
      ? c[field]
      : []
  );

  return contestantSeasons.every(entry => {
    const season = typeof entry === "string" ? entry : entry?.season;
    return season && milestoneSeasons.has(season);
  });
}

function evalSeasonListCount(c, { field, min, max }) {
  const values = Array.isArray(c[field]) ? c[field] : [];
  const count = values.length;

  if (min != null && count < min) return false;
  if (max != null && count > max) return false;
  return true;
}

// Advantages: [{ season, type, event, successful, played_on }]
const ADVANTAGE_TYPE_NORMALIZATION = {
  "vote steal": "steal a vote",
  "remove juror": "remove jury member",
  "juror removal": "remove jury member"
};

function normalizeAdvantageType(type) {
  const normalized = String(type || "").trim().toLowerCase();
  if (!normalized) {
    return "";
  }

  return ADVANTAGE_TYPE_NORMALIZATION[normalized] || normalized;
}

function matchesAdvantageType(actualType, requestedType) {
  if (requestedType === "any") {
    return true;
  }

  const normalizedActual = normalizeAdvantageType(actualType);
  const normalizedRequested = normalizeAdvantageType(requestedType);

  if (normalizedActual === normalizedRequested) {
    return true;
  }

  if (normalizedRequested === "hidden immunity idol" && normalizedActual === "super idol") {
    return true;
  }

  if (normalizedRequested === "hidden immunity idol" && normalizedActual === "boomerang idol") {
    return true;
  }

  return false;
}

function evalAdvantageHeld(c, { advantage_type }) {
  const adv = c.advantages || [];
  return adv.some(a => {
    if (!matchesAdvantageType(a.type, advantage_type)) return false;
    if (normalizeAdvantageType(a.type) === "boomerang idol" && a.event === "found") return false;
    return true;
  });
}

function evalAdvantageFound(c, { advantage_type }) {
  const adv = c.advantages || [];
  return adv.some(a => {
    if (a.event !== "found") return false;
    return matchesAdvantageType(a.type, advantage_type);
  });
}

function evalAdvantageReceived(c, { advantage_type }) {
  const adv = c.advantages || [];
  return adv.some(a => {
    if (a.event !== "received") return false;
    return matchesAdvantageType(a.type, advantage_type);
  });
}

function evalAdvantageUsed(c, { advantage_type }) {
  const adv = c.advantages || [];
  return adv.some(a => {
    if (a.event !== "played") return false;
    return matchesAdvantageType(a.type, advantage_type);
  });
}

function evalAdvantageSuccess(c, { advantage_type, success }) {
  const adv = c.advantages || [];
  return adv.some(a => {
    if (a.event !== "played") return false;
    if (a.successful !== success) return false;
    return matchesAdvantageType(a.type, advantage_type);
  });
}

function evalAdvantageFailed(c, { advantage_type }) {
  const adv = c.advantages || [];
  return adv.some(a => {
    if (a.event !== "played") return false;
    if (a.successful !== false) return false;
    return matchesAdvantageType(a.type, advantage_type);
  });
}

// Voting: [{ season, tribals_attended, correct_votes, incorrect_votes, votes_against }]
function evalVoteCorrectCount(c, params) {
  return evalCountByScope(c, c.voting || [], "correct_votes", params);
}

function evalVoteCorrectAll(c) {
  const voting = c.voting || [];
  if (voting.length === 0) return false;
  return voting.every(v => (v.correct_votes || 0) === (v.tribals_attended || 0));
}

function evalVotesAgainstCount(c, params) {
  return evalCountByScope(c, c.voting || [], "votes_against", params);
}

function getPlayedSeasonIds(c) {
  const placementSeasons = (c.placements || [])
    .filter(entry => Number.isFinite(entry?.place))
    .map(entry => entry.season)
    .filter(seasonId => typeof seasonId === "string" && seasonId.trim() !== "");

  if (placementSeasons.length > 0) {
    return Array.from(new Set(placementSeasons));
  }

  const fallbackSeasons = (c.seasons || []).map(entry => {
    if (typeof entry === "string") return entry;
    return entry?.season;
  });

  return Array.from(
    new Set(fallbackSeasons.filter(seasonId => typeof seasonId === "string" && seasonId.trim() !== ""))
  );
}

// Immunity wins: [{ season, count, first_immunity?, final_immunity? }]
function evalImmunityWinsCount(c, params) {
  return evalCountByScope(c, c.immunity_wins || [], "count", params);
}

function evalImmunityFlag(c, { flag }) {
  return (c.immunity_wins || []).some(w => w[flag]);
}

// Sit-outs: [{ season, count }]
function evalSitOutMinCount(c, params) {
  return evalCountByScope(c, c.sit_outs || [], "count", params);
}

// Confessional totals: [{ season, count, time }]
function evalConfessionalCount(c, params) {
  return evalCountByScope(c, c.confessional_totals || [], "count", params);
}

// Firemaking: [{ season, result }]
function evalFiremakingResult(c, { result }) {
  return (c.firemaking || []).some(f => f.result === result);
}

// Tribe colors: [{ season, colors: ["#hex", ...] }]
function evalTribeColor(c, { color }) {
  return (c.tribe_colors || []).some(tc =>
    (tc.colors || []).some(hex => normalizeColors(hex).includes(color))
  );
}

function evalCountByScope(c, entries, key, { min, max, scope = "career" } = {}) {
  const values = entries.map(entry => entry?.[key] ?? 0);

  if (scope === "season") {
    const seasonSet = new Set(getPlayedSeasonIds(c));

    entries.forEach(entry => {
      if (!entry || typeof entry !== "object") return;
      const seasonId = entry.season;
      if (typeof seasonId !== "string" || seasonId.trim() === "") return;
      seasonSet.add(seasonId);
    });

    const playedSeasons = Array.from(seasonSet);
    if (playedSeasons.length === 0) {
      return isWithinRange(0, min, max);
    }

    const valuesBySeason = new Map();
    entries.forEach(entry => {
      if (!entry || typeof entry !== "object") return;
      const seasonId = entry.season;
      if (typeof seasonId !== "string" || seasonId.trim() === "") return;
      valuesBySeason.set(seasonId, entry?.[key] ?? 0);
    });

    return playedSeasons.some(seasonId => isWithinRange(valuesBySeason.get(seasonId) ?? 0, min, max));
  }

  const total = values.reduce((sum, value) => sum + value, 0);
  return isWithinRange(total, min, max);
}

function isWithinRange(value, min, max) {
  if (min != null && value < min) return false;
  if (max != null && value > max) return false;
  return true;
}

// Color-family normalizer (aligned with generator)
const TRIBE_COLOR_HEX_OVERRIDES = {
  "#FFAA00": ["orange", "yellow"], // Chuay Jai (approved dual classification)
  "#FE5430": ["red"],
  "#DC3D0D": ["orange"],
  "#F8693D": ["orange"],
  "#FF4500": ["orange"],
  "#784937": ["brown"],
  "#EB4B00": ["yellow"],
  "#DFFF00": ["yellow"],
  "#3BB1DB": ["blue"], // Kele
  "#009ED6": ["blue"], // Belo
  "#36AFE7": ["blue"], // Luvu
  "#009480": ["green"], // Lesu
  "#007355": ["blue"], // Aiga
  "#87CEEB": ["blue"], // Drake
  "#99FFFF": ["blue"], // Rotu
  "#00A693": ["green"], // Moto Maji
  "#32CCFF": ["blue"], // Kucha
  "#0FFD9C": ["black", "green"], // Fa'amolemole
  "#47CAED": ["blue"], // Champions (AU04)
  "#81C9CA": ["blue"], // La Nena
  "#0099CC": ["blue"], // Chani
  "#9F3875": ["purple"], // Naviti
  "#DA1789": ["purple", "pink"], // Bayon
  "#F400A1": ["pink", "purple"], // Soliantu
  "#A51A84": ["pink", "purple"], // Samatau
  "#D973CE": ["purple", "pink"] // Vatu (US50)
};

function normalizeColors(hex) {
  const normalizedHex = String(hex || "").trim().toUpperCase();
  const rgb = hexToRgb(hex);
  if (!rgb) return [];

  const { r, g, b } = rgb;
  const { h, s, l } = rgbToHsl(r, g, b);
  const families = new Set();

  if (l <= 0.1) {
    families.add("black");
    return Array.from(families);
  }

  if (s < 0.1 && l > 0.9) {
    return [];
  }

  const overrides = TRIBE_COLOR_HEX_OVERRIDES[normalizedHex];
  if (Array.isArray(overrides)) {
    return Array.from(new Set(overrides));
  }

  if (h >= 330 || h < 15) families.add("red");
  // Keep amber-gold tribe colors (like Galang) in yellow instead of orange.
  if (h >= 15 && h < 40) families.add("orange");
  if (h >= 40 && h < 70) families.add("yellow");

  if (h >= 70 && h < 165) families.add("green");
  if (h >= 165 && h < 250) families.add("blue");
  // Keep violet + magenta-leaning violets in purple so tribes like
  // Yanu/Kula Kula/Vokai/Solana are consistently categorized as purple.
  if (h >= 250 && h < 315) families.add("purple");
  if (h >= 315 && h < 330) families.add("pink");

  if (h >= 155 && h < 200) {
    families.add("green");
    families.add("blue");
  }

  return Array.from(families);
}

function hexToRgb(hex) {
  if (!hex) return null;
  const normalized = hex.trim().replace("#", "");
  if (!/^[0-9a-fA-F]{6}$/.test(normalized)) return null;
  const int = Number.parseInt(normalized, 16);
  return {
    r: (int >> 16) & 255,
    g: (int >> 8) & 255,
    b: int & 255
  };
}

function rgbToHsl(r, g, b) {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const delta = max - min;

  let h = 0;
  if (delta !== 0) {
    if (max === rn) h = ((gn - bn) / delta) % 6;
    else if (max === gn) h = (bn - rn) / delta + 2;
    else h = (rn - gn) / delta + 4;
    h *= 60;
    if (h < 0) h += 360;
  }

  const l = (max + min) / 2;
  const s = delta === 0 ? 0 : delta / (1 - Math.abs(2 * l - 1));
  return { h, s, l };
}


function evalCastawayIdInSet(c, { castaway_ids = [] } = {}) {
  if (!Array.isArray(castaway_ids) || castaway_ids.length === 0) {
    return false;
  }

  return castaway_ids.includes(c.castaway_id);
}
