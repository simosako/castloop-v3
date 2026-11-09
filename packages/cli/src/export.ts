import { link, unlink, writeFile } from "node:fs/promises";
import { showIdPattern } from "@castloop/domain";
import { fetchShowExport, fetchShows } from "./api";
import { credentialsDirectory, readConfig, readSecrets } from "./config";
import { UsageError } from "./errors";

/** Export metadata references only, without overwriting an existing file. */
export async function exportShows(root: string, destination: string, onlyShow?: string, json = false): Promise<void> {
  if (onlyShow !== undefined && !showIdPattern.test(onlyShow)) throw new UsageError("Invalid show ID");
  const config = await readConfig(root), secrets = await readSecrets(credentialsDirectory());
  if (!config.management_url || !config.management_bucket || !config.delivery_bucket || !secrets.admin_token) throw new Error("Management URL, management and delivery buckets, and admin token must be configured");
  let ids: string[];
  if (onlyShow) ids = [onlyShow];
  else {
    const result = await fetchShows(config.management_url, secrets.admin_token);
    if (result.issues.length) throw new Error("Show discovery is incomplete; export was not written");
    ids = result.shows.map(item => item.show_id).sort();
  }
  const shows = [];
  for (const showId of ids) shows.push(await fetchShowExport(config.management_url, secrets.admin_token, showId));
  const created_at = Date.now();
  const installation = { management_origin: config.management_url, management_bucket: config.management_bucket, delivery_bucket: config.delivery_bucket };
  for (const show of shows) if (Buffer.byteLength(JSON.stringify({ format_version: 1, created_at, installation, shows: [show] })) > 16 * 1024 * 1024) throw new Error(`Show ${show.show_id} export exceeds the 16 MiB restore limit`);
  const output = JSON.stringify({ format_version: 1, created_at, installation, shows }, null, 2) + "\n";
  const temp = `${destination}.${crypto.randomUUID()}.tmp`;
  try {
    await writeFile(temp, output, { flag: "wx", mode: 0o600 });
    await link(temp, destination);
  } finally { await unlink(temp).catch(error => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }); }
  if (json) console.log(JSON.stringify({ version: 1, path: destination, shows: ids, created_at, source_objects_remain_in_r2: true, exit_code: 0 }));
  else console.log(`Exported ${shows.length} show(s) to ${destination}. Source objects remain in R2; later cleanup can invalidate this export.`);
}
