import { Router, type IRouter, type Request, type Response } from "express";
import { z } from "zod";
import { getSignedUploadUrl, ObjectNotFoundError } from "../lib/objectStorage";

const RequestUploadUrlBody = z.object({
  name: z.string(),
  size: z.number(),
  contentType: z.string(),
});

const router: IRouter = Router();

router.post("/storage/uploads/request-url", async (req: Request, res: Response) => {
  const parsed = RequestUploadUrlBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Missing or invalid required fields" });
    return;
  }

  try {
    const { uploadURL, publicUrl, objectPath } = await getSignedUploadUrl();
    res.json({ uploadURL, publicUrl, objectPath });
  } catch (error) {
    req.log.error({ err: error }, "Error generating upload URL");
    res.status(500).json({ error: "Failed to generate upload URL. Ensure SUPABASE_SERVICE_ROLE_KEY is set." });
  }
});

router.get("/storage/objects/*path", async (req: Request, res: Response) => {
  res.status(404).json({ error: "Photos are now served directly from Supabase Storage CDN. This proxy endpoint is no longer used." });
});

router.get("/storage/public-objects/*filePath", async (req: Request, res: Response) => {
  res.status(404).json({ error: "Photos are now served directly from Supabase Storage CDN." });
});

export default router;
