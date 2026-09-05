// ------------------------------------------------------------
// Survivor Grid Frontend Logic (Dynamic Puzzle + Share View)
// ------------------------------------------------------------
console.log("GRID JS LOADED");
// ------------------------------------------------------------
// Imports
// ------------------------------------------------------------
import {
  getCategoryById,
  evaluateCategory
} from "./category-engine.js";

import {
  generateRandomPuzzle,
  generateSeededPuzzle
} from "./puzzle-generator.js";

import { initCategories } from "./category-loader.js";
import {
  buildCandidateUrls,
  fetchJsonWithFallback
} from "./resource-loader.js";
import { buildPuzzleUrlFromHref } from "./url-utils.js";
import { getDailyPuzzleDateParts, getDailyPuzzleKey } from "./daily-puzzle-clock.js";

// Global state
let contestants = [];
let ALL_CATEGORIES = [];
let CURRENT_PUZZLE = null;
let CURRENT_PUZZLE_MODE = "daily";
let CURRENT_PUZZLE_SEED = null;
let DAILY_PUZZLE_KEY = null;
let ACTIVE_DAILY_PUZZLE_METADATA = null;
let dailyScheduleLoadPromise = null;
let DAILY_PUZZLE_SCHEDULE = new Map();
let CUSTOM_SELECTED_IDS = [];
let CUSTOM_SLOT_SELECTION = new Map();
let CUSTOM_PENDING_SELECTION_IDS = null;
let contestantsLoadPromise = null;
let categoriesLoadPromise = null;
let rarityDataLoadPromise = null;
let yesterdayGridDataLoadPromise = null;
let YESTERDAY_GRID_DATA = null;
let dailyPuzzleRolloverTimer = null;
let _activeModalClose = null;

const ANALYTICS_ENDPOINT = "https://www.castawaycross.com/api/analytics/events";
const DAILY_ACTIVITY_ENDPOINT = "https://www.castawaycross.com/api/analytics/events";
const ANALYTICS_SESSION_STORAGE_KEY = "castaway-cross-analytics-session-v1";
const ANALYTICS_CLIENT_ID_STORAGE_KEY = "castaway-cross-analytics-client-id-v1";
const DAILY_ACTIVITY_DATE_STORAGE_KEY = "castaway-cross-daily-activity-date-v1";

const PUZZLE_SCHEMA_VERSION = "1";
const DAILY_PUZZLE_MANIFEST_SCHEMA_VERSION = "1";
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
const DAILY_ONE_TIME_MANIFEST_OVERRIDE_DATE_KEY = "2026-03-14";
const DAILY_ONE_TIME_MANIFEST_OVERRIDE_ENTRY = {
  dateKey: DAILY_ONE_TIME_MANIFEST_OVERRIDE_DATE_KEY,
  rows: [
    "format_all_returning_players",
    "played_in_central_america",
    "confessional_lowest_season"
  ],
  cols: [
    "played_in_palau",
    "challenge_participated_gross_food_challenge",
    "votes_against_season_4plus"
  ],
  metadata: {
    source: "one-time-manifest-override",
    notes: "Temporary override to align live daily with scheduled manifest for 2026-03-14."
  }
};
const PUZZLE_CACHE_STORAGE_KEY = "castaway-cross-puzzle-cache-v2";
const RANDOM_SETTINGS_STORAGE_KEY = "castaway-cross-random-settings-v1";
const VALID_DIFFICULTY_LEVELS = new Set(["easy", "medium", "hard"]);
const DIFFICULTY_POINT_RANGES = {
  easy: { min: 6, max: 7 },
  medium: { min: 8, max: 10 },
  hard: { min: 11, max: Number.POSITIVE_INFINITY }
};
const DEFAULT_RANDOM_SETTINGS = {
  excludedCategoryIds: [],
  excludedCategoryTypes: [],
  watchedSeasons: [],
  allowNonUSOnlyIntersections: false,
  selectedDifficulties: ["easy", "medium", "hard"]
};

let RANDOM_SETTINGS = loadRandomSettings();

let usedContestants = new Set();
let rowHeaders = [];
let colHeaders = [];

const inputSelection = new WeakMap();
const incorrectGuessCache = new WeakMap();
const wiredInputs = new WeakSet();
let CASTAWAY_RARITY_BY_CASTAWAY_ID = new Map();
let CASTAWAY_RARITY_BY_NAME = new Map();
let CATEGORY_PAIR_RARITY = new Map();
let SINGLE_CATEGORY_RARITY = new Map();
// normalized name -> Map(castaway_id -> disambiguated count), for shared names.
let NAME_PREVALENCE = new Map();
// normalized name -> Set(castaway_id), built from the roster.
let NAME_TO_CASTAWAY_IDS = new Map();

