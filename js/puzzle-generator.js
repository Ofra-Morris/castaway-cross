// ------------------------------------------------------------
// Puzzle Generator (Validated with per-cell minimums)
// ------------------------------------------------------------

import { evaluateCategory } from "./category-engine.js";
import { getDailyPuzzleDateParts, getDailyPuzzleSeed } from "./daily-puzzle-clock.js";

// ------------------------------------------------------------
// Public API
// ------------------------------------------------------------

export function generateRandomPuzzle(categories, contestants, options = {}) {
  const seed = Math.floor(Math.random() * 4294967296);
  return generateSeededPuzzle(categories, contestants, seed, options);
}

export function generateSeededPuzzle(
  categories,
  contestants,
  seed,
  options = {}
) {
  const {
    minPerCell = 3,
    usOnly = false,
    enforceUniqueTypes = false,
    allowedPointRanges = null
  } = options;

  const normalizedSeed = normalizeSeed(seed);
  const rng = mulberry32(normalizedSeed);

  return generateValidPuzzle({
    categories,
    contestants,
    rng,
    minPerCell,
    usOnly,
    enforceUniqueTypes,
    allowedPointRanges
  });
}

export function generateDailyPuzzle(categories, contestants, date = new Date()) {
  const seed = getDailyPuzzleSeed(date);
  const rng = mulberry32(seed);
  const dailyDateParts = getDailyPuzzleDateParts(date);
  const allowedPointRanges = getDailyDifficultyPointRanges(dailyDateParts);
  const dailyWeekday = getWeekdayFromDailyDateParts(dailyDateParts);
  const dailyCategories = categories.filter(category => isCategoryAllowedForDailyWeekday(category, dailyWeekday));

  return generateValidPuzzle({
    categories: dailyCategories,
    contestants,
    rng,
    minPerCell: 3,
    allowMinPerCellRelaxation: false,
    usOnly: true,
    enforceUniqueTypes: false,
    allowedPointRanges
  });
}

export function getDailyDifficultyTargetForDate(date = new Date()) {
  const dailyDateParts = getDailyPuzzleDateParts(date);
  return getDailyDifficultyPointRanges(dailyDateParts);
}

export function getPuzzleDifficultyPoints(rows = [], cols = []) {
  return getCandidatePointTotal(rows, cols);
}

function isUSContestant(contestant) {
  return contestant.seasons?.some(seasonId => seasonId.startsWith("US"));
}

// ------------------------------------------------------------
// Core: Generate until valid
// ------------------------------------------------------------

const DAILY_EXCLUDED_CATEGORY_TYPES = new Set([
  "sit_out_min_count",
  "gender_equals"
]);

const DAILY_EXCLUDED_CATEGORY_IDS = new Set([
  "format_new_era"
]);

const DAILY_WEDNESDAY_ONLY_CATEGORY_IDS = new Set([
  "votes_against_career_1plus",
  "votes_against_career_2plus",
  "votes_against_season_2plus",
  "placement_preftc"
]);

function getWeekdayFromDailyDateParts(dailyDateParts) {
  if (!dailyDateParts || !Number.isFinite(dailyDateParts.year)
    || !Number.isFinite(dailyDateParts.month)
    || !Number.isFinite(dailyDateParts.day)) {
    return null;
  }
  return new Date(Date.UTC(dailyDateParts.year, dailyDateParts.month - 1, dailyDateParts.day)).getUTCDay();
}

function isCategoryAllowedForDailyWeekday(category, weekday) {
  if (DAILY_EXCLUDED_CATEGORY_TYPES.has(category.type)) return false;
  if (DAILY_EXCLUDED_CATEGORY_IDS.has(category.id)) return false;

  if (!DAILY_WEDNESDAY_ONLY_CATEGORY_IDS.has(category.id)) return true;
  return weekday === 3;
}

const RANDOM_SETTINGS_CATEGORY_TYPE_OVERRIDES = {
  status_returning: "returning_states",
  status_played_three_plus_seasons: "returning_states",
  placement_merge: "placement_equals",
  placement_jury: "placement_equals",
  placement_ftc: "placement_equals",
  exit_quit: "placement_equals",
  exit_medevac: "placement_equals",
  confessional_highest_season: "confessional_count",
  confessional_lowest_season: "confessional_count",
  journey_went: "journey_outcome",
  journey_lost_vote: "journey_outcome",
  journey_gained_advantage: "journey_outcome",
  juror_voted_winner: "juror_actions",
  juror_not_voted_winner: "juror_actions",
  votes_against_count: "player_voting",
  auction_item_won: "auction_actions",
  age_oldest_player: "age",
  age_youngest_player: "age",
  voting_no_tribals_before_merge: "player_voting",
  voting_no_tribals_before_merge_career: "player_voting"
};

