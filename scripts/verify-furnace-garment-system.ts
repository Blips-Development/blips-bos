/**
 * PR-A verify — does the upgraded FURNACE skill (garment-design system) produce
 * valid, varied, anti-literal briefs through its PRODUCTION Zod schema?
 *
 * Critical de-risk: the new schema adds nested frontLayout/backLayout arrays +
 * garmentStructure/dominantSystem enums. Gemini's structured-output mode has
 * historically choked on complex schemas (see furnace.ts refusal-refinement
 * note). This confirms the production schema round-trips cleanly + the new
 * fields populate with real variety (no grid-monotony, anti-literal holds,
 * structure decision varies per signal).
 *
 * Mirrors the validated harness (research/garment-system/_validation) but uses
 * the REAL furnaceSkill schema + prompt, not a hand-written copy.
 *
 * Usage: npx tsx scripts/verify-furnace-garment-system.ts
 * Cost: ~3 Gemini 2.5 Pro calls (~$0.01). Falls back to flash on 503.
 */
import { existsSync, readFileSync } from "node:fs";

if (existsSync(".env.local")) {
  const env = readFileSync(".env.local", "utf-8");
  for (const line of env.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq === -1) continue;
    const k = t.slice(0, eq).trim();
    const v = t.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    if (!process.env[k]) process.env[k] = v;
  }
}

interface Check {
  name: string;
  pass: boolean;
  detail: string;
}

const SIGNALS = [
  {
    code: "FLUENT-RCL",
    expectStructure: "front_back_narrative",
    input: {
      framingHook: "Native in corporate.",
      tensionAxis:
        "The assimilation cost of professional success — fluency in a culture that overwrote the one you came from.",
      narrativeAngle:
        "RCL professionals become native speakers of corporate culture; the original self persists underneath. Two beats: the corporate self on the surface, the original self underneath.",
      decade: "RCL" as const,
      shortcode: "FLUENT-RCL",
      workingTitle: "Fluent in a language your parents never taught you.",
    },
  },
  {
    code: "GRAYHAIR-RCK",
    expectStructure: "front_led_solid_back",
    input: {
      framingHook: "Let it stay.",
      tensionAxis: "A single quiet acceptance of aging — a small surrender that is also a small peace.",
      narrativeAngle:
        "The first gray hair you do not pull. One moment, one statement — not a two-beat story.",
      decade: "RCK" as const,
      shortcode: "GRAYHAIR-RCK",
      workingTitle: "First gray hair you didn't pull.",
    },
  },
  {
    code: "CLIMB-RCK",
    expectStructure: null, // any structure ok; we mainly check dominantSystem != grid here
    input: {
      framingHook: "No top.",
      tensionAxis: "The career climb that never resolves — you keep ascending and there is no summit.",
      narrativeAngle: "Endless ascent; the climb was supposed to lead somewhere and doesn't.",
      decade: "RCK" as const,
      shortcode: "CLIMB-RCK",
      workingTitle: "The climb with no top.",
    },
  },
];

