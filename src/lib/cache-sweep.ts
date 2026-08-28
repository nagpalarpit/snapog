// SnapOG — R2 cache sweep (runs daily via [triggers] crons in wrangler.toml)
//
// og/<sha256>.png keys are content-addressed: the hash is derived from the
// full set of request params (title, description, domain, author, tag,
// theme, template, watermark). Since title/description are free-text user
// input, cardinality is effectively unbounded — every distinct OG image
// anyone has ever requested gets its own permanent object, and nothing
// deletes them. R2 charges for storage, not just requests, so this cache
// grows forever unless something reaps stale entries. This sweep deletes
// og/ objects untouched in the last `retentionDays`, so cardinality is
// bounded by write volume over that window instead of write volume over the
// app's entire lifetime.

export interface CacheSweepResult {
  swept_at: string;
  deleted: number;
}

export async function runCacheSweep(
  bucket: R2Bucket,
  now: Date = new Date(),
  retentionDays = 30
): Promise<CacheSweepResult> {
  const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);

  let deleted = 0;
  let cursor: string | undefined;

  do {
    const page = await bucket.list({ prefix: 'og/', cursor, limit: 1000 });
    const stale = page.objects.filter(obj => obj.uploaded < cutoff).map(obj => obj.key);

    if (stale.length > 0) {
      // R2 delete() accepts an array of keys in one call.
      await bucket.delete(stale);
      deleted += stale.length;
    }

    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);

  return { swept_at: now.toISOString(), deleted };
}