function normalizeRarityName(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function parseRarityGuessCount(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function getRarityGuessCountForContestant(contestant) {
  const castawayId = typeof contestant?.castaway_id === "string"
    ? contestant.castaway_id.trim()
    : (contestant?.castaway_id ?? "");
  if (castawayId && CASTAWAY_RARITY_BY_CASTAWAY_ID.has(castawayId)) {
    return CASTAWAY_RARITY_BY_CASTAWAY_ID.get(castawayId) ?? 0;
  }

  // Legacy fallback for rarity rows that predate castaway-id tagging. Match
  // only on the full canonical/display name(s) — never on bare first/last-name
  // tokens. When a display name is shared by multiple castaways, the all-time
  // bucket for that name is split across them (see splitNameBucketShare) so a
  // low-profile "Russell Swan" no longer inherits "Russell" Hantz's full count.
  const nameCandidates = new Set();
  const fullName = String(contestant?.name || "").trim();
  const displayNames = Array.isArray(contestant?.display_name) ? contestant.display_name : [];
  [fullName, ...displayNames].forEach(name => {
    const normalized = normalizeRarityName(name);
    if (normalized) nameCandidates.add(normalized);
  });

  let best = 0;
  nameCandidates.forEach(key => {
    const bucket = CASTAWAY_RARITY_BY_NAME.get(key) ?? 0;
    if (bucket > 0) best = Math.max(best, splitNameBucketShare(key, castawayId, bucket));
  });
  return best;
}

// A name bucket shared by several castaways is divided in proportion to how
// often each was the disambiguated answer for that name (NAME_PREVALENCE),
// falling back to an even split when there's no signal. A name unique to one
// castaway returns the full bucket.
function splitNameBucketShare(nameKey, castawayId, bucket) {
  const group = NAME_TO_CASTAWAY_IDS.get(nameKey);
  if (!group || group.size <= 1) return bucket;

  const weights = NAME_PREVALENCE.get(nameKey);
  if (weights) {
    let totalWeight = 0;
    group.forEach(id => { totalWeight += weights.get(id) ?? 0; });
    if (totalWeight > 0) {
      return bucket * ((weights.get(castawayId) ?? 0) / totalWeight);
    }
  }
  return bucket / group.size;
}


const CATEGORY_INFO_BY_TYPE = {
  season_played: "Season: players who appeared in a specific season, era, location, or season-themed clue.",
  season_group_played: "Season: players who appeared in a specific season, era, location, or season-themed clue.",
  placement_equals: "Placement: players who finished in a specific placement (for example, Sole Survivor, Runner-Up, or Third Place).",
  season_list_nonempty: "Milestones: players who reached (or did not reach) major game stages like Merge, Jury, or Final Tribal Council.",
  season_list_empty: "Milestones: players who reached (or did not reach) major game stages like Merge, Jury, or Final Tribal Council.",
  season_list_not_covering_all_seasons: "Milestones: players who reached (or did not reach) major game stages like Merge, Jury, or Final Tribal Council.",
  boolean_flag: "Returning Player: players who competed on more than one season.",
  advantage_held: "Advantages: players who received, held, used, or successfully/unsuccessfully played an advantage.",
  advantage_used: "Advantages: players who received, held, used, or successfully/unsuccessfully played an advantage.",
  advantage_success: "Advantages: players who received, held, used, or successfully/unsuccessfully played an advantage.",
  advantage_failed: "Advantages: players who received, held, used, or successfully/unsuccessfully played an advantage.",
  advantage_found: "Advantages: players who found a specific advantage type.",
  advantage_received: "Advantages: players who received a specific advantage type.",
  immunity_wins_count: "Immunity Wins: players with at least the listed number of individual or career immunity wins.",
  confessional_count: "Confessionals: players with at least the listed number of career confessionals.",
  votes_against_count: "Votes Against: players who received at least the listed number of non-nullified votes against them across their career (votes nullified by idols/advantages do not count).",
  sit_out_min_count: "Sit-Outs: players with at least the listed number of times they sat out of challenges across their career.",
  tribe_color: "Tribe Color: players who were on a tribe with the listed buff color (grouped by color family).",
  firemaking_result: "Firemaking: players who won or lost a firemaking tiebreaker challenge.",
  castaway_id_in_set: "Challenges: players who participated in or won a specific recurring challenge grouping.",
  gender_equals: "Gender: players who are categorized as men or women."
};

const RANDOM_SETTINGS_TYPE_ORDER = [
  "returning_states",
  "placement_equals",
  "immunity_wins_count",
  "firemaking_result",
  "sit_out_min_count",
  "season_played",
  "season_group_played",
  "castaway_id_in_set",
  "player_voting",
  "juror_actions",
  "confessional_count",
  "tribe_color",
  "auction_actions",
  "journey_outcome",
  "gender_equals",
  "age",
  "advantage_held",
  "advantage_success",
  "advantage_failed",
  "advantage_used",
  "advantage_found",
  "advantage_received"
];

const RANDOM_SETTINGS_TYPE_LABELS = {
  advantage_held: "Advantage Held",
  returning_states: "New/Returning",
  placement_equals: "Placement",
  immunity_wins_count: "Immunity Wins",
  firemaking_result: "Firemaking",
  sit_out_min_count: "Sit-outs",
  advantage_success: "Advantage Successful",
  advantage_failed: "Advantage Failed",
  advantage_used: "Advantage Used",
  advantage_found: "Advantage Found",
  advantage_received: "Advantage Received",
  season_played: "Season Played",
  season_group_played: "Season Groupings",
  castaway_id_in_set: "Challenge Groupings",
  player_voting: "Player Voting",
  juror_actions: "Juror Voting",
  confessional_count: "Confessionals",
  tribe_color: "Tribe Colors",
  auction_actions: "Auctions",
  journey_outcome: "Journeys",
  gender_equals: "Gender",
  age: "Age"
};

const RANDOM_SETTINGS_CATEGORY_TYPE_OVERRIDES = {
  status_returning: "returning_states",
  status_one_time_player: "returning_states",
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

let activeCategoryInfoPopover = null;
let activeCategoryInfoButton = null;
let analyticsSession = null;
let hasTrackedPuzzleStart = false;
let hasTrackedFirstGuess = false;
let hasTrackedPuzzleCompleted = false;
let hasTrackedExit = false;
let puzzlesStartedThisSession = 0;
let puzzlesCompletedThisSession = 0;
let puzzleGuessAttempts = [];

const PUZZLE_TYPES = ["daily", "custom", "random"];

function buildEmptyPuzzleOutcomeStats() {
  return {
    daily: { completed: 0, abandoned: 0 },
    custom: { completed: 0, abandoned: 0 },
    random: { completed: 0, abandoned: 0 }
  };
}

let puzzleOutcomeStatsByType = buildEmptyPuzzleOutcomeStats();

function normalizePuzzleType(mode) {
  if (PUZZLE_TYPES.includes(mode)) return mode;
  return "random";
}

function buildPuzzleOutcomeSummary() {
  const byType = {};
  let totalCompleted = 0;
  let totalAbandoned = 0;

  PUZZLE_TYPES.forEach(type => {
    const completed = puzzleOutcomeStatsByType[type].completed;
    const abandoned = puzzleOutcomeStatsByType[type].abandoned;
    const attempted = completed + abandoned;
    byType[type] = { completed, abandoned, attempted };
    totalCompleted += completed;
    totalAbandoned += abandoned;
  });

  return {
    byType,
    totals: {
      completed: totalCompleted,
      abandoned: totalAbandoned,
      attempted: totalCompleted + totalAbandoned
    }
  };
}

function safeGetLocalStorage(key) {
  try {
    return localStorage.getItem(key);
  } catch (error) {
    console.warn("[grid] localStorage unavailable for read.", error);
    return null;
  }
}

function safeSetLocalStorage(key, value) {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch (error) {
    console.warn("[grid] localStorage unavailable for write.", error);
    return false;
  }
}

function getUtcDateKey() {
  return new Date().toISOString().slice(0, 10);
}

function getAnonymousClientId() {
  const existing = safeGetLocalStorage(ANALYTICS_CLIENT_ID_STORAGE_KEY);
  if (existing) return existing;

  const created = window.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  safeSetLocalStorage(ANALYTICS_CLIENT_ID_STORAGE_KEY, created);
  return created;
}

function trackDailyActiveUser() {
  const utcDate = getUtcDateKey();
  const lastSentDate = safeGetLocalStorage(DAILY_ACTIVITY_DATE_STORAGE_KEY);
  if (lastSentDate === utcDate) return;

  const encodedBody = JSON.stringify({
    event: "daily_active_user",
    utcDate,
    clientId: getAnonymousClientId()
  });

  const postJson = endpoint => fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: encodedBody,
    keepalive: true
  });

  postJson(DAILY_ACTIVITY_ENDPOINT)
    .then(response => {
      if (response.ok) return response;
      return postJson(ANALYTICS_ENDPOINT);
    })
    .then(response => {
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      safeSetLocalStorage(DAILY_ACTIVITY_DATE_STORAGE_KEY, utcDate);
    })
    .catch(error => {
      console.warn("[grid] Daily activity event failed.", error);
    });
}

function getBrowserFamily() {
  const ua = navigator.userAgent || "";
  if (/Edg\//.test(ua)) return "edge";
  if (/Chrome\//.test(ua) && !/Edg\//.test(ua)) return "chrome";
  if (/Firefox\//.test(ua)) return "firefox";
  if (/Safari\//.test(ua) && !/Chrome\//.test(ua)) return "safari";
  return "other";
}

function getDeviceClass() {
  const ua = navigator.userAgent || "";
  const width = window.innerWidth || 0;
  const isTablet = /iPad|Tablet|PlayBook|Silk/i.test(ua)
    || (/Android/i.test(ua) && !/Mobile/i.test(ua))
    || (width >= 768 && width <= 1024);

  if (isTablet) return "tablet";
  if (/Mobi|Android|iPhone|iPod/i.test(ua) || width < 768) return "mobile";
  return "desktop";
}

function readStoredAnalyticsSession() {
  const raw = sessionStorage.getItem(ANALYTICS_SESSION_STORAGE_KEY);
  if (!raw) return null;

  try {
    return JSON.parse(raw);
  } catch (error) {
    console.warn("[grid] Invalid analytics session payload ignored.", error);
    return null;
  }
}

function buildLandingContext() {
  const params = new URLSearchParams(window.location.search);
  const utm = {
    source: params.get("utm_source") || null,
    medium: params.get("utm_medium") || null,
    campaign: params.get("utm_campaign") || null,
    term: params.get("utm_term") || null,
    content: params.get("utm_content") || null
  };

  return {
    sessionId: window.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    startedAt: new Date().toISOString(),
    landingPath: window.location.pathname,
    landingReferrer: document.referrer || null,
    utm
  };
}

function getAnalyticsSession() {
  if (analyticsSession) return analyticsSession;

  const existing = readStoredAnalyticsSession();
  analyticsSession = existing || buildLandingContext();
  sessionStorage.setItem(ANALYTICS_SESSION_STORAGE_KEY, JSON.stringify(analyticsSession));
  return analyticsSession;
}

function getAnalyticsPuzzleMeta() {
  return {
    mode: CURRENT_PUZZLE_MODE,
    seed: Number.isInteger(CURRENT_PUZZLE_SEED) ? CURRENT_PUZZLE_SEED : null,
    dailyPuzzleKey: DAILY_PUZZLE_KEY,
    guessesRemaining
  };
}

function getCellAttemptSequence(row, col) {
  const matchingAttempts = puzzleGuessAttempts.filter(attempt => attempt.row === row && attempt.col === col);
  return matchingAttempts.length + 1;
}

function recordPuzzleGuessAttempt({ row, col, contestant, outcome }) {
  if (!contestant) return;

  puzzleGuessAttempts.push({
    row,
    col,
    cell: `${row}-${col}`,
    attemptSequence: getCellAttemptSequence(row, col),
    contestantId: contestant.castaway_id || null,
    contestantName: getCanonicalName(contestant),
    outcome,
    timestamp: new Date().toISOString()
  });
}

function buildPuzzleCompletionCellSummary() {
  const inputs = Array.from(document.querySelectorAll("#game-grid .cell input"));
  return inputs.map((input, index) => {
    const selectedContestant = inputSelection.get(input);
    const contestantId = typeof selectedContestant?.castaway_id === "string"
      ? selectedContestant.castaway_id.trim()
      : "";
    return {
      row: Math.floor(index / 3),
      col: index % 3,
      state: input.dataset.state || "blank",
      displayedValue: input.value.trim() || "",
      // Stable castaway identifier captured at guess time so rarity can be
      // aggregated by ID upstream instead of by ambiguous display names.
      contestantId: contestantId || null
    };
  });
}

function sendAnalyticsEvent(eventName, payload = {}, { useBeacon = false } = {}) {
  const session = getAnalyticsSession();
  const body = {
    event: eventName,
    timestamp: new Date().toISOString(),
    sessionId: session.sessionId,
    landing: {
      path: session.landingPath,
      referrer: session.landingReferrer,
      utm: session.utm
    },
    device: {
      class: getDeviceClass(),
      browserFamily: getBrowserFamily(),
      viewport: `${window.innerWidth || 0}x${window.innerHeight || 0}`
    },
    puzzle: getAnalyticsPuzzleMeta(),
    payload
  };

  const encodedBody = JSON.stringify(body);

  if (useBeacon && navigator.sendBeacon) {
    const blob = new Blob([encodedBody], { type: "application/json" });
    navigator.sendBeacon(ANALYTICS_ENDPOINT, blob);
    return;
  }

  fetch(ANALYTICS_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: encodedBody,
    keepalive: useBeacon
  }).catch(error => {
    console.warn("[grid] Analytics event failed.", error);
  });
}

function trackPuzzleStarted() {
  if (hasTrackedPuzzleStart) return;
  hasTrackedPuzzleStart = true;
  puzzlesStartedThisSession += 1;
  sendAnalyticsEvent("puzzle_started", {
    trigger: "guess_attempt"
  });
}

function trackFirstGuess(details) {
  if (hasTrackedFirstGuess) return;
  hasTrackedFirstGuess = true;
  sendAnalyticsEvent("first_guess", details);
}

function trackPuzzleCompleted(details) {
  if (hasTrackedPuzzleCompleted) return;
  hasTrackedPuzzleCompleted = true;
  puzzlesCompletedThisSession += 1;
  const puzzleType = normalizePuzzleType(CURRENT_PUZZLE_MODE);
  puzzleOutcomeStatsByType[puzzleType].completed += 1;
  sendAnalyticsEvent("puzzle_completed", details);
}

function trackPuzzleAbandoned(trigger) {
  if (!hasTrackedPuzzleStart || hasTrackedPuzzleCompleted || !CURRENT_PUZZLE) return;

  const puzzleType = normalizePuzzleType(CURRENT_PUZZLE_MODE);
  puzzleOutcomeStatsByType[puzzleType].abandoned += 1;

  sendAnalyticsEvent("puzzle_abandoned", {
    trigger,
    mode: CURRENT_PUZZLE_MODE,
    seed: Number.isInteger(CURRENT_PUZZLE_SEED) ? CURRENT_PUZZLE_SEED : null,
    guessesRemaining
  });
}

// ------------------------------------------------------------
// Data loading
// ------------------------------------------------------------

// Load contestants
async function loadContestants() {
  if (!contestantsLoadPromise) {
    contestantsLoadPromise = (async () => {
      const contestantsCandidates = buildCandidateUrls({
        preferredAbsolutePath: "/castaway-cross/data/processed/contestants.json",
        relativeFromModule: "../../data/processed/contestants.json",
        moduleUrl: import.meta.url
      });

      contestants = await fetchJsonWithFallback({
        label: "contestants",
        candidates: contestantsCandidates,
        cacheKey: "contestants-static-dataset"
      });

      window.contestants = contestants;
    })();
  }

  await contestantsLoadPromise;
}

async function loadAllCategories() {
  if (!categoriesLoadPromise) {
    categoriesLoadPromise = initCategories();
  }

  ALL_CATEGORIES = await categoriesLoadPromise;
}

async function loadRarityData() {
  if (!rarityDataLoadPromise) {
    rarityDataLoadPromise = (async () => {
      const candidates = buildCandidateUrls({
        preferredAbsolutePath: "/castaway-cross/frontend/data/rarity-by-cell.json",
        relativeFromModule: "../data/rarity-by-cell.json",
        moduleUrl: import.meta.url
      });

      const payload = await fetchJsonWithFallback({
        label: "rarity data",
        candidates,
        cacheKey: "rarity-data-v1"
      });

      const rows = Array.isArray(payload?.data) ? payload.data : [];
      const byName = new Map();
      const byCastawayId = new Map();
      rows.forEach(row => {
        const count = parseRarityGuessCount(row?.total_guess_count ?? row?.guess_count ?? row?.daily_guess_count);

        // Prefer the stable castaway id emitted by the upstream dashboard so
        // distinct castaways that share a display name keep separate counts.
        const castawayId = typeof row?.castaway_id === "string"
          ? row.castaway_id.trim()
          : (row?.castaway_id != null ? String(row.castaway_id).trim() : "");
        // Accumulate rather than overwrite: the upstream dashboard can emit more
        // than one row for the same castaway/name (e.g. a legacy null-id row plus
        // a newer id-tagged row from the mid-stream id migration). Summing keeps a
        // contestant's all-time total whole instead of letting the last row win.
        if (castawayId) {
          byCastawayId.set(castawayId, (byCastawayId.get(castawayId) ?? 0) + count);
        }

        // Retain a name-keyed map purely as a legacy fallback for rows that
        // predate castaway-id tagging.
        const key = normalizeRarityName(row?.castaway_name);
        if (key) byName.set(key, (byName.get(key) ?? 0) + count);
      });
      CASTAWAY_RARITY_BY_NAME = byName;
      CASTAWAY_RARITY_BY_CASTAWAY_ID = byCastawayId;

      const pairCandidates = buildCandidateUrls({
        preferredAbsolutePath: "/castaway-cross/frontend/data/rarity-by-category-pair.json",
        relativeFromModule: "../data/rarity-by-category-pair.json",
        moduleUrl: import.meta.url
      });
      const pairPayload = await fetchJsonWithFallback({
        label: "category-pair rarity data",
        candidates: pairCandidates,
        cacheKey: "rarity-category-pair-v1"
      }).catch(() => null);
      const pairData = pairPayload?.data && typeof pairPayload.data === "object" ? pairPayload.data : {};
      const pairRows = pairData?.pairs && typeof pairData.pairs === "object" ? pairData.pairs : {};
      const categoryRows = pairData?.categories && typeof pairData.categories === "object" ? pairData.categories : {};
      CATEGORY_PAIR_RARITY = new Map(Object.entries(pairRows));
      SINGLE_CATEGORY_RARITY = new Map(Object.entries(categoryRows));

      const namePrevalenceRows = pairData?.namePrevalence && typeof pairData.namePrevalence === "object"
        ? pairData.namePrevalence
        : {};
      NAME_PREVALENCE = new Map(
        Object.entries(namePrevalenceRows).map(([name, byId]) => [
          name,
          new Map(Object.entries(byId && typeof byId === "object" ? byId : {}).map(([id, c]) => [id, Number(c) || 0]))
        ])
      );

      // Roster-derived map of which castaways share each normalized name, so the
      // name fallback can detect (and split) shared name buckets.
      const nameToIds = new Map();
      contestants.forEach(contestant => {
        const id = contestant?.castaway_id;
        if (!id) return;
        [contestant?.name, ...(Array.isArray(contestant?.display_name) ? contestant.display_name : [])].forEach(name => {
          const key = normalizeRarityName(name);
          if (!key) return;
          if (!nameToIds.has(key)) nameToIds.set(key, new Set());
          nameToIds.get(key).add(id);
        });
      });
      NAME_TO_CASTAWAY_IDS = nameToIds;
    })().catch(error => {
      console.warn("[grid] Failed to load rarity data.", error);
      CASTAWAY_RARITY_BY_CASTAWAY_ID = new Map();
      CASTAWAY_RARITY_BY_NAME = new Map();
      CATEGORY_PAIR_RARITY = new Map();
      SINGLE_CATEGORY_RARITY = new Map();
      NAME_PREVALENCE = new Map();
      NAME_TO_CASTAWAY_IDS = new Map();
    });
  }

  await rarityDataLoadPromise;
}

async function loadYesterdayGridData() {
  if (!yesterdayGridDataLoadPromise) {
    yesterdayGridDataLoadPromise = (async () => {
      const candidates = buildCandidateUrls({
        preferredAbsolutePath: "/castaway-cross/frontend/data/yesterday-grid-popular-answers.json",
        relativeFromModule: "../data/yesterday-grid-popular-answers.json",
        moduleUrl: import.meta.url
      });

      YESTERDAY_GRID_DATA = await fetchJsonWithFallback({
        label: "yesterday grid popular answers",
        candidates,
        cacheKey: "yesterday-grid-popular-answers-v1"
      });
    })().catch(error => {
      console.warn("[grid] Failed to load yesterday grid data.", error);
    });
  }

  await yesterdayGridDataLoadPromise;
}

function renderYesterdayPopularAnswers() {
  const containerId = "yesterday-answers";
  let container = document.getElementById(containerId);

  if (!container) {
    const shareView = document.getElementById("share-view");
    if (!shareView) return;
    container = document.createElement("section");
    container.id = containerId;
    container.className = "yesterday-answers-section";
    shareView.after(container);
  }

  container.innerHTML = "";

  if (!YESTERDAY_GRID_DATA || YESTERDAY_GRID_DATA.noData || !YESTERDAY_GRID_DATA.cells) {
    return;
  }

  const data = YESTERDAY_GRID_DATA;

  // The builder emits a cells-only-empty payload (no noData flag) when the
  // puzzle is known but analytics has not caught up with it yet. Rendering
  // that would be a grid of nine dashes, so treat it as nothing to show.
  const hasAnyAnswers = Object.values(data.cells)
    .some(cell => Array.isArray(cell?.topAnswers) && cell.topAnswers.length > 0);
  if (!hasAnyAnswers) {
    return;
  }

  // Build name→contestant lookup so we can resolve all-time rarity per intersection
  const contestantByNormalizedName = new Map();
  contestants.forEach(c => {
    [c.name, ...(Array.isArray(c.display_name) ? c.display_name : [])].forEach(n => {
      const key = normalizeRarityName(n);
      if (key && !contestantByNormalizedName.has(key)) contestantByNormalizedName.set(key, c);
    });
  });

  function getIntersectionRarity(name, rowCategoryId, colCategoryId) {
    const pairKey = buildCategoryPairKey(rowCategoryId, colCategoryId);
    const pairEntry = pairKey ? CATEGORY_PAIR_RARITY.get(pairKey) : null;
    if (!pairEntry || Number(pairEntry.total) < 10) return null;
    const contestant = contestantByNormalizedName.get(normalizeRarityName(name));
    const castawayId = contestant?.castaway_id;
    if (!castawayId) return null;
    const count = Number(pairEntry.castawayCounts?.[castawayId] ?? 0);
    const total = Number(pairEntry.total);
    return total > 0 ? Math.round((count / total) * 1000) / 10 : null;
  }

  const details = document.createElement("details");
  details.className = "yesterday-answers-details";

  const summary = document.createElement("summary");
  summary.textContent = `Yesterday's Most Popular Answers (${data.puzzleDate || ""})`;
  details.appendChild(summary);

  const rowCategoryIds = Array.isArray(data.rows) ? data.rows : [];
  const colCategoryIds = Array.isArray(data.cols) ? data.cols : [];

  function buildCategoryHeader(categoryId, axis) {
    const header = document.createElement("div");
    header.className = `yesterday-answers-header yesterday-answers-header-${axis}`;

    const category = getCategoryById(categoryId);
    const label = category?.label || "";
    header.textContent = label || "—";
    if (label) header.title = label;

    return header;
  }

  // Lay the section out like the puzzle itself -- an empty corner, the three
  // column categories across the top, the three row categories down the left
  // -- so every cell's answers read against the pair that produced them.
  const grid = document.createElement("div");
  grid.className = "yesterday-answers-grid";

  const corner = document.createElement("div");
  corner.className = "yesterday-answers-corner";
  corner.setAttribute("aria-hidden", "true");
  grid.appendChild(corner);

  for (let col = 0; col < 3; col++) {
    grid.appendChild(buildCategoryHeader(colCategoryIds[col], "col"));
  }

  for (let row = 0; row < 3; row++) {
    grid.appendChild(buildCategoryHeader(rowCategoryIds[row], "row"));

    for (let col = 0; col < 3; col++) {
      const cellData = data.cells[`${row},${col}`];
      const rowCategoryId = rowCategoryIds[row];
      const colCategoryId = colCategoryIds[col];
      const cell = document.createElement("div");
      cell.className = "yesterday-answers-cell";

      const topAnswers = Array.isArray(cellData?.topAnswers) ? cellData.topAnswers : [];

      if (topAnswers.length > 0) {
        const total = cellData.totalGuesses || 0;
        const answers = [...topAnswers]
          .sort((a, b) => (b.count || 0) - (a.count || 0))
          .slice(0, 5);
        const list = document.createElement("ul");
        list.className = "yesterday-answer-list";

        answers.forEach((answer, index) => {
          const pct = total > 0 ? Math.round((answer.count / total) * 100) : 0;
          const rarity = getIntersectionRarity(answer.name, rowCategoryId, colCategoryId);
          const li = document.createElement("li");
          li.className = "yesterday-answer-item" + (index === 0 ? " top-answer" : "");

          const nameEl = document.createElement("span");
          nameEl.className = "yesterday-answer-name";
          nameEl.textContent = answer.name;

          const metaEl = document.createElement("span");
          metaEl.className = "yesterday-answer-meta";
          metaEl.textContent = `${pct}%`;

          li.append(nameEl, metaEl);

          if (rarity !== null) {
            const rarityEl = document.createElement("span");
            rarityEl.className = "yesterday-answer-rarity";
            rarityEl.textContent = `${rarity}%`;
            rarityEl.title = "All-time rarity at this intersection";
            li.appendChild(rarityEl);
          }

          list.appendChild(li);
        });

        cell.appendChild(list);
      } else {
        cell.classList.add("is-empty");
        cell.textContent = "—";
      }

      grid.appendChild(cell);
    }
  }

  details.appendChild(grid);
  container.appendChild(details);
}

function getContestantRarityScore(contestant, eligibleContestants) {
  if (!contestant) return 0;

  const numerator = getRarityGuessCountForContestant(contestant);
  const denominator = (Array.isArray(eligibleContestants) ? eligibleContestants : []).reduce((sum, eligible) => {
    return sum + getRarityGuessCountForContestant(eligible);
  }, 0);

  const rawPercent = denominator > 0 ? (numerator / denominator) * 100 : 0;
  const bounded = Math.max(0, Math.min(100, rawPercent));
  return Math.round(bounded * 10) / 10;
}

function buildCategoryPairKey(rowCategoryId, colCategoryId) {
  const left = String(rowCategoryId || "").trim();
  const right = String(colCategoryId || "").trim();
  if (!left || !right) return null;
  return [left, right].sort().join("::");
}

function getContestantCategoryPairRarityScore(contestant, eligibleContestants, rowCategoryId, colCategoryId) {
  const eligibleList = Array.isArray(eligibleContestants) ? eligibleContestants : [];
  const pairKey = buildCategoryPairKey(rowCategoryId, colCategoryId);
  const pairEntry = pairKey ? CATEGORY_PAIR_RARITY.get(pairKey) : null;
  if (pairEntry && Number(pairEntry.total) > 100) {
    const counts = pairEntry.castawayCounts || {};
    const numerator = Number(counts[contestant?.castaway_id] ?? 0);
    const denominator = eligibleList.reduce((sum, eligible) => {
      return sum + Number(counts[eligible?.castaway_id] ?? 0);
    }, 0);
    const rawPercent = denominator > 0 ? (numerator / denominator) * 100 : 0;
    const bounded = Math.max(0, Math.min(100, rawPercent));
    return Math.round(bounded * 10) / 10;
  }

  const rowEntry = SINGLE_CATEGORY_RARITY.get(String(rowCategoryId || "").trim());
  const colEntry = SINGLE_CATEGORY_RARITY.get(String(colCategoryId || "").trim());
  if (rowEntry || colEntry) {
    const averagedById = new Map();
    eligibleList.forEach(eligible => {
      const castawayId = eligible?.castaway_id;
      if (!castawayId) return;

      const rowPct = rowEntry
        ? (Number(rowEntry.castawayCounts?.[castawayId] ?? 0) / Math.max(1, Number(rowEntry.total) || 0))
        : 0;
      const colPct = colEntry
        ? (Number(colEntry.castawayCounts?.[castawayId] ?? 0) / Math.max(1, Number(colEntry.total) || 0))
        : 0;
      const parts = [rowEntry ? rowPct : null, colEntry ? colPct : null].filter(value => value != null);
      const averaged = parts.length ? parts.reduce((sum, value) => sum + value, 0) / parts.length : 0;
      averagedById.set(castawayId, averaged);
    });

    const totalAveraged = Array.from(averagedById.values()).reduce((sum, value) => sum + value, 0);
    const normalized = totalAveraged > 0
      ? ((averagedById.get(contestant?.castaway_id) ?? 0) / totalAveraged) * 100
      : 0;
    return Math.round(Math.max(0, Math.min(100, normalized)) * 10) / 10;
  }

  return getContestantRarityScore(contestant, eligibleList);
}

function findEligibleContestantByGuessText(guessText, eligibleContestants) {
  const normalizedGuess = normalizeRarityName(guessText);
  if (!normalizedGuess) return null;

  return (Array.isArray(eligibleContestants) ? eligibleContestants : []).find(contestant => {
    const names = [
      contestant?.name,
      ...(Array.isArray(contestant?.display_name) ? contestant.display_name : [])
    ];
    return names.some(name => normalizeRarityName(name) === normalizedGuess);
  }) || null;
}

function renderLiveRarityForInput(input) {
  const cell = input?.closest(".cell");
  if (!cell) return;

  cell.querySelector(".cell-live-rarity")?.remove();

  if (input.dataset.state !== "correct") return;

  const row = Number(input.dataset.row);
  const col = Number(input.dataset.col);
  if (!Number.isInteger(row) || !Number.isInteger(col)) return;

  const cellContestants = CURRENT_PUZZLE?.grid?.[row]?.[col] ?? [];
  const selectedContestant = inputSelection.get(input);
  const matchedContestant = selectedContestant
    ? cellContestants.find(contestant => contestant.castaway_id === selectedContestant.castaway_id)
    : findEligibleContestantByGuessText(input.value.trim(), cellContestants);
  const rarityScore = getContestantCategoryPairRarityScore(
    matchedContestant,
    cellContestants,
    rowHeaders[row],
    colHeaders[col]
  );

  const badge = document.createElement("div");
  badge.className = "cell-live-rarity";
  badge.textContent = `${rarityScore.toFixed(1)}%`;
  cell.appendChild(badge);
}

function renderCorrectCellHeadshot(cell, input, contestant, row, col) {
  input.style.display = "none";

  cell.querySelector(".cell-result-name")?.remove();
  cell.querySelector(".cell-result-meta")?.remove();
  cell.querySelector(".cell-result-rarity")?.remove();
  cell.querySelector(".cell-result-headshot")?.remove();
  cell.querySelector(".cell-result-zoom")?.remove();
  cell.querySelector(".cell-live-rarity")?.remove();

  cell.classList.add("completed-result", "completed-correct", "has-rarity");
  cell.classList.remove("completed-incorrect", "completed-neutral");

  const cellContestants = CURRENT_PUZZLE?.grid?.[row]?.[col] ?? [];
  const rarityScore = getContestantCategoryPairRarityScore(
    contestant,
    cellContestants,
    rowHeaders[row],
    colHeaders[col]
  );
  const count = cellContestants.length;

  const rarityEl = document.createElement("div");
  rarityEl.className = "cell-result-rarity";
  rarityEl.textContent = `${rarityScore.toFixed(1)}%`;

  const headshot = document.createElement("img");
  headshot.className = "cell-result-headshot";
  headshot.src = `/assets/headshots/${contestant.castaway_id}.webp`;
  headshot.alt = contestant.name || contestant.display_name?.[0] || "";
  headshot.onerror = () => { headshot.src = "/assets/headshots/filler.webp"; };

  const nameEl = document.createElement("div");
  nameEl.className = "cell-result-name";
  nameEl.textContent = getCanonicalName(contestant);

  if (guessesRemaining <= 0) {
    const zoomEl = document.createElement("div");
    zoomEl.className = "cell-result-zoom";
    zoomEl.setAttribute("aria-hidden", "true");
    zoomEl.innerHTML = `🔍 <span>${count}</span>`;
    cell.append(rarityEl, zoomEl, headshot, nameEl);

    if (cell.dataset.popupBound !== "true") {
      cell.addEventListener("click", () => {
        if (!cell.classList.contains("completed-result")) return;
        showValidContestantsPopup(row, col);
      });
      cell.dataset.popupBound = "true";
    }
  } else {
    cell.append(rarityEl, headshot, nameEl);
  }
  requestAnimationFrame(() => applyCondensedClassOnOverflow(nameEl));
}

function normalizeDailyScheduleEntry(rawEntry) {
  if (!rawEntry || typeof rawEntry !== "object") return null;

  const dateKey = typeof rawEntry.dateKey === "string" ? rawEntry.dateKey.trim() : "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) return null;
  if (!Array.isArray(rawEntry.rows) || rawEntry.rows.length !== 3) return null;
  if (!Array.isArray(rawEntry.cols) || rawEntry.cols.length !== 3) return null;

  const rowCategories = rawEntry.rows.map(id => getCategoryById(id));
  const colCategories = rawEntry.cols.map(id => getCategoryById(id));
  if ([...rowCategories, ...colCategories].some(category => !category)) {
    return null;
  }

  return {
    dateKey,
    rows: rowCategories,
    cols: colCategories,
    metadata: rawEntry.metadata && typeof rawEntry.metadata === "object" ? rawEntry.metadata : null
  };
}

function getOneTimeDailyManifestOverride(dateKey) {
  if (dateKey !== DAILY_ONE_TIME_MANIFEST_OVERRIDE_DATE_KEY) {
    return null;
  }

  return normalizeDailyScheduleEntry(DAILY_ONE_TIME_MANIFEST_OVERRIDE_ENTRY);
}

function resolveDailyPuzzleForKey(dateKey) {
  const todayKey = getTodayDailyPuzzleKey();
  if (dateKey > todayKey) {
    const error = new Error(`No daily puzzle is available yet for ${dateKey}.`);
    error.code = "DAILY_PUZZLE_FUTURE_DATE";
    throw error;
  }

  const scheduled = DAILY_PUZZLE_SCHEDULE.get(dateKey);
  const oneTimeOverride = !scheduled ? getOneTimeDailyManifestOverride(dateKey) : null;
  const selectedDailyEntry = scheduled || oneTimeOverride;

  if (!selectedDailyEntry) {
    // Keep daily mode playable even when the shipped schedule doesn't
    // contain this date yet (for example, after the latest manifest entry).
    // We derive a deterministic seed from the date key so every player gets
    // the same fallback daily puzzle for a given day.
    const seed = Number(dateKey.replace(/-/g, ""));

    if (!Number.isInteger(seed)) {
      const error = new Error(`No saved daily puzzle was found for ${dateKey}.`);
      error.code = "DAILY_PUZZLE_NOT_SCHEDULED";
      throw error;
    }

    console.warn(`[grid] Missing scheduled daily puzzle for ${dateKey}; using seeded fallback.`);
    ACTIVE_DAILY_PUZZLE_METADATA = { fallback: true, seed, dateKey };
    return generateDailyFallbackPuzzle(seed);
  }

  if (!scheduled && oneTimeOverride) {
    console.warn(`[grid] Using one-time manifest override for ${dateKey} instead of fallback.`);
  }

  ACTIVE_DAILY_PUZZLE_METADATA = selectedDailyEntry.metadata;
  return {
    rows: selectedDailyEntry.rows,
    cols: selectedDailyEntry.cols,
    grid: Array.from({ length: 3 }, (_, row) => Array.from({ length: 3 }, (_, col) => {
      const rowCategory = selectedDailyEntry.rows[row];
      const colCategory = selectedDailyEntry.cols[col];
      return contestants.filter(contestant => evaluateCategory(contestant, rowCategory) && evaluateCategory(contestant, colCategory));
    }))
  };
}

function resolveScheduledPuzzleBySeed(seed) {
  for (const scheduled of DAILY_PUZZLE_SCHEDULE.values()) {
    const metadataSeed = Number(scheduled?.metadata?.seed);
    if (!Number.isInteger(metadataSeed)) continue;
    if ((metadataSeed >>> 0) !== (seed >>> 0)) continue;

    ACTIVE_DAILY_PUZZLE_METADATA = scheduled.metadata;
    return {
      rows: scheduled.rows,
      cols: scheduled.cols,
      grid: Array.from({ length: 3 }, (_, row) => Array.from({ length: 3 }, (_, col) => {
        const rowCategory = scheduled.rows[row];
        const colCategory = scheduled.cols[col];
        return contestants.filter(contestant => evaluateCategory(contestant, rowCategory) && evaluateCategory(contestant, colCategory));
      }))
    };
  }

  return null;
}

async function loadDailyPuzzleSchedule() {
  if (!dailyScheduleLoadPromise) {
    dailyScheduleLoadPromise = (async () => {
      const candidates = buildCandidateUrls({
        preferredAbsolutePath: "/castaway-cross/frontend/data/daily-puzzles.json",
        relativeFromModule: "../data/daily-puzzles.json",
        moduleUrl: import.meta.url
      });

      const manifest = await fetchJsonWithFallback({
        label: "daily puzzle schedule",
        candidates,
        cacheKey: "daily-puzzle-schedule-v1",
        useCache: false,
        fetchImpl: (url, init) => fetch(url, { ...init, cache: "no-store" })
      });

      const schemaVersion = String(manifest?.schemaVersion ?? "");
      if (schemaVersion && schemaVersion !== DAILY_PUZZLE_MANIFEST_SCHEMA_VERSION) {
        console.warn(`[grid] Unsupported daily puzzle schedule schemaVersion=${schemaVersion}.`);
      }

      const entries = Array.isArray(manifest?.puzzles) ? manifest.puzzles : [];
      const scheduleMap = new Map();

      entries.forEach(entry => {
        const normalized = normalizeDailyScheduleEntry(entry);
        if (!normalized) return;
        scheduleMap.set(normalized.dateKey, normalized);
      });

      DAILY_PUZZLE_SCHEDULE = scheduleMap;
    })().catch(error => {
      console.warn("[grid] Failed to load daily puzzle schedule; falling back to generated dailies.", error);
      DAILY_PUZZLE_SCHEDULE = new Map();
    });
  }

  await dailyScheduleLoadPromise;
}

await loadContestants();

// Load categories
await loadAllCategories();
await loadDailyPuzzleSchedule();
await loadRarityData();
await loadYesterdayGridData();
initRandomSettingsUi();
initCustomModeUi();

// ------------------------------------------------------------
// Autocomplete helpers
// ------------------------------------------------------------
function getAvailableNames() {
  return contestants
    .filter(c => !usedContestants.has(c.castaway_id))
    .map(c => {
      const searchLabel = getSearchLabel(c);
      return {
        label: buildMergedLabel(c),
        searchLabel,
        normalizedSearchLabel: normalizeAutocompleteText(searchLabel),
        value: getCanonicalName(c),
        notorietyScore: Number(c.notoriety_score) || 0,
        contestant: c
      };
    });
}

function normalizeAutocompleteText(text) {
  return String(text || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, "");
}

function tokenizeForSearch(text) {
  return normalizeAutocompleteText(text)
    .split(/\s+/)
    .filter(Boolean);
}

function getAutocompleteMatchBonus(entry, query) {
  const display = normalizeAutocompleteText(entry.contestant.display_name?.[0] || "");
  const full = normalizeAutocompleteText(entry.contestant.name || "");

  const displayTokens = tokenizeForSearch(display);
  const fullTokens = tokenizeForSearch(full);

  let bonus = 0;

  if (display.startsWith(query)) {
    bonus += 30;
  } else if (displayTokens.some(token => token.startsWith(query))) {
    bonus += 24;
  } else if (display.includes(query)) {
    bonus += 18;
  }

  if (full.startsWith(query)) {
    bonus += 12;
  } else if (fullTokens.some(token => token.startsWith(query))) {
    bonus += 8;
  } else if (full.includes(query)) {
    bonus += 4;
  }

  return bonus;
}

function escapeHtmlText(text) {
  return String(text ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function renderAutocompleteOptionLabel(option, label) {
  if (typeof label === "string") {
    option.textContent = label;
    return;
  }

  option.append(document.createTextNode(label.prefix));

  const strong = document.createElement("strong");
  strong.textContent = label.highlight;
  option.append(strong);

  option.append(document.createTextNode(label.suffix));
}

function attachAutocomplete(input) {
  let dropdown;
  let vpResizeHandler = null;

  function positionDropdown() {
    if (!dropdown) return;
    const rect = input.getBoundingClientRect();
    const vv = window.visualViewport;
    const viewportHeight = vv ? vv.height : window.innerHeight;
    const vvTop = vv ? vv.offsetTop : 0;
    const vvLeft = vv ? vv.offsetLeft : 0;
    const spaceBelow = viewportHeight - rect.bottom - 8;

    dropdown.style.bottom = "";
    dropdown.style.top = `${rect.bottom + vvTop + 2}px`;
    dropdown.style.left = `${rect.left + vvLeft}px`;
    dropdown.style.width = `${rect.width}px`;
    dropdown.style.maxHeight = `${Math.max(60, Math.min(280, spaceBelow))}px`;
  }

  function removeDropdown() {
    dropdown?.remove();
    dropdown = null;
    if (vpResizeHandler) {
      window.visualViewport?.removeEventListener("resize", vpResizeHandler);
      window.visualViewport?.removeEventListener("scroll", vpResizeHandler);
      vpResizeHandler = null;
    }
  }

  input.addEventListener("input", () => {
    if (input.classList.contains("locked")) return;

    inputSelection.delete(input);

    const value = normalizeAutocompleteText(input.value);
    removeDropdown();
    if (!value) return;

    const names = getAvailableNames();
    const matches = names
      .filter(n => n.normalizedSearchLabel.includes(value))
      .map(entry => {
        const matchBonus = getAutocompleteMatchBonus(entry, value);
        return {
          ...entry,
          matchBonus,
          rankScore: entry.notorietyScore + matchBonus
        };
      })
      .sort((a, b) => {
        if (a.rankScore !== b.rankScore) return b.rankScore - a.rankScore;
        if (a.matchBonus !== b.matchBonus) return b.matchBonus - a.matchBonus;
        if (a.notorietyScore !== b.notorietyScore) return b.notorietyScore - a.notorietyScore;
        return a.value.localeCompare(b.value);
      })
      .slice(0, 10);

    if (matches.length === 0) return;

    dropdown = document.createElement("div");
    dropdown.className = "autocomplete-dropdown";

    matches.forEach(({ label, searchLabel, value: canonical, contestant }) => {
      const option = document.createElement("div");
      option.className = "autocomplete-option";
      option.dataset.escapedLabel = escapeHtmlText(searchLabel);
      renderAutocompleteOptionLabel(option, label);

      option.addEventListener("mousedown", () => {
        input.value = canonical;
        inputSelection.set(input, contestant);
        removeDropdown();
        validateWiredInput(input);
      });

      dropdown.appendChild(option);
    });

    document.body.appendChild(dropdown);
    positionDropdown();

    vpResizeHandler = positionDropdown;
    window.visualViewport?.addEventListener("resize", vpResizeHandler);
    window.visualViewport?.addEventListener("scroll", vpResizeHandler);
  });

  input.addEventListener("blur", () => {
    setTimeout(removeDropdown, 100);
  });
}

// Normalizes punctuation users commonly omit: "vs." → "vs", hyphens → spaces
function normalizeForSearch(str) {
  return str
    .replace(/\bvs\.\s*/g, "vs ")
    .replace(/[-–—]/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

const CATEGORY_SYNONYMS = {
  "sole survivor":              ["winner", "won"],
  "runner-up":                  ["2nd", "2nd place", "second place"],
  "third place":                ["3rd", "3rd place"],
  "made final tribal council":  ["ftc", "final tribal", "finalist"],
  "never reached final tribal": ["never ftc", "missed ftc"],
  "first boot":                 ["first out", "first voted out"],
  "pre-merge boot":             ["premerge"],
  "pre-jury boot":              ["prejury"],
  "on the jury":                ["juror"],
  "made the merge":             ["merged"],
};

function buildCategorySearchAliases(label) {
  const lc = label.toLowerCase();
  const aliases = [];

  // Season number aliases: "Season: Name (N)" / "Season (Region): Name (N)" → "season N", "sN"
  if (lc.startsWith("season")) {
    const numMatch = lc.match(/\((\d+)\)\s*$/);
    if (numMatch) {
      const n = numMatch[1];
      aliases.push(`season ${n}`, `s${n}`);
      const regionMatch = lc.match(/^season \(([^)]+)\)/);
      if (regionMatch) aliases.push(`${regionMatch[1]} ${n}`);
    } else {
      const plainNumMatch = lc.match(/^season (\d+)\s*$/);
      if (plainNumMatch) aliases.push(`s${plainNumMatch[1]}`);
    }
  }

  // Synonym aliases (e.g. "winner" → Sole Survivor, "ftc" → Made Final Tribal Council)
  if (CATEGORY_SYNONYMS[lc]) aliases.push(...CATEGORY_SYNONYMS[lc]);

  return aliases;
}

function getCustomCategoryOptions() {
  return getPublicUiEligibleCategories().map(category => {
    const label = String(category.label || "");
    const searchLabel = label.toLowerCase();
    return {
      category,
      label,
      searchLabel,
      normalizedSearchLabel: normalizeForSearch(searchLabel),
      searchAliases: buildCategorySearchAliases(label)
    };
  });
}

function categoryMatchesQuery(opt, value) {
  // 1. Direct substring match
  if (opt.searchLabel.includes(value)) return true;
  // 2. Alias match (season numbers, s-shorthand, synonyms)
  if (opt.searchAliases.some(a => a.includes(value))) return true;
  // 3. Normalized match: "runner up" → "Runner-Up", "david vs goliath" → "vs."
  const normValue = normalizeForSearch(value);
  if (opt.normalizedSearchLabel.includes(normValue)) return true;
  if (opt.searchAliases.some(a => normalizeForSearch(a).includes(normValue))) return true;
  // 4. Token-order-independent: all query words must appear somewhere in the label
  const tokens = normValue.split(" ").filter(t => t.length > 1);
  if (tokens.length > 1 && tokens.every(t => opt.normalizedSearchLabel.includes(t))) return true;
  return false;
}

function hasPublicUiEligibleContestants(category) {
  const eligibleCount = Number(category?.eligible_castaway_count);
  if (Number.isFinite(eligibleCount)) {
    return eligibleCount >= 3;
  }

  return true;
}

function getPublicUiEligibleCategories() {
  return ALL_CATEGORIES.filter(category => (
    category?.enabled !== false && hasPublicUiEligibleContestants(category)
  ));
}

function getCustomSelectionIds() {
  return [
    CUSTOM_SLOT_SELECTION.get("row-0") || null,
    CUSTOM_SLOT_SELECTION.get("row-1") || null,
    CUSTOM_SLOT_SELECTION.get("row-2") || null,
    CUSTOM_SLOT_SELECTION.get("col-0") || null,
    CUSTOM_SLOT_SELECTION.get("col-1") || null,
    CUSTOM_SLOT_SELECTION.get("col-2") || null
  ];
}

function canonicalizeCustomCategoryIds(ids) {
  return [...ids].map(id => String(id).trim());
}

function validateCustomGridSelection(categoryIds) {
  if (!Array.isArray(categoryIds) || categoryIds.length !== 6 || categoryIds.some(id => typeof id !== "string")) {
    return null;
  }

  const rows = categoryIds.slice(0, 3);
  const cols = categoryIds.slice(3);
  const result = {
    rows,
    cols,
    cellStates: Array.from({ length: 9 }, (_, index) => ({
      row: Math.floor(index / 3),
      col: index % 3,
      state: "ok",
      message: ""
    })),
    valid: true
  };

  for (let row = 0; row < 3; row += 1) {
    for (let col = 0; col < 3; col += 1) {
      const rowCategory = getCategoryById(rows[row]);
      const colCategory = getCategoryById(cols[col]);
      const matches = contestants.filter(contestant => (
        evaluateCategory(contestant, rowCategory) && evaluateCategory(contestant, colCategory)
      ));
      if (matches.length === 0) {
        const cellIndex = row * 3 + col;
        result.cellStates[cellIndex] = {
          row,
          col,
          state: "error",
          message: "No Valid Answers"
        };
        result.valid = false;
      }
    }
  }

  if (!result.valid) {
    return result;
  }

  const assignment = findUniqueAssignment(result.rows, result.cols);
  if (!assignment) {
    result.valid = false;
    result.cellStates = result.cellStates.map(cell => ({
      ...cell,
      state: "warning",
      message: "Needs 9 Unique"
    }));
  }

  return result;
}

function findUniqueAssignment(rows, cols) {
  const matchesByCell = Array.from({ length: 9 }, (_, index) => {
    const row = Math.floor(index / 3);
    const col = index % 3;
    const rowCategory = getCategoryById(rows[row]);
    const colCategory = getCategoryById(cols[col]);
    return contestants
      .filter(contestant => evaluateCategory(contestant, rowCategory) && evaluateCategory(contestant, colCategory))
      .map(contestant => contestant.castaway_id);
  });

  const order = matchesByCell
    .map((list, index) => ({ index, size: list.length }))
    .sort((a, b) => a.size - b.size)
    .map(item => item.index);

  const used = new Set();

  function search(position) {
    if (position >= order.length) return true;
    const cellIndex = order[position];
    for (const castawayId of matchesByCell[cellIndex]) {
      if (used.has(castawayId)) continue;
      used.add(castawayId);
      if (search(position + 1)) return true;
      used.delete(castawayId);
    }
    return false;
  }

  return search(0);
}

function clearGridValidationMarkers() {
  document.querySelectorAll("#game-grid .cell").forEach(cell => {
    cell.classList.remove("validation-error", "validation-warning");
    cell.querySelectorAll(".cell-validation-message").forEach(el => el.remove());
  });
}

function applyCustomValidationPreview(validation) {
  clearGridValidationMarkers();
  if (!validation) return;

  validation.cellStates.forEach(cellState => {
    if (cellState.state === "ok") return;
    const cellIndex = cellState.row * 3 + cellState.col;
    const cell = document.querySelectorAll("#game-grid .cell")[cellIndex];
    if (!cell) return;
    cell.classList.add(cellState.state === "error" ? "validation-error" : "validation-warning");

    const message = document.createElement("div");
    message.className = "cell-validation-message";
    message.textContent = cellState.message;
    cell.appendChild(message);
  });
}

function buildPartialCustomCellStates(selectedIds) {
  const rows = selectedIds.slice(0, 3);
  const cols = selectedIds.slice(3);
  const cellStates = Array.from({ length: 9 }, (_, index) => ({
    row: Math.floor(index / 3),
    col: index % 3,
    state: "ok",
    message: ""
  }));

  for (let row = 0; row < 3; row += 1) {
    for (let col = 0; col < 3; col += 1) {
      const rowId = rows[row];
      const colId = cols[col];
      if (!rowId || !colId) continue;
      const rowCategory = getCategoryById(rowId);
      const colCategory = getCategoryById(colId);
      const hasMatch = contestants.some(contestant => evaluateCategory(contestant, rowCategory) && evaluateCategory(contestant, colCategory));
      if (!hasMatch) {
        const cellIndex = row * 3 + col;
        cellStates[cellIndex] = { row, col, state: "error", message: "No Valid Answers" };
      }
    }
  }

  return cellStates;
}

function launchCustomPuzzle(selectedIds) {
  const validation = validateCustomGridSelection(selectedIds);
  applyCustomValidationPreview(validation);

  if (!validation?.valid) {
    showStatusToast("Fix highlighted intersections before playing.", "warning", 2800);
    return false;
  }

  const rows = validation.rows.map(getCategoryById);
  const cols = validation.cols.map(getCategoryById);
  const grid = Array.from({ length: 3 }, (_, row) => Array.from({ length: 3 }, (_, col) => {
    const rowCategory = rows[row];
    const colCategory = cols[col];
    return contestants.filter(contestant => evaluateCategory(contestant, rowCategory) && evaluateCategory(contestant, colCategory));
  }));

  CUSTOM_SELECTED_IDS = canonicalizeCustomCategoryIds(selectedIds);
  setupPuzzle({ rows, cols, grid }, "custom", { customCategories: CUSTOM_SELECTED_IDS });
  hideSetupPanels();
  showStatusToast("Custom puzzle ready. Good luck!", "info");
  return true;
}

function refreshCustomValidationState() {
  if (CURRENT_PUZZLE_MODE !== "custom-setup") return;

  const selectedIds = getCustomSelectionIds();
  const isComplete = selectedIds.every(Boolean);

  if (!isComplete) {
    CUSTOM_PENDING_SELECTION_IDS = null;
    setCustomPlayButtonEnabled(false);
    applyCustomValidationPreview({ cellStates: buildPartialCustomCellStates(selectedIds) });
    showStatusToast("Enter 3 row and 3 column categories in the grid headers.", "info", 0);
    updateCustomInputConfirmedStates();
    return;
  }

  const validation = validateCustomGridSelection(selectedIds);
  applyCustomValidationPreview(validation);

  if (validation?.valid) {
    CUSTOM_PENDING_SELECTION_IDS = canonicalizeCustomCategoryIds(selectedIds);
    setCustomPlayButtonEnabled(true);
    showStatusToast("Categories look good. Press Play Grid to begin.", "info", 0);
    updateCustomInputConfirmedStates();
    return;
  }

  CUSTOM_PENDING_SELECTION_IDS = null;
  setCustomPlayButtonEnabled(false);
  showStatusToast("Fix highlighted intersections before playing.", "warning", 0);
  updateCustomInputConfirmedStates();
}

const CATEGORY_GROUP_LABELS = {
  status: "Player Status",
  placement: "Placement",
  exit: "Exit Type",
  challenges: "Challenges",
  firemaking: "Firemaking",
  voting: "Voting",
  age: "Age",
  confessionals: "Confessionals",
  events: "Events",
  season: "Season",
  advantages: "Advantages",
  tribe_color: "Tribe Color",
  season_groupings: "Season Groupings",
};

function formatCategoryGroupLabel(group) {
  return CATEGORY_GROUP_LABELS[group] || group;
}

function updateCustomInputConfirmedStates() {
  document.querySelectorAll(".custom-grid-category-input").forEach(input => {
    const slotKey = input.dataset.customSlot;
    input.classList.toggle("is-confirmed", Boolean(CUSTOM_SLOT_SELECTION.get(slotKey)));
  });
}

function bindCustomHeaderAutocomplete(input, slotKey) {
  let dropdown = null;
  let dropdownOptions = [];
  let activeIndex = -1;
  let vpResizeHandler = null;

  function positionDropdown() {
    if (!dropdown) return;
    const rect = input.getBoundingClientRect();
    const vv = window.visualViewport;
    const viewportHeight = vv ? vv.height : window.innerHeight;
    const vvTop = vv ? vv.offsetTop : 0;
    const vvLeft = vv ? vv.offsetLeft : 0;
    const spaceBelow = viewportHeight - rect.bottom - 8;

    dropdown.style.bottom = "";
    dropdown.style.top = `${rect.bottom + vvTop + 2}px`;
    dropdown.style.left = `${rect.left + vvLeft}px`;
    dropdown.style.width = `${rect.width}px`;
    dropdown.style.maxHeight = `${Math.max(60, Math.min(280, spaceBelow))}px`;
  }

  function closeDropdown() {
    dropdown?.remove();
    dropdown = null;
    dropdownOptions = [];
    activeIndex = -1;
    if (vpResizeHandler) {
      window.visualViewport?.removeEventListener("resize", vpResizeHandler);
      window.visualViewport?.removeEventListener("scroll", vpResizeHandler);
      vpResizeHandler = null;
    }
  }

  function setActive(index) {
    dropdownOptions.forEach(el => el.classList.remove("is-active"));
    activeIndex = index;
    if (index >= 0 && index < dropdownOptions.length) {
      dropdownOptions[index].classList.add("is-active");
      dropdownOptions[index].scrollIntoView({ block: "nearest" });
    }
  }

  function selectCategory(category) {
    input.value = category.label;
    CUSTOM_SLOT_SELECTION.set(slotKey, category.id);
    closeDropdown();
    refreshCustomValidationState();
  }

  function buildOptionEl(category) {
    const option = document.createElement("div");
    option.className = "autocomplete-option";
    option.textContent = category.label;
    option.addEventListener("mousedown", event => {
      event.preventDefault();
      selectCategory(category);
    });
    return option;
  }

  function openDropdown(options, grouped = false) {
    closeDropdown();
    if (options.length === 0) return;

    dropdown = document.createElement("div");
    dropdown.className = "autocomplete-dropdown";

    if (grouped) {
      const groups = new Map();
      options.forEach(({ category }) => {
        const g = category.group || "other";
        if (!groups.has(g)) groups.set(g, []);
        groups.get(g).push(category);
      });
      groups.forEach((cats, groupKey) => {
        const groupHeader = document.createElement("div");
        groupHeader.className = "autocomplete-group-header";
        groupHeader.textContent = formatCategoryGroupLabel(groupKey);
        dropdown.appendChild(groupHeader);
        cats.forEach(category => {
          const option = buildOptionEl(category);
          dropdown.appendChild(option);
          dropdownOptions.push(option);
        });
      });
    } else {
      options.forEach(({ category }) => {
        const option = buildOptionEl(category);
        dropdown.appendChild(option);
        dropdownOptions.push(option);
      });
    }

    document.body.appendChild(dropdown);
    positionDropdown();

    vpResizeHandler = positionDropdown;
    window.visualViewport?.addEventListener("resize", vpResizeHandler);
    window.visualViewport?.addEventListener("scroll", vpResizeHandler);
  }

  function getOtherSelectedIds() {
    const ids = new Set();
    for (const [k, id] of CUSTOM_SLOT_SELECTION.entries()) {
      if (k !== slotKey) ids.add(id);
    }
    return ids;
  }

  function getAllOptions() {
    const excluded = getOtherSelectedIds();
    return getCustomCategoryOptions().filter(opt => !excluded.has(opt.category.id));
  }

  function getFilteredOptions(value) {
    const excluded = getOtherSelectedIds();
    return getCustomCategoryOptions()
      .filter(opt => !excluded.has(opt.category.id) && categoryMatchesQuery(opt, value))
      .slice(0, 30);
  }

  input.addEventListener("focus", () => {
    if (!input.value.trim()) {
      openDropdown(getAllOptions(), /* grouped= */ true);
    }
  });

  input.addEventListener("input", () => {
    CUSTOM_SLOT_SELECTION.delete(slotKey);
    const value = input.value.toLowerCase().trim();
    if (!value) {
      openDropdown(getAllOptions(), /* grouped= */ true);
    } else {
      openDropdown(getFilteredOptions(value), /* grouped= */ false);
    }
    refreshCustomValidationState();
  });

  input.addEventListener("blur", () => {
    setTimeout(() => {
      closeDropdown();
      if (!CUSTOM_SLOT_SELECTION.get(slotKey)) {
        const matched = getPublicUiEligibleCategories()
          .find(c => c.label.toLowerCase() === input.value.trim().toLowerCase());
        if (matched) CUSTOM_SLOT_SELECTION.set(slotKey, matched.id);
      }
      refreshCustomValidationState();
    }, 100);
  });

  input.addEventListener("keydown", event => {
    if (event.key === "Escape") {
      closeDropdown();
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (!dropdown) {
        openDropdown(getAllOptions(), /* grouped= */ true);
      } else {
        setActive(activeIndex + 1 >= dropdownOptions.length ? 0 : activeIndex + 1);
      }
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      if (dropdown) {
        setActive(activeIndex - 1 < 0 ? dropdownOptions.length - 1 : activeIndex - 1);
      }
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      if (dropdown && activeIndex >= 0) {
        dropdownOptions[activeIndex].dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
        return;
      }
      if (CUSTOM_PENDING_SELECTION_IDS) {
        launchCustomPuzzle(CUSTOM_PENDING_SELECTION_IDS);
      }
    }
  });
}

function renderCustomSetupGrid() {
  CURRENT_PUZZLE = null;
  CURRENT_PUZZLE_MODE = "custom-setup";
  CURRENT_PUZZLE_SEED = null;
  CUSTOM_SELECTED_IDS = [];
  CUSTOM_SLOT_SELECTION = new Map();
  CUSTOM_PENDING_SELECTION_IDS = null;

  hideSetupPanels();
  setCustomPlayControlsVisible(true);
  setCustomPlayButtonEnabled(false);
  resetGridInputs();
  clearGridValidationMarkers();
  document.getElementById("game-grid").style.display = "grid";
  document.getElementById("share-view").style.display = "none";
  clearShareCopyFeedback();
  guessesDiv.textContent = "Custom Puzzle Setup";

  const rowHeaderEls = Array.from(document.querySelectorAll("#game-grid .header.row"));
  const colHeaderEls = Array.from(document.querySelectorAll("#game-grid .header.col"));

  rowHeaderEls.forEach((el, i) => {
    el.innerHTML = "";
    el.classList.add("has-custom-input");
    const input = document.createElement("input");
    input.type = "text";
    input.className = "custom-grid-category-input";
    input.placeholder = `Row Category ${i + 1}`;
    input.dataset.customSlot = `row-${i}`;
    el.appendChild(input);
    bindCustomHeaderAutocomplete(input, `row-${i}`);
  });

  colHeaderEls.forEach((el, i) => {
    el.innerHTML = "";
    el.classList.add("has-custom-input");
    const input = document.createElement("input");
    input.type = "text";
    input.className = "custom-grid-category-input";
    input.placeholder = `Column Category ${i + 1}`;
    input.dataset.customSlot = `col-${i}`;
    el.appendChild(input);
    bindCustomHeaderAutocomplete(input, `col-${i}`);
  });

  updateGridInputAccessibilityLabels();

  document.querySelectorAll("#game-grid .cell input").forEach(input => {
    input.style.display = "none";
    input.value = "";
    input.disabled = true;
  });

  updatePuzzleDateLabel();
  updateDailyProgressNote();
  showStatusToast("Enter 3 row and 3 column categories in the grid headers.", "info", 0);
  refreshCustomValidationState();
}

function initCustomModeUi() {
  // Custom setup now happens directly in the grid headers.
}

function validateWiredInput(input) {
  if (!input.value.trim()) return;
  if (input.classList.contains("locked")) return;

  const row = Number(input.dataset.row);
  const col = Number(input.dataset.col);

  const { valid, match } = validateInput(
    input,
    rowHeaders[row],
    colHeaders[col]
  );

  // Only consume a guess if there was a valid contestant selection
  if (!match) return;

  recordPuzzleGuessAttempt({
    row,
    col,
    contestant: match,
    outcome: valid ? "correct" : "incorrect"
  });

  trackPuzzleStarted();
  trackFirstGuess({
    row,
    col,
    guessOutcome: valid ? "correct" : "incorrect"
  });

  useGuess();
}

// ------------------------------------------------------------
// Name helpers
// ------------------------------------------------------------
function buildMergedLabel(c) {
  const display = c.display_name?.[0] || "";
  const full = c.name || "";

  const d = display.trim();
  const f = full.trim();

  if (!d) return f;

  const lowerF = f.toLowerCase();
  const lowerD = d.toLowerCase();

  if (lowerF.includes(lowerD)) {
    const matchIndex = lowerF.indexOf(lowerD);
    return {
      prefix: f.slice(0, matchIndex),
      highlight: f.slice(matchIndex, matchIndex + d.length),
      suffix: f.slice(matchIndex + d.length)
    };
  }

  const tokens = f.split(" ");
  if (tokens.length === 1) {
    return {
      prefix: "",
      highlight: d,
      suffix: ""
    };
  }

  const quotedDisplay = `"${d}"`;

  return {
    prefix: `${tokens[0]} `,
    highlight: quotedDisplay,
    suffix: ` ${tokens.slice(1).join(" ")}`
  };
}

function getSearchLabel(c) {
  const display = c.display_name?.[0]?.trim() || "";
  const full = c.name?.trim() || "";

  if (!display) return full;
  if (!full) return display;
  if (full.toLowerCase().includes(display.toLowerCase())) return full;

  const tokens = full.split(" ");
  if (tokens.length === 1) return `${display} ${full}`.trim();

  return [tokens[0], `"${display}"`, ...tokens.slice(1)].join(" ");
}

function getCanonicalName(c) {
  const display = c.display_name?.[0];
  const full = c.name;

  if (!full) return display || "";
  if (display && display.toLowerCase() !== full.toLowerCase()) return display;
  return full;
}

// ------------------------------------------------------------
// Validation helpers (visual + logic)
// ------------------------------------------------------------

// Normalize name for comparison (future‑proof if you add alias logic)
function normalizeName(name) {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

// Apply visual state using CSS classes (no inline colors)
function applyGuessState(input, state) {
  input.classList.remove("correct", "incorrect", "locked");
  input.dataset.state = state || "";

  if (state === "correct") {
    input.classList.add("locked", "correct");
    input.disabled = true;
  } else if (state === "incorrect") {
    input.classList.add("locked", "incorrect");
  }
}

// ------------------------------------------------------------
// Validation
// ------------------------------------------------------------
function validateInput(input, rowCategoryId, colCategoryId) {
  const match = inputSelection.get(input);

  // No autocomplete selection → invalid, do not consume a guess
  if (!match) {
    applyGuessState(input, "invalid");
    showStatusToast("Select a contestant from suggestions.", "warning");
    return { valid: false, match: null };
  }

  const identity = match.castaway_id;

  // Already used in another cell → incorrect
  if (usedContestants.has(identity)) {
    applyGuessState(input, "incorrect");
    return { valid: false, match };
  }

  const rowCategory = getCategoryById(rowCategoryId);
  const colCategory = getCategoryById(colCategoryId);

  const rowMatch = rowCategory ? evaluateCategory(match, rowCategory) : false;
  const colMatch = colCategory ? evaluateCategory(match, colCategory) : false;

  const valid = rowMatch && colMatch;

  if (valid) {
    applyGuessState(input, "correct");
    usedContestants.add(identity);
    incorrectGuessCache.delete(input);
    const correctRow = Number(input.dataset.row);
    const correctCol = Number(input.dataset.col);
    const correctCell = input.closest(".cell");
    if (correctCell && Number.isInteger(correctRow) && Number.isInteger(correctCol)) {
      renderCorrectCellHeadshot(correctCell, input, match, correctRow, correctCol);
    } else {
      renderLiveRarityForInput(input);
    }
  } else {
    applyGuessState(input, "incorrect");
    incorrectGuessCache.set(input, {
      value: input.value,
      contestant: match
    });
    input.closest(".cell")?.querySelector(".cell-live-rarity")?.remove();
  }

  return { valid, match };
}

// ------------------------------------------------------------
// Guess counter
// ------------------------------------------------------------
let guessesRemaining = 9;
const guessesDiv = document.getElementById("guesses");
const statusToast = document.getElementById("status-toast");
const dailyProgressNote = document.getElementById("daily-progress-note");
const puzzleDateLabel = document.getElementById("puzzle-date-label");
const customPlayContainer = document.getElementById("custom-play-container");
const customPlayButton = document.getElementById("custom-play-btn");
let statusToastTimer;

function setCustomPlayControlsVisible(visible) {
  if (!customPlayContainer) return;
  customPlayContainer.style.display = visible ? "flex" : "none";
}

function setCustomPlayButtonEnabled(enabled) {
  if (!customPlayButton) return;
  customPlayButton.disabled = !enabled;
}

function getTodayDailyPuzzleKey(date = new Date()) {
  return getDailyPuzzleKey(date);
}

function parseDailyPuzzleKeyFromPath(pathname = window.location.pathname) {
  if (typeof pathname !== "string") return null;

  const match = pathname.match(/(?:^|\/)daily\/(\d{4}-\d{2}-\d{2})\/?$/);
  return match?.[1] || null;
}

function updatePuzzleDateLabel() {
  if (!puzzleDateLabel) return;

  if (CURRENT_PUZZLE_MODE === "daily") {
    puzzleDateLabel.textContent = `Daily Puzzle — ${formatDateFromPuzzleKey(DAILY_PUZZLE_KEY)}`;
    return;
  }

  puzzleDateLabel.textContent = "";
}

function refreshDailyPuzzleIfDateChanged() {
  if (CURRENT_PUZZLE_MODE !== "daily") return;

  const latestDailyKey = getTodayDailyPuzzleKey();
  if (!latestDailyKey || latestDailyKey === DAILY_PUZZLE_KEY) return;

  DAILY_PUZZLE_KEY = latestDailyKey;

  try {
    const puzzle = resolveDailyPuzzleForKey(DAILY_PUZZLE_KEY);
    setupPuzzle(puzzle, "daily", { dailyDateKey: DAILY_PUZZLE_KEY });
    savePuzzleCache();
    updateDailyProgressNote();
    showStatusToast("Loaded the new daily puzzle.", "info", 2800);
  } catch (error) {
    console.error("[grid] Failed to refresh daily puzzle after date change.", error);
    showPuzzleGenerationError("Could not automatically load the new daily puzzle. Please try again.");
  }
}

function startDailyPuzzleRolloverWatcher() {
  if (dailyPuzzleRolloverTimer != null) {
    window.clearInterval(dailyPuzzleRolloverTimer);
  }

  dailyPuzzleRolloverTimer = window.setInterval(() => {
    refreshDailyPuzzleIfDateChanged();
  }, 60 * 1000);
}

function getActivePuzzleCacheKey() {
  if (CURRENT_PUZZLE_MODE === "daily") {
    return DAILY_PUZZLE_KEY ? `daily:${DAILY_PUZZLE_KEY}` : null;
  }

  if (CURRENT_PUZZLE_MODE === "random" && Number.isInteger(CURRENT_PUZZLE_SEED)) {
    return `random:${CURRENT_PUZZLE_SEED}`;
  }

  if (CURRENT_PUZZLE_MODE === "custom" && Array.isArray(CUSTOM_SELECTED_IDS) && CUSTOM_SELECTED_IDS.length === 6) {
    return `custom:${CUSTOM_SELECTED_IDS.join(",")}`;
  }

  return null;
}

function getPuzzleCacheSnapshot() {
  const inputs = Array.from(document.querySelectorAll(".grid .cell input"));
  const cells = inputs.map(input => {
    const match = inputSelection.get(input);
    return {
      value: input.value,
      state: input.dataset.state || "",
      selectedCastawayId: match?.castaway_id ?? null
    };
  });

  return {
    puzzleCacheKey: getActivePuzzleCacheKey(),
    guessesRemaining,
    usedContestantIds: Array.from(usedContestants),
    cells
  };
}

function savePuzzleCache() {
  const puzzleCacheKey = getActivePuzzleCacheKey();
  if (!puzzleCacheKey) return;

  const snapshot = getPuzzleCacheSnapshot();
  if (snapshot.puzzleCacheKey !== puzzleCacheKey) {
    snapshot.puzzleCacheKey = puzzleCacheKey;
  }

  localStorage.setItem(PUZZLE_CACHE_STORAGE_KEY, JSON.stringify(snapshot));
}

function loadPuzzleCache() {
  const puzzleCacheKey = getActivePuzzleCacheKey();
  if (!puzzleCacheKey) return null;

  const raw = localStorage.getItem(PUZZLE_CACHE_STORAGE_KEY);
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw);
    if (parsed?.puzzleCacheKey !== puzzleCacheKey) return null;
    if (!Array.isArray(parsed.cells) || parsed.cells.length !== 9) return null;
    return parsed;
  } catch (error) {
    console.warn("[grid] Ignoring invalid puzzle cache payload.", error);
    return null;
  }
}

function updateDailyProgressNote() {
  if (!dailyProgressNote) return;
  if (CURRENT_PUZZLE_MODE !== "daily") {
    dailyProgressNote.textContent = "";
    return;
  }

  const cache = loadPuzzleCache();
  if (!cache) {
    dailyProgressNote.textContent = "";
    return;
  }

  if (cache.guessesRemaining <= 0) {
    dailyProgressNote.textContent = "Daily puzzle already completed";
    return;
  }

  if (cache.guessesRemaining < 9) {
    dailyProgressNote.textContent = "Daily puzzle already in progress";
    return;
  }

  dailyProgressNote.textContent = "";
}

function sanitizeStringList(value) {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value.filter(item => typeof item === "string" && item.trim() !== "").map(item => item.trim())));
}

function loadRandomSettings() {
  const raw = localStorage.getItem(RANDOM_SETTINGS_STORAGE_KEY);
  if (!raw) {
    return { ...DEFAULT_RANDOM_SETTINGS };
  }

  try {
    const parsed = JSON.parse(raw);
    const selectedDifficultiesRaw = sanitizeStringList(parsed?.selectedDifficulties)
      .filter(level => VALID_DIFFICULTY_LEVELS.has(level));

    let selectedDifficulties = selectedDifficultiesRaw;
    if (selectedDifficulties.length === 0 && VALID_DIFFICULTY_LEVELS.has(parsed?.preferredDifficulty)) {
      selectedDifficulties = [parsed.preferredDifficulty];
    }
    if (selectedDifficulties.length === 0) {
      selectedDifficulties = [...DEFAULT_RANDOM_SETTINGS.selectedDifficulties];
    }

    return {
      ...DEFAULT_RANDOM_SETTINGS,
      excludedCategoryIds: sanitizeStringList(parsed?.excludedCategoryIds),
      excludedCategoryTypes: sanitizeStringList(parsed?.excludedCategoryTypes),
      watchedSeasons: sanitizeStringList(parsed?.watchedSeasons),
      allowNonUSOnlyIntersections: Boolean(parsed?.allowNonUSOnlyIntersections),
      selectedDifficulties
    };
  } catch (error) {
    console.warn("[grid] Invalid random settings payload ignored.", error);
    return { ...DEFAULT_RANDOM_SETTINGS };
  }
}

function saveRandomSettings() {
  localStorage.setItem(RANDOM_SETTINGS_STORAGE_KEY, JSON.stringify(RANDOM_SETTINGS));
}

function getRandomPuzzleCategories() {
  const excludedIds = new Set(RANDOM_SETTINGS.excludedCategoryIds);
  const excludedTypes = new Set(RANDOM_SETTINGS.excludedCategoryTypes);

  return getPublicUiEligibleCategories().filter(category => {
    const displayType = getRandomSettingsDisplayType(category);
    return !excludedIds.has(category.id)
      && !excludedTypes.has(category.type)
      && !excludedTypes.has(displayType);
  });
}

function ensureRandomCategoryPool(categories) {
  if (categories.length < 6) {
    throw new Error("Not enough categories remain after exclusions. Include more categories to generate random puzzles.");
  }
}

function generateRandomPuzzleForMode(seed, options = {}) {
  const categories = getRandomPuzzleCategories();
  ensureRandomCategoryPool(categories);
  const selectedDifficulties = Array.isArray(RANDOM_SETTINGS.selectedDifficulties)
    ? RANDOM_SETTINGS.selectedDifficulties.filter(level => VALID_DIFFICULTY_LEVELS.has(level))
    : [];
  const effectiveDifficulties = selectedDifficulties.length > 0
    ? selectedDifficulties
    : [...VALID_DIFFICULTY_LEVELS];
  const allowedPointRanges = effectiveDifficulties.map(level => DIFFICULTY_POINT_RANGES[level]);
  const generationOptions = {
    ...options,
    allowedPointRanges
  };

  if (Number.isInteger(seed)) {
    return generateSeededPuzzle(categories, contestants, seed, generationOptions);
  }

  return generateRandomPuzzle(categories, contestants, generationOptions);
}

function getDailyFallbackEligibleCategories() {
  const dailyDateParts = getDailyPuzzleDateParts(new Date());
  const weekday = new Date(Date.UTC(dailyDateParts.year, dailyDateParts.month - 1, dailyDateParts.day)).getUTCDay();
  return getPublicUiEligibleCategories().filter(category => (
    !DAILY_EXCLUDED_CATEGORY_TYPES.has(category.type)
    && !DAILY_EXCLUDED_CATEGORY_IDS.has(category.id)
    && (!DAILY_WEDNESDAY_ONLY_CATEGORY_IDS.has(category.id) || weekday === 3)
  ));
}

function generateDailyFallbackPuzzle(seed) {
  const categories = getDailyFallbackEligibleCategories();
  ensureRandomCategoryPool(categories);

  if (Number.isInteger(seed)) {
    return generateSeededPuzzle(categories, contestants, seed, {
      minPerCell: 3,
      usOnly: true
    });
  }

  return generateRandomPuzzle(categories, contestants, {
    minPerCell: 3,
    usOnly: true
  });
}

function renderRandomSettingsCheckboxList(container, options, selectedValues) {
  if (!container) return;
  container.innerHTML = "";

  const selectedSet = new Set(selectedValues);

  options.forEach(option => {
    const label = document.createElement("label");
    label.className = "settings-checkbox-item";

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.value = option.value;
    checkbox.checked = selectedSet.has(option.value);

    const text = document.createElement("span");
    text.textContent = option.label;

    label.append(checkbox, text);
    container.append(label);
  });
}

function getRandomSettingsDisplayType(category) {
  if (RANDOM_SETTINGS_CATEGORY_TYPE_OVERRIDES[category.id]) {
    return RANDOM_SETTINGS_CATEGORY_TYPE_OVERRIDES[category.id];
  }

  if (category.type === "boolean_flag") {
    return "returning_states";
  }

  if (category.type === "season_list_empty") {
    return "placement_equals";
  }

  if (category.type === "season_list_not_covering_all_seasons") {
    return "placement_equals";
  }

  if (category.type === "season_list_nonempty") {
    return "placement_equals";
  }

  if (category.type === "votes_against_count") {
    return "player_voting";
  }

  if (category.type === "age_bracket") {
    return "age";
  }

  return category.type;
}

function getRandomSettingsTypeSortIndex(type) {
  const index = RANDOM_SETTINGS_TYPE_ORDER.indexOf(type);
  return index >= 0 ? index : RANDOM_SETTINGS_TYPE_ORDER.length;
}

function getRandomSettingsTypeLabel(type) {
  return RANDOM_SETTINGS_TYPE_LABELS[type] || type;
}

function renderRandomSettingsPanel() {
  const difficultyContainer = document.getElementById("random-difficulty-filters");
  const typeContainer = document.getElementById("random-type-filters");
  const categoryContainer = document.getElementById("random-category-filters");

  renderRandomSettingsCheckboxList(
    difficultyContainer,
    [
      { value: "easy", label: "Easy" },
      { value: "medium", label: "Medium" },
      { value: "hard", label: "Hard" }
    ],
    RANDOM_SETTINGS.selectedDifficulties
  );

  const publicUiEligibleCategories = getPublicUiEligibleCategories();

  const types = Array.from(new Set(publicUiEligibleCategories.map(category => getRandomSettingsDisplayType(category))))
    .sort((a, b) => {
      const sortA = getRandomSettingsTypeSortIndex(a);
      const sortB = getRandomSettingsTypeSortIndex(b);
      if (sortA !== sortB) return sortA - sortB;
      return getRandomSettingsTypeLabel(a)
        .localeCompare(getRandomSettingsTypeLabel(b));
    });

  const categories = [...publicUiEligibleCategories]
    .sort((a, b) => {
      const displayTypeA = getRandomSettingsDisplayType(a);
      const displayTypeB = getRandomSettingsDisplayType(b);

      const sortA = getRandomSettingsTypeSortIndex(displayTypeA);
      const sortB = getRandomSettingsTypeSortIndex(displayTypeB);
      if (sortA !== sortB) return sortA - sortB;

      const typeLabelSort = getRandomSettingsTypeLabel(displayTypeA)
        .localeCompare(getRandomSettingsTypeLabel(displayTypeB));
      if (typeLabelSort !== 0) return typeLabelSort;

      return a.label.localeCompare(b.label);
    });

  renderRandomSettingsCheckboxList(
    typeContainer,
    types.map(type => ({ value: type, label: getRandomSettingsTypeLabel(type) })),
    RANDOM_SETTINGS.excludedCategoryTypes
  );

  renderRandomSettingsCheckboxList(
    categoryContainer,
    categories.map(category => {
      const displayType = getRandomSettingsDisplayType(category);
      return {
        value: category.id,
        label: `${getRandomSettingsTypeLabel(displayType)} — ${category.label}`
      };
    }),
    RANDOM_SETTINGS.excludedCategoryIds
  );
}

function collectCheckedValues(containerId) {
  const container = document.getElementById(containerId);
  if (!container) return [];

  return Array.from(container.querySelectorAll('input[type="checkbox"]:checked'))
    .map(checkbox => checkbox.value);
}

function setRandomSettingsPanelVisible(visible) {
  const panel = document.getElementById("random-settings-panel");
  const button = document.getElementById("random-settings-btn");
  if (!panel || !button) return;

  panel.hidden = !visible;
  button.setAttribute("aria-expanded", visible ? "true" : "false");
}

function hideSetupPanels() {
  setRandomSettingsPanelVisible(false);
  setCustomPlayControlsVisible(false);
  hideStatusToast();
}

function applyRandomSettingsFromPanel() {
  const selectedDifficulties = collectCheckedValues("random-difficulty-filters")
    .filter(level => VALID_DIFFICULTY_LEVELS.has(level));

  const effectiveDifficulties = selectedDifficulties.length > 0
    ? ["easy", "medium", "hard"].filter(level => selectedDifficulties.includes(level))
    : ["easy", "medium", "hard"];

  RANDOM_SETTINGS = {
    ...RANDOM_SETTINGS,
    selectedDifficulties: effectiveDifficulties,
    excludedCategoryTypes: collectCheckedValues("random-type-filters"),
    excludedCategoryIds: collectCheckedValues("random-category-filters")
  };
  saveRandomSettings();
}

function initRandomSettingsUi() {
  const openButton = document.getElementById("random-settings-btn");
  const closeButton = document.getElementById("random-settings-close-btn");
  const saveButton = document.getElementById("random-settings-save-btn");

  if (!openButton) return;

  renderRandomSettingsPanel();

  openButton.addEventListener("click", () => {
    const currentlyExpanded = openButton.getAttribute("aria-expanded") === "true";
    if (!currentlyExpanded) {
      renderRandomSettingsPanel();
    }
      setRandomSettingsPanelVisible(!currentlyExpanded);
  });

  closeButton?.addEventListener("click", () => {
    setRandomSettingsPanelVisible(false);
  });

  saveButton?.addEventListener("click", () => {
    try {
      applyRandomSettingsFromPanel();
      setRandomSettingsPanelVisible(false);
      const seed = createPuzzleSeed();
      const puzzle = generateRandomPuzzleForMode(seed);
      setupPuzzle(puzzle, "random", { seed });
      updateDailyProgressNote();
      showStatusToast("Random settings saved.", "info");
    } catch (error) {
      console.error("[grid] Failed to apply random settings.", error);
      showStatusToast(error.message || "Could not apply random settings.", "error", 3200);
    }
  });
}

function restorePuzzleCache(cache) {
  const inputs = Array.from(document.querySelectorAll(".grid .cell input"));
  const contestantsById = new Map(contestants.map(c => [c.castaway_id, c]));
  const rowCategories = rowHeaders.map(id => getCategoryById(id));
  const colCategories = colHeaders.map(id => getCategoryById(id));
  const usedIds = new Set(cache.usedContestantIds ?? []);

  // Re-evaluate previously incorrect guesses against the latest category logic.
  // This keeps in-progress daily grids consistent after category bug fixes.
  cache.cells.forEach((cell, index) => {
    if (!cell || cell.state !== "incorrect" || !cell.selectedCastawayId) return;

    const contestant = contestantsById.get(cell.selectedCastawayId);
    if (!contestant) return;

    const row = Math.floor(index / 3);
    const col = index % 3;
    const rowCategory = rowCategories[row];
    const colCategory = colCategories[col];

    if (!rowCategory || !colCategory) return;

    const nowValid = evaluateCategory(contestant, rowCategory)
      && evaluateCategory(contestant, colCategory)
      && !usedIds.has(contestant.castaway_id);

    if (nowValid) {
      cell.state = "correct";
      usedIds.add(contestant.castaway_id);
    }
  });

  cache.usedContestantIds = Array.from(usedIds);
  usedContestants = new Set(cache.usedContestantIds);
  guessesRemaining = Number.isInteger(cache.guessesRemaining)
    ? Math.max(0, Math.min(9, cache.guessesRemaining))
    : 9;
  guessesDiv.textContent = `Guesses Remaining: ${guessesRemaining}`;

  inputs.forEach((input, index) => {
    const cell = cache.cells[index];
    if (!cell) return;
    const contestant = contestantsById.get(cell.selectedCastawayId);

    input.value = typeof cell.value === "string" ? cell.value : "";
    input.dataset.state = cell.state || "";
    input.classList.remove("locked", "correct", "incorrect");
    if (contestant) {
      inputSelection.set(input, contestant);
    }

    if (cell.state === "correct") {
      input.classList.add("locked", "correct");
      input.disabled = true;
      const restoredRow = Number(input.dataset.row);
      const restoredCol = Number(input.dataset.col);
      const restoredCell = input.closest(".cell");
      if (restoredCell && contestant && Number.isInteger(restoredRow) && Number.isInteger(restoredCol)) {
        renderCorrectCellHeadshot(restoredCell, input, contestant, restoredRow, restoredCol);
      } else {
        renderLiveRarityForInput(input);
      }
    } else if (cell.state === "incorrect") {
      input.classList.add("locked", "incorrect");
      if (contestant) {
        incorrectGuessCache.set(input, {
          value: input.value,
          contestant
        });
      }
    }
  });

  if (guessesRemaining <= 0) {
    document.querySelectorAll(".grid .cell input").forEach(i => (i.disabled = true));
    finalizeCompletedGrid({ trigger: "cache_restore_completed" });
  }

  savePuzzleCache();
}

function showStatusToast(message, tone = "info", durationMs = 2200) {
  if (!statusToast) return;

  statusToast.textContent = message;
  statusToast.dataset.tone = tone;
  statusToast.dataset.visible = "true";

  if (statusToastTimer) clearTimeout(statusToastTimer);

  if (durationMs <= 0) {
    return;
  }

  statusToastTimer = setTimeout(() => {
    statusToast.dataset.visible = "false";
    statusToast.textContent = "";
  }, durationMs);
}

function hideStatusToast() {
  if (!statusToast) return;

  if (statusToastTimer) {
    clearTimeout(statusToastTimer);
    statusToastTimer = null;
  }

  statusToast.dataset.visible = "false";
  statusToast.textContent = "";
}

function showPuzzleGenerationError(message) {
  console.error(`[grid] ${message}`);
  guessesDiv.textContent = message;
}

function finalizeCompletedGrid({ trigger = "grid_locked_postgame" } = {}) {
  if (!CURRENT_PUZZLE || guessesRemaining > 0) return;

  trackPuzzleCompleted({
    trigger,
    mode: CURRENT_PUZZLE_MODE,
    guessesUsed: 9 - guessesRemaining,
    guessesRemaining,
    totalCorrect: Array.from(document.querySelectorAll("#game-grid .cell input")).filter(input => input.dataset.state === "correct").length,
    gridSetup: {
      rows: [...rowHeaders],
      cols: [...colHeaders]
    },
    guessAttempts: [...puzzleGuessAttempts],
    finalCells: buildPuzzleCompletionCellSummary()
  });

  showShareView();
}

function resetGuessCounter() {
  guessesRemaining = 9;
  guessesDiv.textContent = `Guesses Remaining: ${guessesRemaining}`;
}

function useGuess() {
  if (guessesRemaining <= 0) return;

  guessesRemaining--;
  guessesDiv.textContent = `Guesses Remaining: ${guessesRemaining}`;

  if (guessesRemaining <= 0) {
    document.querySelectorAll(".grid .cell input").forEach(i => (i.disabled = true));
    finalizeCompletedGrid({ trigger: "guess_limit_reached" });
  }

  savePuzzleCache();
  updateDailyProgressNote();
}

// ------------------------------------------------------------
// URL + seed helpers
// ------------------------------------------------------------
function parsePuzzleSeed(rawSeed) {
  if (typeof rawSeed !== "string") return null;

  const value = rawSeed.trim();
  if (!value || !/^[0-9a-z]+$/i.test(value)) return null;

  const parsed = /^\d+$/.test(value)
    ? Number.parseInt(value, 10)
    : Number.parseInt(value, 36);

  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    return null;
  }

  return parsed >>> 0;
}

function buildPuzzleUrl(mode = CURRENT_PUZZLE_MODE, seed = CURRENT_PUZZLE_SEED, customCategories = CUSTOM_SELECTED_IDS, dailyDateKey = DAILY_PUZZLE_KEY) {
  return buildPuzzleUrlFromHref(window.location.href, {
    mode,
    seed,
    customCategories,
    schemaVersion: PUZZLE_SCHEMA_VERSION,
    dailyDateKey
  });
}

function updatePuzzleUrl(mode = CURRENT_PUZZLE_MODE, seed = CURRENT_PUZZLE_SEED, customCategories = CUSTOM_SELECTED_IDS, dailyDateKey = DAILY_PUZZLE_KEY) {
  const canonicalUrl = buildPuzzleUrl(mode, seed, customCategories, dailyDateKey);
  history.replaceState({ mode, seed, customCategories }, "", canonicalUrl);
  return canonicalUrl;
}

function createPuzzleSeed() {
  if (window.crypto?.getRandomValues) {
    const values = new Uint32Array(1);
    window.crypto.getRandomValues(values);
    return values[0];
  }
  return Math.floor(Math.random() * 0x100000000);
}

function getInitialPuzzleFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const mode = params.get("mode");
  const pathDateKey = parseDailyPuzzleKeyFromPath();

  if (pathDateKey) {
    return {
      stageName: "daily-path",
      mode: "daily",
      seed: null,
      dailyDateKey: pathDateKey,
      requireNotFoundOnFailure: true,
      run: () => resolveDailyPuzzleForKey(pathDateKey)
    };
  }

  if (mode === "daily") {
    const dateKey = params.get("date");
    const resolvedDateKey = typeof dateKey === "string" && /^\d{4}-\d{2}-\d{2}$/.test(dateKey)
      ? dateKey
      : getTodayDailyPuzzleKey();

    return {
      stageName: "daily-url",
      mode: "daily",
      seed: null,
      dailyDateKey: resolvedDateKey,
      requireNotFoundOnFailure: typeof dateKey === "string",
      run: () => resolveDailyPuzzleForKey(resolvedDateKey)
    };
  }

  if (mode === "random") {
    const seed = parsePuzzleSeed(params.get("seed"));
    const version = params.get("v");
    const hasCompatibleVersion = version === null || version === PUZZLE_SCHEMA_VERSION;

    if (seed !== null && hasCompatibleVersion) {
      return {
        stageName: "random-seeded-url",
        mode: "random",
        seed,
        run: () => resolveScheduledPuzzleBySeed(seed) || generateRandomPuzzleForMode(seed)
      };
    }
  }

  if (mode === "custom") {
    const version = params.get("v");
    const categoryIds = (params.get("cats") || "")
      .split(",")
      .map(value => value.trim())
      .filter(Boolean);

    if (version === PUZZLE_SCHEMA_VERSION && categoryIds.length === 6) {
      const categories = categoryIds.map(getCategoryById);
      if (categories.every(Boolean)) {
        const rows = categories.slice(0, 3);
        const cols = categories.slice(3);
        const validation = validateCustomGridSelection(categoryIds);
        if (validation?.valid) {
          return {
            stageName: "custom-url",
            mode: "custom",
            seed: null,
            customCategories: canonicalizeCustomCategoryIds(categoryIds),
            run: () => ({
              rows,
              cols,
              grid: Array.from({ length: 3 }, (_, row) => Array.from({ length: 3 }, (_, col) => {
                const rowCategory = rows[row];
                const colCategory = cols[col];
                return contestants.filter(contestant => evaluateCategory(contestant, rowCategory) && evaluateCategory(contestant, colCategory));
              }))
            })
          };
        }
      }
    }
  }

  return null;
}

function redirectToNotFoundPage() {
  const currentUrl = new URL(window.location.href);
  if (currentUrl.pathname.endsWith("/404.html") || currentUrl.pathname === "/404.html") return;

  const strippedDailyPath = currentUrl.pathname.replace(/\/daily\/\d{4}-\d{2}-\d{2}\/?$/, "/");
  const basePath = strippedDailyPath.endsWith("/") ? strippedDailyPath : `${strippedDailyPath}/`;
  currentUrl.pathname = `${basePath}404.html`;
  currentUrl.search = "";
  currentUrl.hash = "";
  window.location.replace(currentUrl.toString());
}

// ------------------------------------------------------------
// Puzzle setup
// ------------------------------------------------------------
function getCategoryInfoText(category) {
  if (!category || typeof category !== "object") return "";

  if (typeof category.tooltip === "string" && category.tooltip.trim() !== "") {
    return category.tooltip;
  }

  if (category.type === "season_group_played" && typeof category.label === "string") {
    if (category.label.startsWith("Format:")) {
      const seasons = Array.isArray(category?.params?.seasons) ? category.params.seasons : [];
      if (seasons.length > 0) {
        return `Played on one of these seasons: ${seasons.join(", ")}`;
      }
    }
  }

  return CATEGORY_INFO_BY_TYPE[category.type] || "";
}

function removeCategoryInfoPopover() {
  activeCategoryInfoPopover?.remove();
  activeCategoryInfoPopover = null;
  activeCategoryInfoButton = null;
}

function showCategoryInfoPopover(anchorButton, infoText) {
  if (!anchorButton || !infoText) return;

  removeCategoryInfoPopover();

  const popover = document.createElement("div");
  popover.className = "category-info-popover";
  popover.setAttribute("role", "dialog");
  popover.textContent = infoText;
  document.body.appendChild(popover);

  const rect = anchorButton.getBoundingClientRect();
  const popRect = popover.getBoundingClientRect();

  let top = rect.bottom + 8;
  let left = rect.left + (rect.width / 2) - (popRect.width / 2);

  const viewportPadding = 8;
  left = Math.max(viewportPadding, Math.min(left, window.innerWidth - popRect.width - viewportPadding));

  if (top + popRect.height > window.innerHeight - viewportPadding) {
    top = Math.max(viewportPadding, rect.top - popRect.height - 8);
  }

  popover.style.top = `${top}px`;
  popover.style.left = `${left}px`;

  activeCategoryInfoPopover = popover;
  activeCategoryInfoButton = anchorButton;
}

function applyCondensedClassOnOverflow(element) {
  if (!element) return;

  element.classList.remove("is-condensed", "is-extra-condensed", "is-break-anywhere");

  const hasOverflow = () => (
    element.scrollWidth > element.clientWidth ||
    element.scrollHeight > element.clientHeight
  );

  if (!hasOverflow()) return;
  element.classList.add("is-condensed");

  if (!hasOverflow()) return;
  element.classList.add("is-extra-condensed");

  if (!hasOverflow()) return;
  element.classList.add("is-break-anywhere");
}

function updateGridInputAccessibilityLabels() {
  const inputs = Array.from(document.querySelectorAll("#game-grid .cell input"));
  const rowHeaderEls = Array.from(document.querySelectorAll("#game-grid .header.row"));
  const colHeaderEls = Array.from(document.querySelectorAll("#game-grid .header.col"));

  const sanitizeHeaderText = text => (text || "").replace(/\s+/g, " ").trim();

  inputs.forEach((input, index) => {
    const row = Math.floor(index / 3);
    const col = index % 3;

    const rowHeaderId = `grid-row-header-${row}`;
    const colHeaderId = `grid-col-header-${col}`;

    const rowHeaderEl = rowHeaderEls[row];
    const colHeaderEl = colHeaderEls[col];

    if (rowHeaderEl) {
      rowHeaderEl.id = rowHeaderId;
    }

    if (colHeaderEl) {
      colHeaderEl.id = colHeaderId;
    }

    const rowLabel = sanitizeHeaderText(rowHeaderEl?.textContent) || `Row ${row + 1}`;
    const colLabel = sanitizeHeaderText(colHeaderEl?.textContent) || `Column ${col + 1}`;

    input.setAttribute("aria-labelledby", `${rowHeaderId} ${colHeaderId}`);
    input.setAttribute("aria-label", `${rowLabel} and ${colLabel}`);
  });
}

function renderCategoryHeaderWithInfo(headerEl, category) {
  if (!headerEl || !category) return;

  headerEl.classList.remove("has-custom-input");
  const infoText = getCategoryInfoText(category);
  headerEl.dataset.categoryId = category.id;
  headerEl.textContent = "";

  const content = document.createElement("div");
  content.className = "category-header-content";

  const label = document.createElement("span");
  label.className = "category-header-label";
  label.textContent = category.label;
  content.appendChild(label);

  if (infoText) {
    const infoButton = document.createElement("button");
    infoButton.type = "button";
    infoButton.className = "category-info-button";
    infoButton.textContent = "i";
    infoButton.setAttribute("aria-label", `Show clue info for ${category.label}`);

    infoButton.addEventListener("click", event => {
      event.stopPropagation();
      if (activeCategoryInfoPopover && activeCategoryInfoButton === infoButton) {
        removeCategoryInfoPopover();
        return;
      }

      showCategoryInfoPopover(infoButton, infoText);
    });

    content.appendChild(infoButton);
  }

  headerEl.appendChild(content);
  requestAnimationFrame(() => applyCondensedClassOnOverflow(label));
}

document.addEventListener("click", event => {
  if (!activeCategoryInfoPopover) return;
  if (event.target.closest(".category-info-button, .category-info-popover")) return;
  removeCategoryInfoPopover();
});

window.addEventListener("resize", () => {
  removeCategoryInfoPopover();
});

function setupPuzzle(puzzle, mode = "random", { seed = null, customCategories = [], dailyDateKey = null, syncUrl = true } = {}) {
  trackPuzzleAbandoned("puzzle_switch");
  hasTrackedPuzzleStart = false;
  hasTrackedFirstGuess = false;
  hasTrackedPuzzleCompleted = false;
  puzzleGuessAttempts = [];

  CURRENT_PUZZLE = puzzle;
  CURRENT_PUZZLE_MODE = mode;
  CURRENT_PUZZLE_SEED = Number.isInteger(seed) ? seed : null;
  CUSTOM_SELECTED_IDS = Array.isArray(customCategories) ? [...customCategories] : [];

  if (mode === "daily" && typeof dailyDateKey === "string" && /^\d{4}-\d{2}-\d{2}$/.test(dailyDateKey)) {
    DAILY_PUZZLE_KEY = dailyDateKey;
  }

  if (syncUrl) {
    const dailyUrlKey = mode === "daily" ? null : DAILY_PUZZLE_KEY;
    updatePuzzleUrl(mode, CURRENT_PUZZLE_SEED, CUSTOM_SELECTED_IDS, dailyUrlKey);
  }

  usedContestants.clear();
  resetGuessCounter();

  const rowCats = puzzle.rows;
  const colCats = puzzle.cols;

  rowHeaders = rowCats.map(c => c.id);
  colHeaders = colCats.map(c => c.id);

  const rowHeaderEls = Array.from(document.querySelectorAll(".grid .header.row"));
  const colHeaderEls = Array.from(document.querySelectorAll(".grid .header.col"));

  rowHeaderEls.forEach((el, i) => {
    renderCategoryHeaderWithInfo(el, rowCats[i]);
  });

  colHeaderEls.forEach((el, i) => {
    renderCategoryHeaderWithInfo(el, colCats[i]);
  });

  updateGridInputAccessibilityLabels();
  removeCategoryInfoPopover();

  resetGridInputs();
  clearGridValidationMarkers();
  wireInputs();

  document.getElementById("game-grid").style.display = "grid";
  document.getElementById("share-view").style.display = "block";
  clearShareCopyFeedback();
  if (giveUpBtn) {
    giveUpBtn.style.display = "";
  }

  if (shareCopyBtn) {
    shareCopyBtn.style.display = "none";
  }
  setCustomPlayControlsVisible(false);

  const cache = loadPuzzleCache();
  if (cache) {
    restorePuzzleCache(cache);
  }

  updateDailyProgressNote();
  updatePuzzleDateLabel();
  trackDailyActiveUser();
}

function resetGridInputs() {
  const shareScoreEl = document.getElementById("share-score");
  if (shareScoreEl) shareScoreEl.textContent = "";

  document.querySelectorAll(".grid .cell").forEach(cell => {
    cell.classList.remove("completed-result", "completed-correct", "completed-incorrect", "completed-neutral", "has-rarity", "validation-error", "validation-warning");
    cell.dataset.popupBound = "";
    cell.querySelectorAll(".cell-result-name, .cell-result-meta, .cell-result-rarity, .cell-result-headshot, .cell-result-zoom, .cell-live-rarity, .cell-validation-message").forEach(el => el.remove());
  });

  document.querySelectorAll(".grid .cell input").forEach(input => {
    input.style.display = "";
    input.value = "";
    input.dataset.state = "";
    input.dataset.row = "";
    input.dataset.col = "";
    input.readOnly = false;
    input.disabled = false;
    input.classList.remove("locked", "correct", "incorrect");
    inputSelection.delete(input);
    incorrectGuessCache.delete(input);
  });
}

// ------------------------------------------------------------
// Input wiring
// ------------------------------------------------------------
function wireInputs() {
  const inputs = document.querySelectorAll(".grid .cell input");

  inputs.forEach((input, index) => {
    input.dataset.row = String(Math.floor(index / colHeaders.length));
    input.dataset.col = String(index % colHeaders.length);

    if (wiredInputs.has(input)) return;

    wiredInputs.add(input);
    attachAutocomplete(input);

    // Clear incorrect guesses on focus
    input.addEventListener("focus", () => {
      if (input.dataset.state === "incorrect" || input.dataset.state === "invalid") {
        input.value = "";
        inputSelection.delete(input);
        input.dataset.state = "";
        input.classList.remove("incorrect", "locked");
        savePuzzleCache();
      }
    });

    input.addEventListener("blur", () => {
      const previousGuess = incorrectGuessCache.get(input);
      if (!previousGuess) return;
      if (inputSelection.get(input)) return;

      input.value = previousGuess.value;
      inputSelection.set(input, previousGuess.contestant);
      input.dataset.state = "incorrect";
      input.classList.add("incorrect", "locked");
      savePuzzleCache();
    });

    input.addEventListener("change", () => {
      validateWiredInput(input);
    });
  });
}

// ------------------------------------------------------------
// Share View
// ------------------------------------------------------------
function showShareView() {
  clearShareCopyFeedback();

  if (giveUpBtn) {
    giveUpBtn.style.display = "none";
  }

  if (shareCopyBtn) {
    shareCopyBtn.style.display = "inline-block";
  }

  const shareView = document.getElementById("share-view");
  const gridInputs = Array.from(document.querySelectorAll("#game-grid .cell input"));

  gridInputs.forEach((input, index) => {
    const row = Math.floor(index / 3);
    const col = index % 3;
    const guessedName = input.value.trim() || "—";
    const count = CURRENT_PUZZLE?.grid?.[row]?.[col]?.length ?? 0;

    const cell = input.closest(".cell");
    if (!cell) return;

    input.style.display = "none";
    cell.classList.add("completed-result");
    cell.classList.remove("completed-correct", "completed-incorrect", "completed-neutral");

    const state = input.dataset.state;
    if (state === "correct") {
      cell.classList.add("completed-correct");
    } else if (state === "incorrect") {
      cell.classList.add("completed-incorrect");
    } else {
      cell.classList.add("completed-neutral");
    }

    const rowHeader = document.querySelectorAll("#game-grid .header.row")[row]?.textContent || "";
    const colHeader = document.querySelectorAll("#game-grid .header.col")[col]?.textContent || "";
    cell.setAttribute("aria-label", `${rowHeader} × ${colHeader}: ${count} valid contestants`);

    cell.querySelector(".cell-result-name")?.remove();
    cell.querySelector(".cell-result-meta")?.remove();
    cell.querySelector(".cell-result-rarity")?.remove();
    cell.querySelector(".cell-result-headshot")?.remove();
    cell.querySelector(".cell-result-zoom")?.remove();

    if (state === "correct") {
      const cellContestants = CURRENT_PUZZLE?.grid?.[row]?.[col] ?? [];
      const selectedContestant = inputSelection.get(input);
      const matchedContestant = selectedContestant
        ? cellContestants.find(c => c.castaway_id === selectedContestant.castaway_id)
        : findEligibleContestantByGuessText(guessedName, cellContestants);
      renderCorrectCellHeadshot(cell, input, matchedContestant ?? selectedContestant, row, col);
    } else {
      const nameEl = document.createElement("div");
      nameEl.className = "cell-result-name";
      nameEl.textContent = guessedName;

      const metaEl = document.createElement("div");
      metaEl.className = "cell-result-meta";
      metaEl.innerHTML = `<span aria-hidden="true">🔍</span><span>${count}</span>`;

      cell.append(nameEl, metaEl);
      requestAnimationFrame(() => applyCondensedClassOnOverflow(nameEl));

      if (cell.dataset.popupBound !== "true") {
        cell.addEventListener("click", () => {
          if (!cell.classList.contains("completed-result")) return;
          showValidContestantsPopup(row, col);
        });
        cell.dataset.popupBound = "true";
      }
    }
  });

  guessesDiv.textContent = "Your Completed Grid";
  shareView.style.display = "block";

  const shareScoreEl = document.getElementById("share-score");
  if (shareScoreEl) {
    const score = buildCumulativeRarityScore();
    shareScoreEl.textContent = `Score: ${formatCumulativeScore(score)}`;
  }

  if (CURRENT_PUZZLE_MODE === "daily") {
    renderYesterdayPopularAnswers();
  }
}

function showValidContestantsPopup(r, c) {
  if (_activeModalClose) {
    _activeModalClose();
  }

  const list = CURRENT_PUZZLE.grid[r][c];

  const buildSurvivorReferenceUrl = contestant => {
    const castawayId = typeof contestant?.castaway_id === "string" ? contestant.castaway_id.trim() : "";
    if (!castawayId.startsWith("US")) return null;

    const fullName = typeof contestant?.name === "string"
      ? contestant.name
      : (contestant?.display_name?.[0] || "");
    const slug = fullName
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");

    if (!slug) return null;
    return `https://www.survivor-reference.com/player/${castawayId.toUpperCase()}-${slug}`;
  };

  const entries = list.map(ct => ({
    contestantId: ct.castaway_id || null,
    name: ct.name || ct.display_name?.[0] || "",
    badge: getEditionBadgeConfig(ct),
    url: buildSurvivorReferenceUrl(ct),
    rarityScore: getContestantCategoryPairRarityScore(ct, list, rowHeaders[r], colHeaders[c])
  }));

  const modal = document.createElement("div");
  modal.className = "modal-overlay";

  const modalContent = document.createElement("div");
  modalContent.className = "modal";
  modalContent.setAttribute("role", "dialog");
  modalContent.setAttribute("aria-modal", "true");
  modalContent.setAttribute("aria-labelledby", "valid-contestants-title");

  const title = document.createElement("h3");
  title.id = "valid-contestants-title";
  title.textContent = "Valid Contestants";

  const sortSwitch = document.createElement("div");
  sortSwitch.className = "modal-sort-switch";

  const alphaBtn = document.createElement("button");
  alphaBtn.type = "button";
  alphaBtn.className = "modal-sort-switch-btn active";
  alphaBtn.textContent = "AZ";
  alphaBtn.setAttribute("aria-label", "Sort A to Z");

  const rarityBtn = document.createElement("button");
  rarityBtn.type = "button";
  rarityBtn.className = "modal-sort-switch-btn";
  rarityBtn.textContent = "%";
  rarityBtn.setAttribute("aria-label", "Sort by rarity");

  sortSwitch.append(alphaBtn, rarityBtn);

  const modalList = document.createElement("div");
  modalList.className = "modal-list";

  let sortMode = "alpha";

  function renderList() {
    modalList.innerHTML = "";
    const sorted = [...entries];
    if (sortMode === "rarity") {
      sorted.sort((a, b) => b.rarityScore - a.rarityScore);
    } else {
      sorted.sort((a, b) => a.name.localeCompare(b.name));
    }

    sorted.forEach(({ contestantId, name, badge, url, rarityScore }) => {
      const nameItem = document.createElement("div");
      nameItem.className = "modal-list-item";

      if (badge) {
        nameItem.appendChild(createEditionFlagBadge(badge));
      }

      const nameText = url
        ? document.createElement("a")
        : document.createElement("span");
      if (url) {
        nameText.href = url;
        nameText.target = "_blank";
        nameText.rel = "noopener";
        nameText.className = "modal-list-link modal-list-name";
        nameText.addEventListener("click", () => {
          sendAnalyticsEvent("outbound_link_click", {
            destination: "survivor_reference",
            href: url,
            contestantId,
            contestantName: name
          });
        });
      } else {
        nameText.className = "modal-list-name";
      }
      nameText.textContent = name;
      nameItem.appendChild(nameText);

      if (sortMode === "rarity") {
        const scoreEl = document.createElement("span");
        scoreEl.className = "modal-list-rarity";
        scoreEl.textContent = `${rarityScore.toFixed(1)}%`;
        nameItem.appendChild(scoreEl);
      }

      modalList.appendChild(nameItem);
    });
  }

  alphaBtn.addEventListener("click", () => {
    sortMode = "alpha";
    alphaBtn.classList.add("active");
    rarityBtn.classList.remove("active");
    renderList();
  });

  rarityBtn.addEventListener("click", () => {
    sortMode = "rarity";
    rarityBtn.classList.add("active");
    alphaBtn.classList.remove("active");
    renderList();
  });

  renderList();

  const closeButton = document.createElement("button");
  closeButton.type = "button";
  closeButton.className = "modal-close";
  closeButton.textContent = "Close";

  modalContent.append(title, sortSwitch, modalList, closeButton);
  modal.appendChild(modalContent);

  const previouslyFocused = document.activeElement instanceof HTMLElement
    ? document.activeElement
    : null;

  const focusableSelector = [
    "button:not([disabled])",
    "[href]",
    "input:not([disabled])",
    "select:not([disabled])",
    "textarea:not([disabled])",
    "[tabindex]:not([tabindex=\"-1\"])"
  ].join(",");

  const closeDialog = () => {
    _activeModalClose = null;
    document.removeEventListener("keydown", handleKeydown, true);
    modal.removeEventListener("click", handleOverlayClick);
    modal.remove();

    if (previouslyFocused && document.contains(previouslyFocused)) {
      previouslyFocused.focus();
    }
  };

  const handleKeydown = event => {
    if (event.key === "Escape") {
      event.preventDefault();
      closeDialog();
      return;
    }

    if (event.key !== "Tab") return;

    const focusableElements = Array.from(modalContent.querySelectorAll(focusableSelector));
    if (!focusableElements.length) {
      event.preventDefault();
      closeButton.focus();
      return;
    }

    const firstElement = focusableElements[0];
    const lastElement = focusableElements[focusableElements.length - 1];

    if (event.shiftKey && document.activeElement === firstElement) {
      event.preventDefault();
      lastElement.focus();
      return;
    }

    if (!event.shiftKey && document.activeElement === lastElement) {
      event.preventDefault();
      firstElement.focus();
    }
  };

  const handleOverlayClick = event => {
    if (event.target === modal) {
      closeDialog();
    }
  };

  closeButton.addEventListener("click", closeDialog);
  modal.addEventListener("click", handleOverlayClick);
  document.addEventListener("keydown", handleKeydown, true);

  _activeModalClose = closeDialog;
  document.body.appendChild(modal);
  closeButton.focus();
}

const EDITION_TO_FLAG_ASSET = {
  US: "images/flags/us.svg",
  AU: "images/flags/au.svg",
  SA: "images/flags/za.svg",
  NZ: "images/flags/nz.svg",
  UK: "images/flags/gb.svg",
  FR: "images/flags/fr.svg",
  DE: "images/flags/de.svg"
};

function getEditionCode(seasonCode) {
  if (typeof seasonCode !== "string") return null;
  const match = seasonCode.match(/^[A-Z]+/);
  return match ? match[0] : null;
}

function getEditionBadgeConfig(contestant) {
  if (!Array.isArray(contestant?.seasons)) return null;

  const editionCodes = [];
  contestant.seasons.forEach(seasonCode => {
    const code = getEditionCode(seasonCode);
    if (!code || editionCodes.includes(code)) return;
    editionCodes.push(code);
  });

  if (!editionCodes.length) return null;

  if (editionCodes.includes("AU") && editionCodes.length > 1) {
    const nativeEdition = editionCodes.find(code => code !== "AU");
    return {
      split: true,
      topLeftFlag: EDITION_TO_FLAG_ASSET[nativeEdition] || "images/flags/unknown.svg",
      bottomRightFlag: EDITION_TO_FLAG_ASSET.AU
    };
  }

  const primaryEdition = editionCodes[0];
  return {
    split: false,
    flag: EDITION_TO_FLAG_ASSET[primaryEdition] || "images/flags/unknown.svg"
  };
}

function createEditionFlagBadge(config) {
  const badge = document.createElement("span");
  badge.className = "edition-flag-badge";
  badge.setAttribute("aria-hidden", "true");

  if (!config?.split) {
    badge.style.backgroundImage = `url("${config?.flag || "images/flags/unknown.svg"}")`;
    return badge;
  }

  badge.classList.add("edition-flag-badge-split");

  const topLeftHalf = document.createElement("span");
  topLeftHalf.className = "edition-flag-half edition-flag-half-top-left";
  topLeftHalf.style.backgroundImage = `url("${config.topLeftFlag}")`;

  const bottomRightHalf = document.createElement("span");
  bottomRightHalf.className = "edition-flag-half edition-flag-half-bottom-right";
  bottomRightHalf.style.backgroundImage = `url("${config.bottomRightFlag}")`;

  badge.append(topLeftHalf, bottomRightHalf);
  return badge;
}

// ------------------------------------------------------------
// Share buttons
// ------------------------------------------------------------
function buildEmojiGrid() {
  const inputs = document.querySelectorAll("#game-grid .cell input");
  let out = "";
  inputs.forEach((input, i) => {
    const state = input.dataset.state;
    out += state === "correct" ? "🟩" : "🟥";
    if ((i + 1) % 3 === 0) out += "\n";
  });
  return out.trimEnd();
}

function buildCumulativeRarityScore() {
  const inputs = document.querySelectorAll("#game-grid .cell input");
  let total = 0;
  inputs.forEach(input => {
    if (input.dataset.state === "correct") {
      const row = Number(input.dataset.row);
      const col = Number(input.dataset.col);
      const cellContestants = CURRENT_PUZZLE?.grid?.[row]?.[col] ?? [];
      const selectedContestant = inputSelection.get(input);
      const matchedContestant = selectedContestant
        ? cellContestants.find(c => c.castaway_id === selectedContestant.castaway_id)
        : findEligibleContestantByGuessText(input.value.trim(), cellContestants);
      total += getContestantCategoryPairRarityScore(matchedContestant, cellContestants, rowHeaders[row], colHeaders[col]);
    } else {
      total += 100;
    }
  });
  return total;
}

function formatCumulativeScore(score) {
  if (score < 1) {
    return (Math.ceil(score * 10) / 10).toFixed(1);
  }
  return String(Math.ceil(score));
}


function formatDateFromPuzzleKey(puzzleKey) {
  const keyToUse = typeof puzzleKey === "string" && /^\d{4}-\d{2}-\d{2}$/.test(puzzleKey)
    ? puzzleKey
    : getDailyPuzzleKey();

  const [yearText, monthText, dayText] = keyToUse.split("-");
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);

  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
    return new Date().toLocaleDateString("en-US", {
      year: "numeric",
      month: "long",
      day: "numeric"
    });
  }

  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    year: "numeric",
    month: "long",
    day: "numeric"
  }).format(new Date(Date.UTC(year, month - 1, day)));
}

