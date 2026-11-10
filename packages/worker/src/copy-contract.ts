import type { ObjectRef } from "@castloop/domain";

export const COPY_GROUP_SIZE = 4;
// Provisional upper bound until the complete 100-Episode path is measured.
export const MAX_PUBLICATION_COPIES = 101;
export interface CopyItem { source: ObjectRef; path: string; mime: "audio/mpeg" | "image/jpeg" | "image/png" }
