import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "crypto";

const BUCKET = "umbra-uploads";

function extractProjectUrl(dbUrl: string): string | null {
  const match = dbUrl.match(/db\.([^.]+)\.supabase\.co/);
  if (!match) return null;
  return `https://${match[1]}.supabase.co`;
}

function getSupabase(): SupabaseClient {
  const url =
    process.env.SUPABASE_URL ||
    (process.env.SUPABASE_DATABASE_URL
      ? extractProjectUrl(process.env.SUPABASE_DATABASE_URL)
      : null);
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set for file uploads. " +
        "Get these from your Supabase project → Settings → API."
    );
  }
  return createClient(url, key);
}

export class ObjectNotFoundError extends Error {
  constructor() {
    super("Object not found");
    this.name = "ObjectNotFoundError";
    Object.setPrototypeOf(this, ObjectNotFoundError.prototype);
  }
}

export async function getSignedUploadUrl(): Promise<{
  uploadURL: string;
  publicUrl: string;
  objectPath: string;
}> {
  const supabase = getSupabase();
  const filename = `uploads/${randomUUID()}`;

  const { data, error } = await supabase.storage
    .from(BUCKET)
    .createSignedUploadUrl(filename);

  if (error || !data) {
    throw new Error(`Failed to create signed upload URL: ${error?.message}`);
  }

  const {
    data: { publicUrl },
  } = supabase.storage.from(BUCKET).getPublicUrl(filename);

  return {
    uploadURL: data.signedUrl,
    publicUrl,
    objectPath: `/objects/${filename}`,
  };
}

export async function deleteFile(filename: string): Promise<void> {
  try {
    const supabase = getSupabase();
    await supabase.storage.from(BUCKET).remove([filename]);
  } catch {
  }
}