const CATEGORY_FAMILY_POINTS = {
  returning_states: 1,
  placement_equals: 1,
  immunity_wins_count: 1,
  firemaking_result: 1,
  season_played: 1,
  season_group_played: 1,
  gender_equals: 1,
  advantage_held: 1,
  advantage_success: 1,
  advantage_failed: 1,
  advantage_used: 1,
  advantage_found: 1,
  advantage_received: 1,
  castaway_id_in_set: 2,
  player_voting: 2,
  juror_actions: 2,
  journey_outcome: 2,
  sit_out_min_count: 3,
  confessional_count: 3,
  tribe_color: 3,
  auction_actions: 3,
  age: 3
};

const CATEGORY_FAMILY_ORDER = [
  "returning_states",
  "placement_equals",
  "immunity_wins_count",
  "firemaking_result",
  "season_played",
  "season_group_played",
  "gender_equals",
  "advantage_held",
  "advantage_success",
  "advantage_failed",
  "advantage_used",
  "advantage_found",
  "advantage_received",
  "castaway_id_in_set",
  "player_voting",
  "juror_actions",
  "journey_outcome",
  "sit_out_min_count",
  "confessional_count",
  "tribe_color",
  "auction_actions",
  "age"
];

const CATEGORY_HIERARCHY_INDEX = new Map(
  CATEGORY_FAMILY_ORDER.map((key, index) => [key, index])
);

const MAX_ATTEMPTS_PER_MINIMUM = 10000;
const MIN_MIN_PER_CELL = 1;
const MAX_DETERMINISTIC_TYPE_COMBOS = 200;
const MAX_DETERMINISTIC_ASSIGNMENTS = 4000;

function buildMinimumSequence(startingMinimum) {
  const sequence = [];
  for (let current = startingMinimum; current >= MIN_MIN_PER_CELL; current -= 1) {
    sequence.push(current);
  }
  return sequence;
}

