const HOMEPAGE_LIMIT = 4;

const updatesList = document.getElementById("updates-list");
const updatesEmptyState = document.getElementById("updates-empty");

function showUpdatesEmptyState(message) {
  if (updatesEmptyState) {
    updatesEmptyState.textContent = message;
    updatesEmptyState.hidden = false;
  }
}

function hideUpdatesEmptyState() {
  if (updatesEmptyState) {
    updatesEmptyState.hidden = true;
  }
}

function formatUpdateDate(isoDateString) {
  const date = new Date(isoDateString);

  if (Number.isNaN(date.getTime())) {
    return "";
  }

  return date.toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric"
  });
}

function renderUpdateItem(update) {
  const item = document.createElement("li");
  item.className = "update-item";

  const title = document.createElement("a");
  title.className = "update-title";
  title.href = update.url;
  title.textContent = update.title;

  const summary = document.createElement("p");
  summary.className = "update-summary";
  summary.textContent = update.summary;

  const meta = document.createElement("p");
  meta.className = "update-meta";
  const published = formatUpdateDate(update.publishedAt);
  meta.textContent = published ? `Published ${published}` : "";

  item.appendChild(title);
  item.appendChild(summary);
  if (meta.textContent) {
    item.appendChild(meta);
  }

  return item;
}

function renderUpdates(updates, limit) {
  if (!updatesList) {
    return;
  }

  updatesList.innerHTML = "";

  const visible = limit != null ? updates.slice(0, limit) : updates;
  for (const update of visible) {
    updatesList.appendChild(renderUpdateItem(update));
  }

  const existingFooter = document.getElementById("updates-footer");
  if (existingFooter) {
    existingFooter.remove();
  }

  if (limit != null && updates.length > limit) {
    const footer = document.createElement("div");
    footer.id = "updates-footer";
    const link = document.createElement("a");
    link.href = "updates.html";
    link.className = "updates-show-more";
    link.textContent = "View full changelog →";
    footer.appendChild(link);
    updatesList.insertAdjacentElement("afterend", footer);
  }
}

async function loadUpdates() {
  if (!updatesList) {
    return;
  }

  try {
    const response = await fetch("frontend/data/updates.json", {
      cache: "no-cache"
    });

    if (!response.ok) {
      throw new Error(`Unexpected response (${response.status}) loading updates.`);
    }

    const updates = await response.json();

    if (!Array.isArray(updates) || updates.length === 0) {
      showUpdatesEmptyState("No updates posted yet. Check back soon.");
      return;
    }

    hideUpdatesEmptyState();
    renderUpdates(updates, HOMEPAGE_LIMIT);
  } catch (error) {
    console.error("[updates] Failed to load updates.", error);
    showUpdatesEmptyState("Unable to load updates right now.");
  }
}

void loadUpdates();
