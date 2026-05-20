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
  const { generateObject } = await import("ai");
  const { google } = await import("@ai-sdk/google");

  const dominantSystems: string[] = [];
  const structures: string[] = [];

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
        const msg = e instanceof Error ? e.message : String(e);
        console.log(`  ${model} failed: ${msg.slice(0, 80)} — trying next`);
      }
    }

    if (!obj) {
      rec(`${sig.code} schema round-trip`, false, "all models failed (likely 503 — re-run)");
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