function generateValidPuzzle({
  categories,
  contestants,
  rng,
  minPerCell,
  allowMinPerCellRelaxation = true,
  usOnly,
  enforceUniqueTypes,
  allowedPointRanges
}) {
  const usable = categories;
  const allMatchIndex = buildCategoryMatches(usable, contestants);
  const usContestants = contestants.filter(isUSContestant);

  if (usContestants.length === 0) {
    throw new Error(
      "Unable to generate puzzle: no contestants matched filter field seasons[] with season IDs starting with 'US'."
    );
  }

  const usMatchIndex = buildCategoryMatches(usable, usContestants);
  const fullOverlapIndex = usOnly ? usMatchIndex : allMatchIndex;
  const minSequence = allowMinPerCellRelaxation
    ? buildMinimumSequence(minPerCell)
    : [minPerCell];

  let totalAttempts = 0;
  const failureCounts = {
    insufficientCoverage: 0,
    insufficientTypes: 0,
    duplicateCategories: 0,
    duplicateTypes: 0,
    minimumMiss: 0,
    fullOverlap: 0,
    duplicateCells: 0,
    noUniqueAssignment: 0,
    difficultyMiss: 0,
    careerScopeMiss: 0
  };
  const tierDiagnostics = [];

  for (const currentMinimum of minSequence) {
    const validationIndex = usMatchIndex;
    const tierContext = buildTierContext(usable, validationIndex, currentMinimum);
    tierDiagnostics.push({
      minPerCell: currentMinimum,
      candidatePoolSize: tierContext.filteredCategories.length,
      typeBucketCount: tierContext.types.length,
      typeBucketSizes: tierContext.types.map(type => ({
        type,
        size: tierContext.typeBuckets.get(type).length
      }))
    });

    if (tierContext.filteredCategories.length < 6) {
      failureCounts.insufficientCoverage += 1;
      continue;
    }
    if (enforceUniqueTypes && tierContext.types.length < 6) {
      failureCounts.insufficientTypes += 1;
      continue;
    }

    for (let i = 0; i < MAX_ATTEMPTS_PER_MINIMUM; i += 1) {
      totalAttempts += 1;
      const attemptNumber = i + 1;

      const candidate = buildRandomCandidate(tierContext, rng, enforceUniqueTypes);
      const attempt = validateCandidate(
        candidate.rows,
        candidate.cols,
        validationIndex,
        fullOverlapIndex,
        allMatchIndex,
        currentMinimum,
        enforceUniqueTypes,
        allowedPointRanges
      );
      if (!attempt.ok) {
        failureCounts[attempt.reason] += 1;
        continue;
      }

      if (currentMinimum !== minPerCell) {
        console.warn(
          `[puzzle-generator] Constraints relaxed from minPerCell=${minPerCell} to minPerCell=${currentMinimum} after ${totalAttempts} attempts.`
        );
      }
      console.info(
        `[puzzle-generator] Puzzle generated in ${totalAttempts} attempts (last tier attempt ${attemptNumber}, minPerCell=${currentMinimum}, usOnly=${usOnly}).`
      );

      const grid = buildGrid(candidate.rows, candidate.cols, allMatchIndex);
      return { rows: candidate.rows, cols: candidate.cols, grid };
    }

    console.warn(
      `[puzzle-generator] Exhausted ${MAX_ATTEMPTS_PER_MINIMUM} attempts at minPerCell=${currentMinimum}.`
    );

    const deterministicResult = runDeterministicTierSearch({
      tierContext,
      validationIndex,
      fullOverlapIndex,
      answerMatchIndex: allMatchIndex,
      currentMinimum,
      failureCounts,
      enforceUniqueTypes,
      allowedPointRanges
    });
    totalAttempts += deterministicResult.attempts;
    if (deterministicResult.solution) {
      if (currentMinimum !== minPerCell) {
        console.warn(
          `[puzzle-generator] Constraints relaxed from minPerCell=${minPerCell} to minPerCell=${currentMinimum} after ${totalAttempts} attempts.`
        );
      }
      console.info(
        `[puzzle-generator] Puzzle generated after deterministic tier search (attempts=${totalAttempts}, minPerCell=${currentMinimum}, usOnly=${usOnly}).`
      );
      const grid = buildGrid(
        deterministicResult.solution.rows,
        deterministicResult.solution.cols,
        allMatchIndex
      );
      return {
        rows: deterministicResult.solution.rows,
        cols: deterministicResult.solution.cols,
        grid
      };
    }
    if (deterministicResult.exhaustionReason) {
      console.warn(
        `[puzzle-generator] Deterministic tier search exhausted at minPerCell=${currentMinimum}: ${deterministicResult.exhaustionReason}.`
      );
    }
  }

  const mostFailedRule = Object.entries(failureCounts).reduce(
    (best, current) => (current[1] > best[1] ? current : best),
    ["none", 0]
  );
  const failureDiagnostics = {
    minPerCell,
    usOnly,
    enforceUniqueTypes,
    totalAttempts,
    mostFailedRule: {
      rule: mostFailedRule[0],
      count: mostFailedRule[1]
    },
    failureCounts,
    tiers: tierDiagnostics
  };
  const failureSummary = JSON.stringify(failureDiagnostics);
  const error = new Error(
    `Unable to generate puzzle after ${totalAttempts} attempts. Diagnostics: ${failureSummary}`
  );
  console.error("[puzzle-generator] Puzzle generation failed.", failureDiagnostics);
  throw error;
}

function buildTierContext(categories, matchIndex, minimum) {
  const filteredCategories = categories.filter(category => {
    if (category?.enabled === false) {
      return false;
    }

    const match = matchIndex.get(category.id);
    return match && match.list.length >= minimum;
  });
  const typeBuckets = bucketCategoriesByType(filteredCategories);
  const types = Array.from(typeBuckets.keys()).sort();
  return { filteredCategories, typeBuckets, types };
}

function bucketCategoriesByType(categories) {
  const buckets = new Map();
  for (const category of categories) {
    if (!buckets.has(category.type)) {
      buckets.set(category.type, []);
    }
    buckets.get(category.type).push(category);
  }
  return buckets;
}

function buildRandomTypeBucketCandidate(typeBuckets, types, rng) {
  const selectedTypes = pickSeeded(types, 6, rng);
  const selectedCategories = selectedTypes.map(type => {
    const bucket = typeBuckets.get(type);
    return bucket[Math.floor(rng() * bucket.length)];
  });
  const shuffled = pickSeeded(selectedCategories, selectedCategories.length, rng);
  return {
    rows: sortCategoriesByHierarchy(shuffled.slice(0, 3)),
    cols: sortCategoriesByHierarchy(shuffled.slice(3))
  };
}

