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

export function formatDateRange(
  start?: Date | string | null,
  end?: Date | string | null,
  startPrecision?: DatePrecision | null,
  endPrecision?: DatePrecision | null,
): string | null {
  if (!start) return null;
  const startStr = formatByPrecision(start, startPrecision);
  const endStr = end ? formatByPrecision(end, endPrecision) : 'Present';
  return `${startStr} – ${endStr}`;
}