function buildShareText() {
  const emoji = buildEmojiGrid();
  const canonicalPuzzleUrl = buildPuzzleUrl();
  const today = CURRENT_PUZZLE_MODE === "daily"
    ? formatDateFromPuzzleKey(DAILY_PUZZLE_KEY)
    : new Date().toLocaleDateString("en-US", {
      year: "numeric",
      month: "long",
      day: "numeric"
    });

  const puzzleType = CURRENT_PUZZLE_MODE === "daily"
    ? "Daily Puzzle"
    : (CURRENT_PUZZLE_MODE === "custom" ? "Custom Puzzle" : "Random Puzzle");

  return `[Castaway Cross](${canonicalPuzzleUrl}) - ${today} (${puzzleType})\n${emoji}\n${canonicalPuzzleUrl}`;
}

function buildClipboardShareText() {
  const emoji = buildEmojiGrid();
  const scoreText = `Score: ${formatCumulativeScore(buildCumulativeRarityScore())}`;

  if (CURRENT_PUZZLE_MODE === "daily") {
    const today = formatDateFromPuzzleKey(DAILY_PUZZLE_KEY);
    return `Castaway Cross\n${today}\n${emoji}\n${scoreText}\nhttps://www.castawaycross.com`;
  }

  if (CURRENT_PUZZLE_MODE === "custom") {
    const categoryPath = CUSTOM_SELECTED_IDS.join(",");
    return `Castaway Cross\n${emoji}\n${scoreText}\nhttps://www.castawaycross.com/?mode=custom&cats=${categoryPath}&v=${PUZZLE_SCHEMA_VERSION}`;
  }

  const randomSeed = Number.isInteger(CURRENT_PUZZLE_SEED)
    ? CURRENT_PUZZLE_SEED.toString(36)
    : "";

  return `Castaway Cross\n${emoji}\n${scoreText}\nhttps://www.castawaycross.com/?mode=random&seed=${randomSeed}&v=${PUZZLE_SCHEMA_VERSION}`;
}