function buildRandomCandidate(tierContext, rng, enforceUniqueTypes) {
  if (enforceUniqueTypes) {
    return buildRandomTypeBucketCandidate(tierContext.typeBuckets, tierContext.types, rng);
  }

  const selectedCategories = pickSeeded(tierContext.filteredCategories, 6, rng);
  return {
    rows: sortCategoriesByHierarchy(selectedCategories.slice(0, 3)),
    cols: sortCategoriesByHierarchy(selectedCategories.slice(3))
  };
}

function getCategoryHierarchyKey(category) {
  if (RANDOM_SETTINGS_CATEGORY_TYPE_OVERRIDES[category?.id]) {
    return RANDOM_SETTINGS_CATEGORY_TYPE_OVERRIDES[category.id];
  }

  if (category?.type === "boolean_flag") return "returning_states";
  if (category?.type === "season_list_empty") return "placement_equals";
  if (category?.type === "season_list_not_covering_all_seasons") return "placement_equals";
  if (category?.type === "season_list_nonempty") return "placement_equals";
  if (category?.type === "votes_against_count") return "player_voting";
  if (category?.type === "age_bracket") return "age";

  return category?.type || null;
}

function getCategoryPointValue(category) {
  const family = getCategoryHierarchyKey(category);
  return CATEGORY_FAMILY_POINTS[family] || 1;
}

function getCandidatePointTotal(rows, cols) {
  return [...rows, ...cols]
    .reduce((sum, category) => sum + getCategoryPointValue(category), 0);
}

function candidateMatchesAnyPointRange(rows, cols, allowedPointRanges) {
  if (!Array.isArray(allowedPointRanges) || allowedPointRanges.length === 0) {
    return true;
  }

  const totalPoints = getCandidatePointTotal(rows, cols);
  return allowedPointRanges.some(range => {
    if (!range || typeof range !== "object") return false;
    const min = Number.isFinite(range.min) ? range.min : Number.NEGATIVE_INFINITY;
    const max = Number.isFinite(range.max) ? range.max : Number.POSITIVE_INFINITY;
    return totalPoints >= min && totalPoints <= max;
  });
}

function getScopedCategoryThreshold(category) {
  const scope = category?.params?.scope;
  if (scope !== "career" && scope !== "season") {
    return null;
  }

  const min = Number(category?.params?.min);
  const max = Number(category?.params?.max);
  if (Number.isFinite(min)) {
    return { type: category.type, scope, threshold: min };
  }
  if (Number.isFinite(max)) {
    return { type: category.type, scope, threshold: max };
  }

  return null;
}

function sideHasSeasonLocationPlaceConflict(categories) {
  const playedSeasons = new Set();
  const locationSeasonSets = [];

  for (const category of categories) {
    if (category?.type === "season_played" && typeof category?.params?.season === "string") {
      playedSeasons.add(category.params.season);
    }

    if (category?.type === "season_group_played"
      && typeof category?.label === "string"
      && category.label.startsWith("Location:")) {
      const seasonList = Array.isArray(category?.params?.seasons)
        ? category.params.seasons.filter(seasonId => typeof seasonId === "string")
        : [];
      locationSeasonSets.push(new Set(seasonList));
    }
  }

  if (playedSeasons.size === 0 || locationSeasonSets.length === 0) {
    return false;
  }

  for (const seasonId of playedSeasons) {
    for (const seasonSet of locationSeasonSets) {
      if (seasonSet.has(seasonId)) {
        return true;
      }
    }
  }

  return false;
}


function scopedThresholdsRespectCrossScopeOrdering(scopedThresholdsByType) {
  for (const [type, scopedThresholds] of scopedThresholdsByType.entries()) {
    if (scopedThresholds.length < 2) continue;

    for (let i = 0; i < scopedThresholds.length; i += 1) {
      for (let j = i + 1; j < scopedThresholds.length; j += 1) {
        const first = scopedThresholds[i];
        const second = scopedThresholds[j];

        if (first.scope === second.scope) {
          continue;
        }

        const careerThreshold = first.scope === "career" ? first.threshold : second.threshold;
        const seasonThreshold = first.scope === "season" ? first.threshold : second.threshold;

        if (careerThreshold <= seasonThreshold) {
          return false;
        }

        if (type === "votes_against_count" && careerThreshold < 5) {
          return false;
        }
      }
    }
  }

  return true;
}