async function main() {
  const checks: Check[] = [];
  const rec = (name: string, pass: boolean, detail: string) => {
    checks.push({ name, pass, detail });
    console.log(`  ${pass ? "✓" : "✗"} ${name} — ${detail}`);
  };

  const { furnaceSkill } = await import("../src/skills/furnace");
  const { generateObject, NoObjectGeneratedError } = await import("ai");
  const { google } = await import("@ai-sdk/google");

  const dominantSystems: string[] = [];
  const structures: string[] = [];
  const textureStrategies: string[] = [];

  for (const sig of SIGNALS) {
    console.log(`\n== ${sig.code} ==`);
    const input = {
      signalId: "00000000-0000-0000-0000-000000000000",
      shortcode: sig.input.shortcode,
      workingTitle: sig.input.workingTitle,
      concept: sig.input.narrativeAngle,
      manifestationDecade: sig.input.decade,
      parentSignalId: "00000000-0000-0000-0000-000000000001",
      parentShortcode: sig.code.split("-")[0],
      manifestation: {
        framingHook: sig.input.framingHook,
        tensionAxis: sig.input.tensionAxis,
        narrativeAngle: sig.input.narrativeAngle,
        dimensionAlignment: {
          social: "", musical: "", cultural: "", career: "",
          responsibilities: "", expectations: "", sports: "",
        },
      },
      knowledgeContext: { decadePlaybook: "", brandIdentity: "", materialsVocabulary: "" },
      pastBriefsForDecade: [],
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const prompt = furnaceSkill.buildPrompt(input as any);
    let obj: Record<string, unknown> | null = null;
    let lastReason = "unknown";
    for (const model of ["gemini-2.5-pro", "gemini-2.5-flash"]) {
      try {
        const r = await generateObject({
          model: google(model),
          schema: furnaceSkill.outputSchema,
          system: furnaceSkill.systemPrompt,
          prompt,
          temperature: 0.5,
        });
        obj = r.object as Record<string, unknown>;
        console.log(`  (model: ${model})`);
        break;
      } catch (e) {
        // Surface the REAL cause, not just "did not match schema". When the model
        // returned valid JSON that failed Zod (e.g. a field over its char cap),
        // re-run safeParse on the raw text to print the exact field + issue —
        // a 503 and a character-overrun are NOT the same failure (the May 30
        // richness diagnosis turned on exactly this distinction).
        let reason = e instanceof Error ? e.message.slice(0, 80) : String(e);
        if (NoObjectGeneratedError.isInstance(e) && e.text) {
          try {
            const z = furnaceSkill.outputSchema.safeParse(JSON.parse(e.text));
            if (!z.success) {
              reason =
                "schema-fail: " +
                z.error.issues
                  .map((i) => `[${i.path.join(".")}] ${i.code}`)
                  .join("; ");
            }
          } catch {
            reason = "model returned non-JSON text";
          }
        }
        lastReason = reason;
        console.log(`  ${model} failed: ${reason} — trying next`);
      }
    }

    if (!obj) {
      rec(`${sig.code} schema round-trip`, false, lastReason);
      continue;
    }
    rec(`${sig.code} schema round-trip`, true, "valid object returned");

    const refused = obj.refused === true;
    if (refused) {
      rec(`${sig.code} not refused`, false, "FURNACE refused a valid signal");
      continue;
    }
    const gs = obj.garmentStructure as string | null;
    const ds = obj.dominantSystem as string | null;
    const fl = (obj.frontLayout as string | null) ?? "";
    const flSegs = fl.split("|").map((s) => s.trim()).filter(Boolean);
    structures.push(gs ?? "null");
    dominantSystems.push(ds ?? "null");

    rec(`${sig.code} garmentStructure populated`, !!gs, gs ?? "MISSING");
    if (sig.expectStructure) {
      rec(`${sig.code} structure = ${sig.expectStructure}`, gs === sig.expectStructure, `got ${gs}`);
    }
    rec(`${sig.code} dominantSystem populated`, !!ds, ds ?? "MISSING");
    rec(
      `${sig.code} frontLayout multi-element (3+ segments)`,
      flSegs.length >= 3,
      `${flSegs.length} elements`,
    );
    // anti-literal: no face/person/hand in any layout element text
    const layoutText = `${obj.frontLayout ?? ""} ${obj.backLayout ?? ""}`.toLowerCase();
    const literal = /\b(face|person|people|human|hand|body|portrait)\b/.test(layoutText);
    rec(`${sig.code} anti-literal (no figures in layout)`, !literal, literal ? "LITERAL LEAK" : "clean");

    // Richness treatment (May 22) — the 4 treatment fields must populate with
    // valid enum values (confirms the schema addition didn't break Gemini AND
    // that FURNACE is actually choosing treatments).
    const tex = obj.textureStrategy as string | null;
    const depth = obj.depthStrategy as string | null;
    const color = obj.colorStrategy as string | null;
    const comp = obj.compositionStance as string | null;
    const TEX = ["flat_clean", "halftone_gradient", "ink_grain_distress", "overprint_blend", "tonal_density"];
    const DEPTH = ["single_plane", "layered_fg_bg", "scale_contrast_hero"];
    const COLOR = ["monochrome", "duotone_accent", "tonal_range"];
    const COMP = ["centered_iconic", "asymmetric_tension", "full_bleed_immersive"];
    rec(`${sig.code} textureStrategy valid`, !!tex && TEX.includes(tex), tex ?? "MISSING");
    rec(`${sig.code} depthStrategy valid`, !!depth && DEPTH.includes(depth), depth ?? "MISSING");
    rec(`${sig.code} colorStrategy valid`, !!color && COLOR.includes(color), color ?? "MISSING");
    rec(`${sig.code} compositionStance valid`, !!comp && COMP.includes(comp), comp ?? "MISSING");
    textureStrategies.push(tex ?? "null");
  }

  // cross-signal variety
  console.log("\n== variety ==");
  const uniqSystems = new Set(dominantSystems.filter((s) => s !== "null"));
  rec(
    "dominantSystem varies across signals",
    uniqSystems.size >= 2,
    `systems: [${dominantSystems.join(", ")}]`,
  );
  rec(
    "not all grids",
    !dominantSystems.every((s) => s === "grid"),
    `[${dominantSystems.join(", ")}]`,
  );
  rec(
    "structure varies (narrative + non-narrative both appear)",
    new Set(structures.filter((s) => s !== "null")).size >= 2,
    `structures: [${structures.join(", ")}]`,
  );

  const passed = checks.filter((c) => c.pass).length;
  console.log(`\n[verify-furnace-garment-system] ${passed}/${checks.length} checks passed\n`);
  process.exit(passed === checks.length ? 0 : 1);
}

main().catch((e) => {
  console.error("crashed:", e);
  process.exit(2);
});