const shareCopyBtn = document.getElementById("share-copy");
const giveUpBtn = document.getElementById("give-up-btn");
const shareCopyFeedback = document.getElementById("share-copy-feedback");
const followButtonContainer = document.getElementById("follow-button-container");
const followToggle = document.getElementById("follow-toggle");
const followMenu = document.getElementById("follow-menu");


let shareCopyFeedbackTimeoutId = null;

function clearShareCopyFeedback() {
  if (!shareCopyFeedback) {
    return;
  }

  if (shareCopyFeedbackTimeoutId) {
    window.clearTimeout(shareCopyFeedbackTimeoutId);
    shareCopyFeedbackTimeoutId = null;
  }

  shareCopyFeedback.textContent = "";
  shareCopyFeedback.removeAttribute("data-visible");
}

function showShareCopyFeedback(message, durationMs = 2200) {
  if (!shareCopyFeedback) {
    return;
  }

  clearShareCopyFeedback();

  shareCopyFeedback.textContent = message;
  shareCopyFeedback.setAttribute("data-visible", "true");

  if (durationMs > 0) {
    shareCopyFeedbackTimeoutId = window.setTimeout(() => {
      shareCopyFeedback.textContent = "";
      shareCopyFeedback.removeAttribute("data-visible");
      shareCopyFeedbackTimeoutId = null;
    }, durationMs);
  }
}