function axisScopedThresholdsRespectCooccurrenceRules(categories) {
  const scopedThresholdsByType = new Map();

  for (const category of categories) {
    const scoped = getScopedCategoryThreshold(category);
    if (!scoped) continue;

    if (!scopedThresholdsByType.has(scoped.type)) {
      scopedThresholdsByType.set(scoped.type, []);
    }
    scopedThresholdsByType.get(scoped.type).push(scoped);
  }

  for (const scopedThresholds of scopedThresholdsByType.values()) {
    if (scopedThresholds.length < 2) continue;

    for (let i = 0; i < scopedThresholds.length; i += 1) {
      for (let j = i + 1; j < scopedThresholds.length; j += 1) {
        const first = scopedThresholds[i];
        const second = scopedThresholds[j];

        const isSameScope = first.scope === second.scope;
        if (isSameScope && Math.abs(first.threshold - second.threshold) === 1) {
          return false;
        }
      }
    }
  }

  return scopedThresholdsRespectCrossScopeOrdering(scopedThresholdsByType);
}

// Career-scoped list categories are a subset of their season-scoped sibling by
// construction (never in any season vs. not in some season), so the pair reads
// as one clue and collapses outright on rows dominated by single-season players.
const SEASON_SCOPED_LIST_TYPE = "season_list_nonempty";
const CAREER_SCOPED_LIST_TYPE = "season_list_covering_all_seasons";

function hasCareerAndSeasonScopedListSiblings(categories) {
  const seasonScopedFields = new Set();
  const careerScopedFields = new Set();

  for (const category of categories) {
    const field = category?.params?.field;
    if (typeof field !== "string") continue;

    if (category.type === SEASON_SCOPED_LIST_TYPE) {
      seasonScopedFields.add(field);
    } else if (category.type === CAREER_SCOPED_LIST_TYPE) {
      careerScopedFields.add(field);
    }
  }

  for (const field of careerScopedFields) {
    if (seasonScopedFields.has(field)) {
      return true;
    }
  }

  return false;
}

export function categoriesRespectDailyCooccurrenceRules(rows, cols) {
  if (sideHasSeasonLocationPlaceConflict(rows)) {
    return false;
  }
  if (sideHasSeasonLocationPlaceConflict(cols)) {
    return false;
  }
  if (!axisScopedThresholdsRespectCooccurrenceRules(rows)) {
    return false;
  }
  if (!axisScopedThresholdsRespectCooccurrenceRules(cols)) {
    return false;
  }
  const allGridCategories = [...rows, ...cols];
  if (!axisScopedThresholdsRespectCooccurrenceRules(allGridCategories)) {
    return false;
  }
  if (hasCareerAndSeasonScopedListSiblings(allGridCategories)) {
    return false;
  }
  return true;
}

function getDailyDifficultyPointRanges(dailyDateParts) {
  const weekday = new Date(Date.UTC(dailyDateParts.year, dailyDateParts.month - 1, dailyDateParts.day)).getUTCDay();
  const rangesByWeekday = {
    0: [{ min: 7, max: 10 }], // Sunday
    1: [{ min: 7, max: 11 }], // Monday
    2: [{ min: 12 }], // Tuesday
    3: [{ min: 6, max: 6 }], // Wednesday
    4: [{ min: 6, max: 8 }], // Thursday
    5: [{ min: 6, max: 9 }], // Friday
    6: [{ min: 7, max: 10 }] // Saturday
  };

  return rangesByWeekday[weekday] || [{ min: 6, max: 8 }];
}

function extractUsSeasonNumber(category) {
  const seasonValue = category?.params?.season;
  if (typeof seasonValue !== "string") return null;
  const match = seasonValue.match(/^US(\d+)$/);
  if (!match) return null;
  return Number(match[1]);
}

function compareCategoriesByHierarchy(a, b) {
  const aKey = getCategoryHierarchyKey(a);
  const bKey = getCategoryHierarchyKey(b);
  const aRank = aKey && CATEGORY_HIERARCHY_INDEX.has(aKey)
    ? CATEGORY_HIERARCHY_INDEX.get(aKey)
    : Number.POSITIVE_INFINITY;
  const bRank = bKey && CATEGORY_HIERARCHY_INDEX.has(bKey)
    ? CATEGORY_HIERARCHY_INDEX.get(bKey)
    : Number.POSITIVE_INFINITY;

  if (aRank !== bRank) {
    return aRank - bRank;
  }

  const aSeasonNumber = extractUsSeasonNumber(a);
  const bSeasonNumber = extractUsSeasonNumber(b);
  if (Number.isFinite(aSeasonNumber) && Number.isFinite(bSeasonNumber) && aSeasonNumber !== bSeasonNumber) {
    return aSeasonNumber - bSeasonNumber;
  }

  return String(a?.label || "").localeCompare(String(b?.label || ""));
}

