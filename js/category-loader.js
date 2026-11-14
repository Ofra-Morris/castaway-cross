// ------------------------------------------------------------
// Category Loader
// Loads generated-categories.json through category-engine.js
// ------------------------------------------------------------

import {
  loadCategories,
  getAllCategories
} from "./category-engine.js";

// Initialize and return all categories
export async function initCategories() {
  await loadCategories();     // loads generated-categories.json
  return getAllCategories();  // returns the full list
}