if (giveUpBtn) {
  giveUpBtn.onclick = () => {
    if (!CURRENT_PUZZLE || guessesRemaining <= 0) {
      return;
    }

    guessesRemaining = 0;
    guessesDiv.textContent = `Guesses Remaining: ${guessesRemaining}`;
    document.querySelectorAll(".grid .cell input").forEach(i => (i.disabled = true));
    savePuzzleCache();
    updateDailyProgressNote();
    finalizeCompletedGrid({ trigger: "give_up" });
  };
}

if (shareCopyBtn) {
  shareCopyBtn.onclick = async () => {
    const text = buildClipboardShareText();

    if (!navigator.clipboard?.writeText) {
      showStatusToast("Clipboard unavailable in this browser.", "error", 2800);
      return;
    }

    try {
      await navigator.clipboard.writeText(text);
      showShareCopyFeedback("Results copied to clipboard");
    } catch (error) {
      console.error("[grid] Failed to copy share summary.", error);
      showStatusToast("Could not copy summary. Try again.", "error", 2800);
    }
  };
}

if (followButtonContainer && followToggle && followMenu) {
  const closeFollowMenu = () => {
    followButtonContainer.classList.remove("open");
    followToggle.setAttribute("aria-expanded", "false");
  };

  const toggleFollowMenu = () => {
    const isOpen = followButtonContainer.classList.toggle("open");
    followToggle.setAttribute("aria-expanded", isOpen ? "true" : "false");
  };

  followToggle.addEventListener("click", event => {
    event.stopPropagation();
    toggleFollowMenu();
  });

  followMenu.addEventListener("click", event => {
    event.stopPropagation();

    const menuLink = event.target instanceof Element
      ? event.target.closest("a")
      : null;

    if (menuLink) {
      closeFollowMenu();
    }
  });

  document.addEventListener("click", event => {
    if (!followButtonContainer.contains(event.target)) {
      closeFollowMenu();
    }
  });

  document.addEventListener("keydown", event => {
    if (event.key === "Escape") {
      closeFollowMenu();
    }
  });
}


