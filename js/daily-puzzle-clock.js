const EASTERN_TIME_ZONE = "America/New_York";
const DAILY_RESET_HOUR_ET = 6;

const easternFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: EASTERN_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  hourCycle: "h23"
});

function getEasternDateParts(referenceDate) {
  const parts = easternFormatter.formatToParts(referenceDate);
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));

  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour)
  };
}

function shiftDatePartsByDays({ year, month, day }, dayDelta) {
  const shiftedDate = new Date(Date.UTC(year, month - 1, day + dayDelta));
  return {
    year: shiftedDate.getUTCFullYear(),
    month: shiftedDate.getUTCMonth() + 1,
    day: shiftedDate.getUTCDate()
  };
}

export function getDailyPuzzleDateParts(referenceDate = new Date()) {
  const eastern = getEasternDateParts(referenceDate);

  if (eastern.hour < DAILY_RESET_HOUR_ET) {
    return shiftDatePartsByDays(eastern, -1);
  }

  return {
    year: eastern.year,
    month: eastern.month,
    day: eastern.day
  };
}

export function getDailyPuzzleKey(referenceDate = new Date()) {
  const { year, month, day } = getDailyPuzzleDateParts(referenceDate);
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function getDailyPuzzleSeed(referenceDate = new Date()) {
  const { year, month, day } = getDailyPuzzleDateParts(referenceDate);
  return Number(`${year}${month}${day}`);
}