function sortCategoriesByHierarchy(categories) {
  return [...categories].sort(compareCategoriesByHierarchy);
}

function validateCandidate(
  rows,
  cols,
  validationIndex,
  fullOverlapIndex,
  answerMatchIndex,
  currentMinimum,
  enforceUniqueTypes,
  allowedPointRanges
) {
  if (!areCategoriesUnique(rows, cols)) {
    return { ok: false, reason: "duplicateCategories" };
  }
  if (enforceUniqueTypes && !areCategoryTypesUnique(rows, cols)) {
    return { ok: false, reason: "duplicateTypes" };
  }
  if (!gridCellsMeetMinimum(rows, cols, validationIndex, currentMinimum)) {
    return { ok: false, reason: "minimumMiss" };
  }
  if (!gridCellsAvoidFullOverlap(rows, cols, fullOverlapIndex)) {
    return { ok: false, reason: "fullOverlap" };
  }
  const cellContestants = buildCellContestantIds(rows, cols, answerMatchIndex);
  if (!cellsHaveDistinctAnswerSets(cellContestants)) {
    return { ok: false, reason: "duplicateCells" };
  }
  if (!hasCompleteDistinctAssignment(cellContestants)) {
    return { ok: false, reason: "noUniqueAssignment" };
  }
  if (!candidateMatchesAnyPointRange(rows, cols, allowedPointRanges)) {
    return { ok: false, reason: "difficultyMiss" };
  }
  if (!categoriesRespectDailyCooccurrenceRules(rows, cols)) {
    return { ok: false, reason: "careerScopeMiss" };
  }
  return { ok: true };
}

function runDeterministicTierSearch({
  tierContext,
  validationIndex,
  fullOverlapIndex,
  answerMatchIndex,
  currentMinimum,
  failureCounts,
  enforceUniqueTypes,
  allowedPointRanges
}) {
  const rowLayouts = buildCombinationIndices(6, 3);
  let attempts = 0;
  let exploredTypeCombos = 0;
  let exploredAssignments = 0;
  let exhaustionReason = null;

  if (!enforceUniqueTypes) {
    return { attempts, solution: null, exhaustionReason };
  }

  const { typeBuckets, types } = tierContext;

  forEachCombination(types, 6, selectedTypes => {
    if (exploredTypeCombos >= MAX_DETERMINISTIC_TYPE_COMBOS) {
      exhaustionReason = `reached type-combo cap (${MAX_DETERMINISTIC_TYPE_COMBOS})`;
      return false;
    }
    exploredTypeCombos += 1;

    const buckets = selectedTypes.map(type => typeBuckets.get(type));
    const cursor = new Array(6).fill(0);

    while (true) {
      if (exploredAssignments >= MAX_DETERMINISTIC_ASSIGNMENTS) {
        exhaustionReason = `reached assignment cap (${MAX_DETERMINISTIC_ASSIGNMENTS})`;
        return false;
      }
      exploredAssignments += 1;
      attempts += 1;

      const selectedCategories = buckets.map((bucket, index) => bucket[cursor[index]]);
      for (const rowLayout of rowLayouts) {
        const rowSet = new Set(rowLayout);
        const rows = sortCategoriesByHierarchy(
          selectedCategories.filter((_, index) => rowSet.has(index))
        );
        const cols = sortCategoriesByHierarchy(
          selectedCategories.filter((_, index) => !rowSet.has(index))
        );

        const attempt = validateCandidate(
          rows,
          cols,
          validationIndex,
          fullOverlapIndex,
          answerMatchIndex,
          currentMinimum,
          enforceUniqueTypes,
          allowedPointRanges
        );
        if (attempt.ok) {
          return { stop: true, solution: { rows, cols } };
        }
        failureCounts[attempt.reason] += 1;
      }

      let advanced = false;
      for (let i = cursor.length - 1; i >= 0; i -= 1) {
        cursor[i] += 1;
        if (cursor[i] < buckets[i].length) {
          advanced = true;
          break;
        }
        cursor[i] = 0;
      }
      if (!advanced) {
        break;
      }
    }

    return true;
  });

  if (!exhaustionReason) {
    exhaustionReason =
      exploredTypeCombos === 0
        ? "no valid type combinations available"
        : `searched all ${exploredTypeCombos} type combinations`;
  }

  return { attempts, solution: null, exhaustionReason };
}

