/**
 * Note templates: what a new note starts with below its header. Their
 * placeholders are filled in when the note is created:
 *
 * - `{{title}}`: the note's title, escaped for Typst markup
 * - `{{date}}` and `{{time}}`: now, as `YYYY-MM-DD` and `HH:mm`
 * - `{{date:FORMAT}}` or `{{time:FORMAT}}`: now in `FORMAT`, e.g.
 *   `{{date:dddd, D MMMM YYYY}}` (see `formatDate`)
 *
 * Anything else in braces stays as it is.
 */

/** Escapes characters with a meaning in Typst markup. */
export const escapeMarkup = (text: string) =>
  text.replace(/[\\[\]*_#$@<>`~]/g, '\\$&');

const pad = (n: number, width = 2) => String(n).padStart(width, '0');

/**
 * `date` in `format`, Moment-style (as in Obsidian): `YYYY` `YY` year;
 * `MMMM` `MMM` `MM` `M` month (name, short name, padded, number); `DD` `D`
 * day; `dddd` `ddd` weekday; `HH` `H` `hh` `h` hour (24 and 12-hour);
 * `mm` `m` minute; `ss` `s` second; `A` `a` AM/PM. Text in `[brackets]`
 * is literal.
 */
export function formatDate(date: Date, format: string): string {
  const name = (options: Intl.DateTimeFormatOptions) =>
    date.toLocaleString(undefined, options);
  const hour12 = date.getHours() % 12 || 12;
  const tokens: Record<string, () => string> = {
    YYYY: () => String(date.getFullYear()),
    YY: () => pad(date.getFullYear() % 100),
    MMMM: () => name({ month: 'long' }),
    MMM: () => name({ month: 'short' }),
    MM: () => pad(date.getMonth() + 1),
    M: () => String(date.getMonth() + 1),
    DD: () => pad(date.getDate()),
    D: () => String(date.getDate()),
    dddd: () => name({ weekday: 'long' }),
    ddd: () => name({ weekday: 'short' }),
    HH: () => pad(date.getHours()),
    H: () => String(date.getHours()),
    hh: () => pad(hour12),
    h: () => String(hour12),
    mm: () => pad(date.getMinutes()),
    m: () => String(date.getMinutes()),
    ss: () => pad(date.getSeconds()),
    s: () => String(date.getSeconds()),
    A: () => (date.getHours() < 12 ? 'AM' : 'PM'),
    a: () => (date.getHours() < 12 ? 'am' : 'pm'),
  };
  return format.replace(
    /\[([^\]]*)\]|YYYY|YY|MMMM|MMM|MM|M|DD|D|dddd|ddd|HH|H|hh|h|mm|m|ss|s|A|a/g,
    (token, literal: string | undefined) => literal ?? tokens[token](),
  );
}

const DEFAULT_FORMATS: Record<string, string> = {
  date: 'YYYY-MM-DD',
  time: 'HH:mm',
};

/** `text` with its placeholders filled in for a note titled `title`, created `now`. */
export function expandTemplate(
  text: string,
  { title, now }: { title: string; now: Date },
): string {
  return text.replace(
    /\{\{\s*(title|date|time)\s*(?::([^}]*))?\}\}/g,
    (_, name: string, format: string | undefined) =>
      name === 'title'
        ? escapeMarkup(title)
        : formatDate(now, format?.trim() || DEFAULT_FORMATS[name]),
  );
}
