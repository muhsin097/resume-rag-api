export type DatePrecision = 'YEAR' | 'MONTH' | 'DAY';

const MONTH_NAMES = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

// "Jan 2018", not "2018-01" -- a raw ISO month looks like a database
// value on a resume.
//
// Precision matters: a date stored with only a year known (e.g. a resume
// import that only said "2015") still needs a real DateTime for sorting,
// so it's stored as Jan 1 -- but displaying that as "Jan 2015" invents a
// month the source never gave. YEAR precision formats as just the year;
// MONTH/DAY (or no precision recorded, e.g. manually-entered dates)
// format as "Mon YYYY".
export function formatByPrecision(
  value: Date | string,
  precision?: DatePrecision | null,
): string {
  const date = typeof value === 'string' ? new Date(value) : value;
  if (precision === 'YEAR') {
    return `${date.getUTCFullYear()}`;
  }
  return `${MONTH_NAMES[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

// A null end date is ambiguous on its own -- "still ongoing" and "ended,
// exact date unknown" look identical. isCurrent disambiguates: true means
// a real present-tense/ongoing signal was found, so this genuinely is
// "Present". false with no end date means the role/degree/project ended
// at some point, but the source never said when -- showing "Present"
// there would claim something we don't actually know. Showing just the
// start date is honest about that gap rather than guessing in either
// direction.
export function formatDateRange(
  start?: Date | string | null,
  end?: Date | string | null,
  startPrecision?: DatePrecision | null,
  endPrecision?: DatePrecision | null,
  isCurrent?: boolean,
): string | null {
  if (!start) return null;
  const startStr = formatByPrecision(start, startPrecision);
  if (isCurrent) return `${startStr} – Present`;
  if (end) return `${startStr} – ${formatByPrecision(end, endPrecision)}`;
  return startStr;
}