function buildCombinationIndices(n, k) {
  const results = [];
  forEachCombination(Array.from({ length: n }, (_, i) => i), k, combo => {
    results.push(combo);
    return true;
  });
  return results;
}

function forEachCombination(items, size, visitor) {
  const combo = [];

  function walk(start) {
    if (combo.length === size) {
      const result = visitor([...combo]);
      if (result && result.stop) {
        return result;
      }
      if (result === false) {
        return { stop: true };
      }
      return null;
    }

    for (let i = start; i < items.length; i += 1) {
      combo.push(items[i]);
      const result = walk(i + 1);
      combo.pop();
      if (result && result.stop) {
        return result;
      }
    }

    return null;
  }

  const outcome = walk(0);
  return outcome || { stop: false };
}

// ------------------------------------------------------------
// Validation rules
// ------------------------------------------------------------

function areCategoriesUnique(rows, cols) {
  const ids = [...rows.map(r => r.id), ...cols.map(c => c.id)];
  return new Set(ids).size === ids.length;
}

function areCategoryTypesUnique(rows, cols) {
  const types = [...rows.map(r => r.type), ...cols.map(c => c.type)];
  return new Set(types).size === types.length;
}

const TRIBE_COLOR_INTERSECTION_BLOCKLIST = new Set([
  "orange::yellow",
  "blue::green",
  "pink::purple"
]);

