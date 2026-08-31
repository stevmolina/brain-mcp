/** Postgres `date` columns arrive as JS Date objects, whose default string form
 * is "Mon Jan 01 2024 ...". Every date this server shows is an ISO day. */
export function isoDay(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}