function trackExit(reason) {
  if (hasTrackedExit) return;
  hasTrackedExit = true;

  trackPuzzleAbandoned(`session_exit_${reason}`);
  const puzzleOutcomeSummary = buildPuzzleOutcomeSummary();

  sendAnalyticsEvent("session_exit", {
    reason,
    visibilityState: document.visibilityState,
    guessesRemaining,
    puzzlesStartedThisSession,
    puzzlesCompletedThisSession,
    hasAnyAttempt: puzzlesStartedThisSession > 0,
    hasAnyCompletion: puzzlesCompletedThisSession > 0,
    puzzleOutcomesByType: puzzleOutcomeSummary.byType,
    totalPuzzleCompletions: puzzleOutcomeSummary.totals.completed,
    totalPuzzleAbandons: puzzleOutcomeSummary.totals.abandoned,
    totalPuzzleAttempts: puzzleOutcomeSummary.totals.attempted
  }, { useBeacon: true });
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    refreshDailyPuzzleIfDateChanged();
  }

  if (document.visibilityState === "hidden") {
    trackExit("visibility_hidden");
  }
});

window.addEventListener("focus", () => {
  refreshDailyPuzzleIfDateChanged();
});

window.addEventListener("pagehide", event => {
  trackExit(event.persisted ? "pagehide_bfcache" : "pagehide");
});

