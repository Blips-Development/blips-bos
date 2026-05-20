/**
 * Phase 11D.5c — BOILER v2 mockup render side-effect.
 *
 * Composites a design version's flat artwork onto the configured garment
 * mockup template (Dynamic Mockups), recolored to the chosen garment hex, and
 * persists mockup_renders rows (one per face). Triggered:
 *   - after a design lands (boiler-v2 emits boiler.v2.render-mockup), AND
 *   - when the founder changes the garment colour (the set-colour path re-fires
 *     the event for the new hex) — so each colour gets its own render row.
 *
 * Decoupled from generation (its own function + event) so:
 *   - a slow/failed DM render never sinks the design (the design is real +
 *     persisted BEFORE this fires), and
 *   - each face render gets its OWN Vercel function-timeout budget (the same
 *     60s lesson that bit front + back image-gen in a single step).
 *
 * Idempotent on (design_version_id, colorway_hex, face) — re-rendering the same
 * version+colour+face overwrites the row (mockup_renders_unique constraint).
 */

import { and, eq, inArray, sql } from "drizzle-orm";
import { inngest } from "@/lib/inngest/client";
import { db } from "@/db";
import { designVersions, mockupRenders, configEngineRoom } from "@/db/schema";
import { renderComposite } from "@/lib/dynamic-mockups/client";
import { uploadRemoteImage } from "@/lib/cloudinary";

interface ResolvedTemplate {
  templateUuid: string;
  smartObjectUuid: string;
  /** "Center" chest preset — auto-positions the design. */
  printAreaPresetUuid: string | null;
}

/** Strip Cloudinary's /f_auto,q_auto/ transform — DM fetches the asset
 *  server-side and should get the plain PNG, not a content-negotiated WebP. */
function toRawCloudinaryUrl(url: string): string {
  return url.replace("/f_auto,q_auto/", "/");
}

/**
 * Read the configured tee mockup template (org-scoped). Prefers the canonical
 * `boiler_mockup_templates` (silhouettes.tee-classic → flat_lay then on_model)
 * and falls back to the flat `boiler_mockup_template`. Returns null if neither
 * is seeded or no smart object is present.
 */
async function resolveTemplate(orgId: string): Promise<ResolvedTemplate | null> {
  const rows = await db
    .select({ key: configEngineRoom.key, value: configEngineRoom.value })
    .from(configEngineRoom)
    .where(
      and(
        eq(configEngineRoom.orgId, orgId),
        inArray(configEngineRoom.key, [
          "boiler_mockup_templates",
          "boiler_mockup_template",
        ]),
      ),
    );

  const byKey = new Map(rows.map((r) => [r.key, r.value as unknown]));

  type Choice = {
    template_uuid?: string;
    smart_objects?: Array<{
      uuid?: string;
      print_area_presets?: Array<{ uuid?: string }>;
    }>;
  };

  // Canonical plural shape: silhouettes['tee-classic'].(flat_lay ?? on_model)
  const plural = byKey.get("boiler_mockup_templates") as
    | { silhouettes?: Record<string, { flat_lay?: Choice; on_model?: Choice }> }
    | undefined;
  const tee = plural?.silhouettes?.["tee-classic"];
  const fromPlural = tee?.flat_lay ?? tee?.on_model;

  // Flat singular fallback.
  const singular = byKey.get("boiler_mockup_template") as Choice | undefined;

  const choice = fromPlural ?? singular;
  const templateUuid = choice?.template_uuid;
  const smartObject = choice?.smart_objects?.[0];
  const smartObjectUuid = smartObject?.uuid;
  if (!templateUuid || !smartObjectUuid) return null;
  return {
    templateUuid,
    smartObjectUuid,
    printAreaPresetUuid: smartObject?.print_area_presets?.[0]?.uuid ?? null,
  };
}

