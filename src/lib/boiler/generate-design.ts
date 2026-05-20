/**
 * Phase 11D — BOILER v2 design generation orchestrator.
 *
 * Wires together the three pieces of a BOILER call:
 *   1. buildBoilerPrompt() — assemble the gpt-image-2 prompt from inputs (pure)
 *   2. generateImageViaResponses() — call OpenAI's Responses API
 *   3. uploadBase64Image() — upload the result to Cloudinary
 *
 * Returns a GenerateDesignOutput suitable for direct insert into design_versions.
 * Does NOT write to the DB — that's the Inngest handler's job (so this function
 * is unit-testable + usable from eval scripts without a DB write).
 *
 * Errors thrown here are CAUGHT by the Inngest handler's step wrapper (which
 * gives us automatic retries + onFailure marker). For evals, errors bubble.
 */

import {
  buildBoilerPrompt,
  buildGarmentSystemBackPrompt,
  needsBackFace,
  validatePaletteRoles,
} from "./build-prompt";
import { generateImageViaResponses } from "./openai-image-client";
import { verifyDesignOutput } from "./verify-output";
import { uploadBase64Image } from "@/lib/cloudinary";
import { DESIGN_DIMENSIONS } from "./types";
import type {
  GenerateDesignInput,
  GenerateDesignOutput,
  VerificationResultLite,
} from "./types";

export interface GenerateDesignOptions {
  /**
   * When true, skip the post-upload vision-LLM verification step. Used by
   * eval scripts that want to test the generation path independently from
   * the verifier, or when running on a tier where the verifier hasn't been
   * tuned yet. Default: false (verification ALWAYS runs in production).
   */
  skipVerification?: boolean;
  /**
   * When true, skip BACK-face generation even for narrative structures. The
   * Inngest handler sets this so it can run the back face in a SEPARATE step
   * (front gen + back gen in ONE step exceeds Vercel's 60s function limit →
   * 504 timeout). Direct callers (eval scripts) leave it false to get the
   * full front+back in a single call. Default: false.
   */
  skipBackFace?: boolean;
}

export interface GenerateBackFaceResult {
  backArtworkUrl: string | null;
  backCloudinaryPublicId: string | null;
  backPromptUsed: string | null;
}

/**
 * Generate the BACK face from the front image (provided as base64).
 *
 * Extracted from generateDesign so the Inngest handler can run it in its OWN
 * step. Each Inngest step on Vercel is a separate function invocation with its
 * own timeout budget; front gen + back gen in a single step blows past the 60s
 * Vercel limit (the 504 regression PR-C introduced). The handler fetches the
 * just-uploaded front from Cloudinary → base64 → here, keeping the heavy
 * base64 OUT of the step-result boundary.
 *
 * Fail-soft: returns all-null on ANY error so a missing back never sinks the
 * front (which the caller has already generated + persisted).
 */
export async function generateBackFace(
  input: GenerateDesignInput,
  frontImageBase64: string,
): Promise<GenerateBackFaceResult> {
  const folder = `blips/boiler-v2/${input.context.shortcode}`;
  const publicIdHint = `${input.context.shortcode.toLowerCase()}-v${Date.now()}-${input.tier}-back`;
  try {
    const backPromptUsed = buildGarmentSystemBackPrompt(input);
    const backResult = await generateImageViaResponses({
      prompt: backPromptUsed,
      tier: input.tier,
      previousImageBase64: frontImageBase64, // the front is the /edits base
      width: DESIGN_DIMENSIONS.width,
      height: DESIGN_DIMENSIONS.height,
    });
    const backUpload = await uploadBase64Image(backResult.imageBase64, {
      folder,
      publicIdHint,
      overwrite: false,
    });
    return {
      backArtworkUrl: backUpload.optimizedUrl,
      backCloudinaryPublicId: backUpload.publicId,
      backPromptUsed,
    };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(
      `[generate-design] back-face generation failed (fail-soft): ${msg}. Front persists; back unset.`,
    );
    return {
      backArtworkUrl: null,
      backCloudinaryPublicId: null,
      backPromptUsed: null,
    };
  }
}

/**
 * The main BOILER v2 service entry point.
 *
 * One call = one design version. Inngest handler invokes this per ORC tool
 * trigger (generate_design / refine_design / branch_version / finalize_design)
 * and persists the result to design_versions + updates boiler_state.
 *
 * Flow:
 *   1. validate palette + refinement shape
 *   2. fetch parent image bytes (for refinement)
 *   3. build prompt
 *   4. call OpenAI Images API
 *   5. upload result to Cloudinary
 *   6. run vision-LLM verifier (Gemini Flash) — fail-soft: if verifier itself
 *      errors, we log + return null verification rather than fail the whole
 *      generation (the design is real, we just couldn't QA it automatically)
 *   7. return GenerateDesignOutput including verification verdict
 */