// ------------------------------------------------------------
// Buttons: Random + Daily
// ------------------------------------------------------------
document.getElementById("random-btn").onclick = () => {
  try {
    hideSetupPanels();
    const seed = createPuzzleSeed();
    const puzzle = generateRandomPuzzleForMode(seed);
    setupPuzzle(puzzle, "random", { seed });
    updateDailyProgressNote();
  } catch (error) {
    console.error("[grid] Random puzzle generation failed.", error);
    showPuzzleGenerationError("Could not generate a random puzzle right now. Please try again.");
  }
};


document.getElementById("custom-btn").onclick = () => {
  renderCustomSetupGrid();
};

if (customPlayButton) {
  customPlayButton.onclick = () => {
    if (!CUSTOM_PENDING_SELECTION_IDS) return;
    launchCustomPuzzle(CUSTOM_PENDING_SELECTION_IDS);
  };
}


document.getElementById("daily-btn").onclick = () => {
  try {
    hideSetupPanels();
    DAILY_PUZZLE_KEY = getTodayDailyPuzzleKey();
    const puzzle = resolveDailyPuzzleForKey(DAILY_PUZZLE_KEY);
    setupPuzzle(puzzle, "daily", { dailyDateKey: DAILY_PUZZLE_KEY });
    savePuzzleCache();
    updateDailyProgressNote();
  } catch (error) {
    console.error("[grid] Daily puzzle generation failed.", error);
    showPuzzleGenerationError("Could not load today's puzzle. Please try again later.");
  }
};