export const boilerV2RenderMockup = inngest.createFunction(
  {
    id: "boiler-v2-render-mockup",
    triggers: [{ event: "boiler.v2.render-mockup" }],
    // DM render credits are finite; cap per-org so a colour-picker spammer
    // can't burn the render budget.
    concurrency: { limit: 3, key: "event.data.orgId" },
  },
  async ({ event, step }) => {
    const { orgId, designVersionId, colorwayHex } = event.data;

    // ─── Prepare: load the version + resolve the template ────────────
    const prep = await step.run("prepare-mockup", async () => {
      const [version] = await db
        .select({
          flat: designVersions.flatArtworkUrl,
          back: designVersions.backArtworkUrl,
        })
        .from(designVersions)
        .where(
          and(
            eq(designVersions.id, designVersionId),
            eq(designVersions.orgId, orgId),
          ),
        )
        .limit(1);

      if (!version?.flat) {
        console.warn(
          `[BOILER v2 mockup] no flat artwork on version ${designVersionId}; skipping`,
        );
        return null;
      }

      const template = await resolveTemplate(orgId);
      if (!template) {
        console.warn(
          `[BOILER v2 mockup] no mockup template configured for org ${orgId}; skipping`,
        );
        return null;
      }

      return {
        frontUrl: version.flat,
        templateUuid: template.templateUuid,
        smartObjectUuid: template.smartObjectUuid,
        printAreaPresetUuid: template.printAreaPresetUuid,
      };
    });

    if (!prep) {
      return { rendered: 0, reason: "no-artwork-or-template" };
    }

    // ─── Render one face: composite → Cloudinary → upsert row ────────
    // Each face is its own step (own 60s budget) + fail-soft so one face
    // failing doesn't lose the other.
    const renderFace = async (
      face: "front" | "back",
      assetUrl: string,
    ): Promise<boolean> => {
      return step.run(`render-${face}`, async () => {
        try {
          const dm = await renderComposite({
            mockup_uuid: prep.templateUuid,
            smart_objects: [
              {
                uuid: prep.smartObjectUuid,
                asset: [
                  {
                    url: toRawCloudinaryUrl(assetUrl),
                    fit: "contain",
                    ...(prep.printAreaPresetUuid && {
                      print_area_preset_uuid: prep.printAreaPresetUuid,
                    }),
                  },
                ],
                color: colorwayHex,
              },
            ],
          });
          const renderUrl = dm.data?.export_path;
          if (!renderUrl) {
            console.warn(
              `[BOILER v2 mockup] DM returned no url for ${face} (version ${designVersionId})`,
            );
            return false;
          }

          const up = await uploadRemoteImage(renderUrl, {
            folder: `blips/boiler-v2-mockups/${designVersionId}`,
            publicIdHint: `${colorwayHex.replace(/[^a-z0-9]/gi, "")}-${face}`,
            overwrite: true,
          });

          await db
            .insert(mockupRenders)
            .values({
              orgId,
              designVersionId,
              colorwayHex,
              face,
              renderer: "dynamic_mockups",
              templateUuid: prep.templateUuid,
              smartObjectUuid: prep.smartObjectUuid,
              cloudinaryUrl: up.optimizedUrl,
              cloudinaryPublicId: up.publicId,
              widthPx: up.width,
              heightPx: up.height,
            })
            .onConflictDoUpdate({
              target: [
                mockupRenders.designVersionId,
                mockupRenders.colorwayHex,
                mockupRenders.face,
              ],
              set: {
                renderer: "dynamic_mockups",
                templateUuid: prep.templateUuid,
                smartObjectUuid: prep.smartObjectUuid,
                cloudinaryUrl: up.optimizedUrl,
                cloudinaryPublicId: up.publicId,
                widthPx: up.width,
                heightPx: up.height,
                renderedAt: sql`NOW()`,
              },
            });
          return true;
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          console.warn(
            `[BOILER v2 mockup] ${face} render failed (fail-soft): ${msg}`,
          );
          return false;
        }
      });
    };

    // The configured template exposes a single front-facing print zone, so we
    // composite the FRONT design onto it. Mocking the BACK design on-garment
    // needs a separate back-view template (add via the DM dashboard); until
    // then the workspace shows the back design as flat art.
    const frontOk = await renderFace("front", prep.frontUrl);

    return {
      rendered: frontOk ? 1 : 0,
      colorwayHex,
      designVersionId,
    };
  },
);
