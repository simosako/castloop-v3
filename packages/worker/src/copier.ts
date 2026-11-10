import { WorkerEntrypoint } from "cloudflare:workers";
import { AwsClient } from "aws4fetch";
import { copyMediaObject } from "./copy";
import { COPY_GROUP_SIZE, type CopyItem } from "./copy-contract";

/** Private service binding; this Worker has no public route or R2 bindings. */
export default class Copier extends WorkerEntrypoint<{
  R2_ACCOUNT_ID: string; R2_MANAGEMENT_BUCKET: string; R2_DELIVERY_BUCKET: string;
  CASTLOOP_WORKER_R2_ACCESS_KEY_ID: string; CASTLOOP_WORKER_R2_SECRET_ACCESS_KEY: string;
}> {
  fetch(): Response { return new Response(null, { status: 404 }); }

  async copy(items: CopyItem[]): Promise<void> {
    if (!Array.isArray(items) || !items.length || items.length > COPY_GROUP_SIZE) throw new Error("Invalid copy group size");
    const config = { accountId: this.env.R2_ACCOUNT_ID, sourceBucket: this.env.R2_MANAGEMENT_BUCKET, deliveryBucket: this.env.R2_DELIVERY_BUCKET,
      accessKeyId: this.env.CASTLOOP_WORKER_R2_ACCESS_KEY_ID, secretAccessKey: this.env.CASTLOOP_WORKER_R2_SECRET_ACCESS_KEY };
    const signer = new AwsClient({ accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey, service: "s3", region: "auto", retries: 0 });
    for (const item of items) {
      if (!item || typeof item !== "object" || Object.keys(item).sort().join(",") !== "mime,path,source" || typeof item.path !== "string" ||
          !["audio/mpeg", "image/jpeg", "image/png"].includes(item.mime)) throw new Error("Invalid copy item");
      await copyMediaObject(config, item.source, item.path, item.mime, undefined, signer);
    }
  }
}