function getTribeColorFamily(category) {
  if (!category || category.type !== "tribe_color") return null;
  const color = category?.params?.color;
  if (typeof color !== "string") return null;
  const normalized = color.trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

function areTribeColorIntersectionsAllowed(rowCategory, colCategory) {
  const rowFamily = getTribeColorFamily(rowCategory);
  const colFamily = getTribeColorFamily(colCategory);
  if (!rowFamily || !colFamily) return true;
  if (rowFamily === colFamily) return false;
  const pairKey = [rowFamily, colFamily].sort().join("::");
  return !TRIBE_COLOR_INTERSECTION_BLOCKLIST.has(pairKey);
}

function gridCellsMeetMinimum(rows, cols, matchIndex, minPerCell) {
  for (const r of rows) {
    const rowMatch = matchIndex.get(r.id);
    for (const c of cols) {
      if (!areTribeColorIntersectionsAllowed(r, c)) return false;
      const colMatch = matchIndex.get(c.id);
      const intersectionSize = countIntersection(rowMatch, colMatch);
      if (intersectionSize < minPerCell) return false;
    }
  }
  return true;
}

function gridCellsAvoidFullOverlap(rows, cols, matchIndex) {
  for (const r of rows) {
    const rowMatch = matchIndex.get(r.id);
    for (const c of cols) {
      const colMatch = matchIndex.get(c.id);
      const intersectionSize = countIntersection(rowMatch, colMatch);
      if (
        intersectionSize === rowMatch.list.length ||
        intersectionSize === colMatch.list.length
      ) {
        return false;
      }
    }
  }
  return true;
}

// ------------------------------------------------------------
// Build grid
// ------------------------------------------------------------

function buildGrid(rows, cols, matchIndex) {
  const grid = [];

  for (const r of rows) {
    const row = [];
    for (const c of cols) {
      const rowMatch = matchIndex.get(r.id);
      const colMatch = matchIndex.get(c.id);
      const valid = intersectContestants(rowMatch, colMatch);
      row.push(valid);
    }
    grid.push(row);
  }

  return grid;
}

function buildCellContestantIds(rows, cols, matchIndex) {
  const cellContestants = [];

  for (const r of rows) {
    const rowMatch = matchIndex.get(r.id);
    for (const c of cols) {
      const colMatch = matchIndex.get(c.id);
      const valid = intersectContestants(rowMatch, colMatch);
      cellContestants.push(valid.map(contestant => contestant.castaway_id));
    }
  }

  return cellContestants;
}

function buildCellAnswerSignature(contestantIds) {
  return [...contestantIds].sort().join("|");
}

function cellsHaveDistinctAnswerSets(cellContestants) {
  const signatures = new Set();

  for (const contestantIds of cellContestants) {
    const signature = buildCellAnswerSignature(contestantIds);
    if (signatures.has(signature)) {
      return false;
    }
    signatures.add(signature);
  }

  return true;
}

// Reports every pair of cells sharing an identical answer set, so already
// scheduled and hand-curated grids can be audited outside the generator.
export function findDuplicateGridCells(rows, cols, contestants) {
  const matchIndex = buildCategoryMatches([...rows, ...cols], contestants);
  const cellsBySignature = new Map();
  const duplicates = [];

  for (const r of rows) {
    for (const c of cols) {
      const valid = intersectContestants(matchIndex.get(r.id), matchIndex.get(c.id));
      const contestantIds = valid.map(contestant => contestant.castaway_id);
      const signature = buildCellAnswerSignature(contestantIds);
      const cell = { rowId: r.id, colId: c.id, contestantIds };

      if (cellsBySignature.has(signature)) {
        duplicates.push({ first: cellsBySignature.get(signature), second: cell });
      } else {
        cellsBySignature.set(signature, cell);
      }
    }
  }

  return duplicates;
}

function hasCompleteDistinctAssignment(cellContestants) {
  const uniqueContestants = new Set(cellContestants.flat());

  if (uniqueContestants.size < cellContestants.length) {
    return false;
  }

  const contestantToCells = new Map();
  cellContestants.forEach((contestantIds, cellIndex) => {
    for (const contestantId of contestantIds) {
      if (!contestantToCells.has(contestantId)) {
        contestantToCells.set(contestantId, []);
      }
      contestantToCells.get(contestantId).push(cellIndex);
    }
  });

  const cellsPerContestant = Array.from(contestantToCells.values());
  const matchedCellByContestant = new Array(cellsPerContestant.length).fill(-1);

  for (let cellIndex = 0; cellIndex < cellContestants.length; cellIndex += 1) {
    const seenContestants = new Set();
    if (!assignCell(cellIndex, seenContestants, cellsPerContestant, matchedCellByContestant)) {
      return false;
    }
  }

  return true;
}

function assignCell(
  cellIndex,
  seenContestants,
  cellsPerContestant,
  matchedCellByContestant
) {
  for (let contestantIndex = 0; contestantIndex < cellsPerContestant.length; contestantIndex += 1) {
    if (seenContestants.has(contestantIndex)) {
      continue;
    }

    const contestantCells = cellsPerContestant[contestantIndex];
    if (!contestantCells.includes(cellIndex)) {
      continue;
    }

    seenContestants.add(contestantIndex);
    if (
      matchedCellByContestant[contestantIndex] === -1 ||
      assignCell(
        matchedCellByContestant[contestantIndex],
        seenContestants,
        cellsPerContestant,
        matchedCellByContestant
      )
    ) {
      matchedCellByContestant[contestantIndex] = cellIndex;
      return true;
    }
  }

  return false;
}

// ------------------------------------------------------------
// Random selection helpers
// ------------------------------------------------------------

function pickSeeded(arr, n, rng) {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, n);
}

function buildCategoryMatches(categories, contestants) {
  const index = new Map();
  for (const category of categories) {
    const list = [];
    const set = new Set();
    for (const contestant of contestants) {
      if (evaluateCategory(contestant, category)) {
        list.push(contestant);
        set.add(contestant.castaway_id);
      }
    }
    index.set(category.id, { list, set });
  }
  return index;
}

function countIntersection(a, b) {
  const [smaller, largerSet] =
    a.list.length <= b.list.length
      ? [a.list, b.set]
      : [b.list, a.set];
  let count = 0;
  for (const contestant of smaller) {
    if (largerSet.has(contestant.castaway_id)) {
      count += 1;
    }
  }
  return count;
}

function intersectContestants(a, b) {
  const [smaller, largerSet] =
    a.list.length <= b.list.length
      ? [a.list, b.set]
      : [b.list, a.set];
  return smaller.filter(contestant => largerSet.has(contestant.castaway_id));
}

// ------------------------------------------------------------
// Seeded RNG
// ------------------------------------------------------------

function mulberry32(a) {
  return function () {
    let t = (a += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function normalizeSeed(seed) {
  const numericSeed = Number(seed);

  if (!Number.isFinite(numericSeed)) {
    throw new Error("Puzzle seed must be a finite number.");
  }

  return Math.floor(numericSeed) >>> 0;
}
