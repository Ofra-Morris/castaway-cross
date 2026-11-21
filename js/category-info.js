// The note behind a clue's "i" button. A category's own `tooltip` wins; then
// the note for its type. Kept apart from grid.js so it can be checked without a
// browser (scripts/test-category-notes.js).

export const CATEGORY_INFO_BY_TYPE = {
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
  immunity_wins_count: "Immunity Wins: individual immunity wins only; tribal immunity doesn't count. Career clues add up every season played; Single Season clues need the count in one season.",
  confessional_count: "Confessionals: how many confessionals a player had. Career clues add up every season played; Single Season clues need the count in one season.",
  votes_against_count: "Votes Against: votes cast against a player at Tribal Council. Votes nullified by idols or advantages don't count. Career clues add up every season played; Single Season clues need the count in one season.",
  sit_out_min_count: "Sit-Outs: times a player sat out of a challenge. Career clues add up every season played; Single Season clues need the count in one season.",
  tribe_color: "Tribe Color: players who were on a tribe with the listed buff color (grouped by color family).",
  firemaking_result: "Firemaking: players who won or lost a fire-making challenge, including the final four fire-making challenge and fire-making tiebreakers.",
  castaway_id_in_set: "Challenges: players who participated in or won a specific recurring challenge grouping.",
  gender_equals: "Gender: players who are categorized as men or women.",
  age_bracket: "Age: based on a castaway’s age during filming, not when the season aired. A player with a birthday into a new range while still competing counts for both."
};

export function getCategoryInfoText(category) {
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