sendAnalyticsEvent("page_load", {
  path: window.location.pathname,
  query: window.location.search || ""
});

// ------------------------------------------------------------
// Initial puzzle on load
// ------------------------------------------------------------
(() => {
  startDailyPuzzleRolloverWatcher();
  DAILY_PUZZLE_KEY = getTodayDailyPuzzleKey();
  const initialLoadStages = [];
  const urlStage = getInitialPuzzleFromUrl();

  if (urlStage) {
    initialLoadStages.push({
      name: urlStage.stageName,
      mode: urlStage.mode,
      seed: urlStage.seed,
      customCategories: urlStage.customCategories || [],
      dailyDateKey: urlStage.dailyDateKey || null,
      run: urlStage.run
    });
  }

  initialLoadStages.push({
    name: "daily-default",
    mode: "daily",
    seed: null,
    dailyDateKey: DAILY_PUZZLE_KEY,
    run: () => resolveDailyPuzzleForKey(DAILY_PUZZLE_KEY)
  });

  for (let i = 0; i < initialLoadStages.length; i += 1) {
    const stage = initialLoadStages[i];

    if (stage.loadingMessage) {
      guessesDiv.textContent = stage.loadingMessage;
    }

    try {
      const puzzle = stage.run();
      console.info(`[grid] Initial load stage succeeded: ${stage.name}`);
      setupPuzzle(puzzle, stage.mode, { seed: stage.seed, customCategories: stage.customCategories || [], dailyDateKey: stage.dailyDateKey || null });
      return;
    } catch (error) {
      console.warn(`[grid] Initial load stage failed: ${stage.name}`, error);
      if (stage.requireNotFoundOnFailure) {
        redirectToNotFoundPage();
        return;
      }
    }
  }

  showPuzzleGenerationError(
    "Couldn't load any puzzle automatically. Please refresh to try again."
  );
})();