export async function generateDesign(
  input: GenerateDesignInput,
  options: GenerateDesignOptions = {},
): Promise<GenerateDesignOutput> {
  // ─── Validate palette ────────────────────────────────────────────
  // Strict validation: incomplete palettes produce garbage from gpt-image-2
  // ("garment_base: undefined" in the prompt) — better to fail loudly here
  // than to ship a broken design.
  const paletteError = validatePaletteRoles(input.paletteRoles);
  if (paletteError) {
    throw new Error(`[generate-design] palette validation failed: ${paletteError}`);
  }

  // ─── Validate refinement shape ───────────────────────────────────
  // Refinement requires both parent + instruction; branch requires parent + no instruction.
  // Caller bugs that mismatch are easier to debug if we fail fast here.
  if (input.refinementInstruction && !input.parent) {
    throw new Error(
      "[generate-design] refinementInstruction provided but no parent — refinement needs a parent version to chain off",
    );
  }
  if (input.parent && !input.parent.parentFlatArtworkUrl) {
    throw new Error(
      "[generate-design] parent provided without parentFlatArtworkUrl — cannot chain via /v1/images/edits",
    );
  }

  // ─── Fetch parent image bytes if refining ────────────────────────
  // /edits takes the previous PNG as a multipart upload. We fetch the parent's
  // Cloudinary URL → bytes → base64 → pass to the client.
  let previousImageBase64: string | undefined;
  if (input.parent) {
    const parentRes = await fetch(input.parent.parentFlatArtworkUrl);
    if (!parentRes.ok) {
      throw new Error(
        `[generate-design] parent flat artwork fetch failed: HTTP ${parentRes.status} (${input.parent.parentFlatArtworkUrl})`,
      );
    }
    const buf = Buffer.from(await parentRes.arrayBuffer());
    previousImageBase64 = buf.toString("base64");
  }

  // ─── Build prompt + call gpt-image-1 ─────────────────────────────
  const promptUsed = buildBoilerPrompt(input);

  const imageResult = await generateImageViaResponses({
    prompt: promptUsed,
    tier: input.tier,
    previousImageBase64,
    width: DESIGN_DIMENSIONS.width,
    height: DESIGN_DIMENSIONS.height,
  });

  // ─── Upload to Cloudinary ────────────────────────────────────────
  // Public id includes signal shortcode + a timestamp suffix so each version
  // gets its own asset (we don't overwrite — history is preserved).
  const ts = Date.now();
  const publicIdHint = `${input.context.shortcode.toLowerCase()}-v${ts}-${input.tier}`;
  const folder = `blips/boiler-v2/${input.context.shortcode}`;

  const uploadResult = await uploadBase64Image(imageResult.imageBase64, {
    folder,
    publicIdHint,
    overwrite: false, // each version is its own asset
  });

  // ─── PR-C: BACK face (front_back_narrative / colorway_pair) ──────
  // Generate the second beat via /edits FROM the front image so the shared
  // system + palette stay consistent and only the narrative variable changes.
  // Only on fresh generations (refine/branch already chain from a parent).
  //
  // skipBackFace: the Inngest handler runs the back face in its OWN step
  // instead (front gen + back gen in a single step exceeds Vercel's 60s limit
  // → 504). Direct callers (evals) leave it off and get front+back in one go.
  let backArtworkUrl: string | null = null;
  let backCloudinaryPublicId: string | null = null;
  let backPromptUsed: string | null = null;
  if (
    !options.skipBackFace &&
    !input.parent &&
    !input.refinementInstruction &&
    needsBackFace(input.furnaceBrief)
  ) {
    const back = await generateBackFace(input, imageResult.imageBase64);
    backArtworkUrl = back.backArtworkUrl;
    backCloudinaryPublicId = back.backCloudinaryPublicId;
    backPromptUsed = back.backPromptUsed;
  }

  // ─── Verify output (vision-LLM-as-judge) ─────────────────────────
  // Gemini 2.5 Flash inspects the generated image against the brief.
  // Fail-soft on the verifier itself — if Gemini errors or times out,
  // we log + return null verification, NOT throw (the design is real,
  // we just couldn't QA it automatically; the founder can decide).
  let verification: VerificationResultLite | null = null;
  if (!options.skipVerification) {
    try {
      const expectedTexts: string[] = [];
      const meta = input.compositionMeta;
      if (meta.exact_text?.front) expectedTexts.push(meta.exact_text.front);
      if (meta.exact_text?.back) expectedTexts.push(meta.exact_text.back);

      const v = await verifyDesignOutput({
        imageUrl: uploadResult.optimizedUrl,
        expectedTexts,
        paletteRoles: input.paletteRoles,
        conceptualBrief: input.furnaceBrief.designDirection,
      });
      verification = v;
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(
        `[generate-design] verifier failed (fail-soft): ${msg}. Design persists; verification unset.`,
      );
    }
  }

  return {
    promptUsed,
    gptImage2ResponseId: imageResult.responseId,
    flatArtworkUrl: uploadResult.optimizedUrl,
    cloudinaryPublicId: uploadResult.publicId,
    backArtworkUrl,
    backCloudinaryPublicId,
    backPromptUsed,
    widthPx: imageResult.widthPx,
    heightPx: imageResult.heightPx,
    costUsd: imageResult.costUsd,
    durationMs: imageResult.durationMs,
    verification,
  };
}
