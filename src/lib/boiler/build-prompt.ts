/**
 * Phase 11D — BOILER v2 prompt construction.
 *
 * Pure function. Takes a FURNACE brief + locked palette roles + composition meta
 * + (optional) refinement instruction and produces a single gpt-image-2 prompt
 * string. No LLM call here — the prompt is deterministic given the inputs.
 *
 * Why pure: easy to unit-test, easy to audit, easy to show the founder the
 * actual prompt that produced a design (persisted as design_versions.prompt_used).
 *
 * The output prompt structure is one coherent description, not a templated
 * variable substitution. Structure mirrors the BLIPS-DESIGN-CALIBRATION.md
 * anchor (PAPER-RCK) — six explicit dimensions: garment, composition, elements,
 * palette, typography, print spec.
 *
 * Refinement chains: when input.refinementInstruction + input.parent are set,
 * the prompt is much terser (focuses on the change, not the full brief) because
 * gpt-image-2 sees the previous version via `previous_response_id`. This is how
 * "tighten the type column, push the square down" stays a 1-line refinement
 * rather than a re-statement of the whole design.
 */

import type {
  GenerateDesignInput,
  PaletteRoles,
  CompositionMeta,
} from "./types";

/** Build the gpt-image-2 prompt for a fresh generation (no parent). */
function buildFreshPrompt(input: GenerateDesignInput): string {
  const { context, furnaceBrief, paletteRoles, compositionMeta } = input;
  const { decadePlaybook, brandIdentity, materialsVocabulary, fashionSkills } =
    input.knowledgeContext ?? {};

  const knowledge = (label: string, body: string | undefined): string => {
    const trimmed = (body ?? "").trim();
    return trimmed.length > 0 ? `\n${label}\n${trimmed}\n` : "";
  };

  // Phase 11D schema upgrade — when FURNACE populated the 6 spec fields,
  // they take precedence over prose. Build a binding spec block FIRST, then
  // demote the prose to "editorial context only".
  const specBlock = formatDesignSpec(furnaceBrief, paletteRoles);
  const hasSpec = specBlock.length > 0;

  return [
    `Design a single-piece BLIPS flat artwork (transparent background, ready for print) for the following manifestation. This is a PREMIUM APPAREL DESIGN — multi-element composition with conceptual logic, NOT a wordmark on a solid tee.`,
    ``,
    `## MANIFESTATION`,
    `Shortcode: ${context.shortcode}`,
    `Decade: ${context.manifestationDecade} · Season: ${context.season}`,
    `Framing hook: ${context.framingHook}`,
    ``,
    // ─── BINDING DESIGN SPEC (when populated by upgraded FURNACE) ───
    ...(hasSpec
      ? [
          `## DESIGN SPECIFICATION — BINDING (this section OVERRIDES any ambiguity in the editorial prose below)`,
          ``,
          `These are the exact instructions BOILER assembled from the FURNACE machine-readable spec fields. If the prose below CONFLICTS with anything here, follow this section.`,
          ``,
          specBlock,
          ``,
        ]
      : []),
    `## EDITORIAL CONTEXT (from FURNACE brief — direction + rationale; the BINDING SPEC above is what to render)`,
    `Brand-fit score: ${furnaceBrief.brandFitScore}/100`,
    `Brand-fit rationale: ${furnaceBrief.brandFitRationale}`,
    ``,
    `Design direction: ${furnaceBrief.designDirection}`,
    `Tactile intent: ${furnaceBrief.tactileIntent}`,
    `Mood + tone: ${furnaceBrief.moodAndTone}`,
    `Composition approach: ${furnaceBrief.compositionApproach}`,
    `Color treatment: ${furnaceBrief.colorTreatment}`,
    `Typographic treatment: ${furnaceBrief.typographicTreatment}`,
    `Art direction: ${furnaceBrief.artDirection}`,
    `Reference anchors: ${furnaceBrief.referenceAnchors}`,
    `Placement intent: ${furnaceBrief.placementIntent}`,
    `Voice in visual: ${furnaceBrief.voiceInVisual}`,
    ...(furnaceBrief.addenda.length > 0
      ? [
          ``,
          `## ADDENDA (founder-added direction)`,
          ...furnaceBrief.addenda.map(
            (a) => `- ${a.label}: ${a.content}`,
          ),
        ]
      : []),
    ``,
    // ─── Fall-back palette (only emitted when spec didn't supply colorPalette) ───
    ...(hasSpec && furnaceBrief.colorPalette
      ? []
      : [
          `## LOCKED PALETTE — use these hex codes exactly, in their stated roles`,
          `Garment base: ${paletteRoles.garment_base}`,
          `Ring outer / outermost graphic element: ${paletteRoles.ring_outer}`,
          `Ring inner / inner glow / accent: ${paletteRoles.ring_inner}`,
          `Front ink (front-face text + foreground): ${paletteRoles.front_ink}`,
          `Back ink (back-face text + accent): ${paletteRoles.back_ink}`,
          ``,
        ]),
    `## COMPOSITION META`,
    formatCompositionMeta(compositionMeta),
    ``,
    `## CRITICAL RENDERING RULES (do NOT violate)`,
    // Schema-upgrade-specific rules — render only when spec is populated
    ...(hasSpec
      ? [
          `- TEXT RENDERING: Render ONLY the text specified in the BINDING SPEC's "Text content" subsection. Do NOT invent additional text labels, captions, UI badges, notification counters, scrolling tickers, or repeated text elements. If the spec says front=null, the front face has NO text.`,
          `- TYPOGRAPHY: Apply the exact font + weight + tracking + orientation from the BINDING SPEC's "Typography" subsection. Do NOT improvise weights or layouts.`,
          `- SMALL TEXT: If you would otherwise render text at small sizes (annotation/caption), STOP. gpt-image-1 cannot render small text reliably — outputs garble into "unreadi $99+" or "OREREMT". Either render the text larger (hero/secondary size) or omit it entirely.`,
          `- REPEATED TEXT: Never render the same text element more than once. No 5 unread badges. No marquee. No stock-ticker rows.`,
          `- PALETTE: Use ONLY the colors listed in the BINDING SPEC's "Color palette" subsection (when present), in their stated roles. Do not introduce additional colors. Do not substitute "close" colors.`,
        ]
      : [
          `- TEXT RENDERING: Render ONLY the text specified in the COMPOSITION META section above. Do NOT invent additional text labels.`,
          `- SMALL TEXT: gpt-image-1 cannot render small text reliably. If text would land at annotation/caption size, render it larger or omit it.`,
        ]),
    `- TRANSPARENT BACKGROUND. The artwork is composited onto a garment template at the mockup stage — do NOT render the tee silhouette, do NOT render a background of any kind. Only the design elements on a transparent canvas.`,
    `- Multi-element composition. NOT typography alone. NOT a centered logo on white. Multiple visual elements composing one conceptual idea.`,
    `- Flat / screen-print-ready aesthetic. No photographic gradients. No halftones unless explicitly specified.`,
    `- The work and the thinking is visible in the design. Someone looking at this should feel that work went into it.`,
    knowledge(`## DECADE PLAYBOOK (${context.manifestationDecade})`, decadePlaybook),
    knowledge(`## BLIPS BRAND IDENTITY`, brandIdentity),
    knowledge(`## MATERIALS VOCABULARY`, materialsVocabulary),
    knowledge(`## FASHION DESIGN + DIGITAL TOOLS PLAYBOOK`, fashionSkills),
  ]
    .filter((line) => line !== "")
    .join("\n");
}

/**
 * Render FURNACE's 6 machine-readable spec fields (Phase 11D schema upgrade)
 * as a single binding spec block for the BOILER prompt.
 *
 * Returns "" when no spec fields are populated (old briefs pre-upgrade) — the
 * caller treats empty as "no binding spec; fall back to prose direction".
 *
 * Order within the spec mirrors render priority — text content first (because
 * gpt-image-1's text-rendering failures are the #1 cause of bad BLIPS output),
 * then typography, palette, composition logic, print method, full-garment bleed.
 */
function formatDesignSpec(
  brief: GenerateDesignInput["furnaceBrief"],
  fallbackPalette: PaletteRoles,
): string {
  const parts: string[] = [];

  // 1. Text content — the single highest-leverage spec field. Misrendering
  // text is the most common BOILER failure mode (gpt-image-1 fine-text limit).
  if (brief.exactText) {
    const t = brief.exactText;
    const surfaceLines: string[] = [];
    const addLine = (key: string, label: string) => {
      const v = (t as Record<string, string | null>)[key];
      if (v === undefined) return;
      if (v === null || v === "") {
        surfaceLines.push(`- ${label}: (no text on this surface — render no text here)`);
      } else {
        surfaceLines.push(`- ${label}: "${v}"`);
      }
    };
    addLine("front", "Front");
    addLine("back", "Back");
    addLine("sleeve_left", "Left sleeve");
    addLine("sleeve_right", "Right sleeve");
    addLine("hem", "Hem");
    addLine("inside_print", "Inside print");
    if (surfaceLines.length > 0) {
      parts.push(`### Text content (render EXACTLY as written — no extra text, no labels, no badges)\n${surfaceLines.join("\n")}`);
    }
  }

  // 2. Typography — how each text element is rendered. Aligns 1:1 with the
  // text content above (or should — orphan typography is a FURNACE bug).
  if (brief.typographySpec && brief.typographySpec.length > 0) {
    const lines = brief.typographySpec.map((spec, i) => {
      return `${i + 1}. surface=${spec.surface} · content="${spec.content}" · font=${spec.font} · weight=${spec.weight} · tracking=${spec.tracking} · orientation=${spec.orientation} · size=${spec.size_hint}`;
    });
    parts.push(`### Typography (render each text element per these explicit specs — do NOT improvise weights or layouts)\n${lines.join("\n")}`);
  } else if (brief.exactText) {
    // Spec gave us text but no typography — surface a soft warning to the
    // model so it knows to fall back to brand defaults (Syne 700, tight).
    parts.push(`### Typography\n(typographySpec not provided — render any text in Syne 700, tight tracking, horizontal, hero size as the safe default)`);
  }

  // 3. Color palette — full set of colors with role + name + hex. When present,
  // this overrides the 5-role PaletteRoles fallback.
  if (brief.colorPalette && brief.colorPalette.length > 0) {
    const lines = brief.colorPalette.map(
      (c) => `- role=${c.role} · ${c.name} ${c.hex}`,
    );
    parts.push(`### Color palette (use ONLY these hex codes in their stated roles — do not substitute close colors, do not introduce additional colors)\n${lines.join("\n")}`);
  } else if (brief.exactText || brief.typographySpec || brief.compositionRules) {
    // Partial spec — fill in palette from PaletteRoles fallback so the binding
    // block still has a complete color story.
    parts.push(`### Color palette (from active PaletteRoles — fallback because FURNACE didn't supply colorPalette)\n- role=garment_base · ${fallbackPalette.garment_base}\n- role=ring_outer · ${fallbackPalette.ring_outer}\n- role=ring_inner · ${fallbackPalette.ring_inner}\n- role=front_ink · ${fallbackPalette.front_ink}\n- role=back_ink · ${fallbackPalette.back_ink}`);
  }

  // 4. Composition logic — the conceptual punchline of the layout.
  if (brief.compositionRules) {
    parts.push(`### Composition logic (the conceptual + spatial rule — the design's "punchline"; preserve this exactly)\n${brief.compositionRules}`);
  }

  // 5. Print method — what's renderable + what isn't (screen vs DTG vs etc).
  if (brief.printSeparationStrategy) {
    const p = brief.printSeparationStrategy;
    const lines = [
      `- technique: ${p.technique}`,
      `- separations: ${p.separations}`,
      `- per-separation: ${p.perSeparation.map((s, i) => `(${i + 1}) ${s}`).join(" · ")}`,
      `- base interaction: ${p.baseColorInteraction}`,
    ];
    parts.push(`### Print method (decided at design time — affects what's renderable)\n${lines.join("\n")}\nRender consistent with the technique: screen = flat solid inks, no photographic gradients, no halftones. DTG = full-color photographic OK. discharge = soft hand-feel, garment-base color comes through.`);
  }

  // 6. Full-garment treatment — whether the design extends beyond the centered
  // print zone. When enabled, gpt-image-1 should render full-canvas, not
  // centered-icon-on-white.
  if (brief.fullGarmentTreatment) {
    const f = brief.fullGarmentTreatment;
    if (f.enabled) {
      parts.push(`### Full-garment bleed (enabled)\nThe design extends beyond the centered print zone, bleeding off these edges: ${f.bleed_zones.join(", ")}. The outermost design elements at these edges should FADE into transparency (no hard boundary, no terminating edge). This is a full-canvas composition, NOT a centered-icon-on-white layout.`);
    } else {
      parts.push(`### Full-garment bleed (disabled)\nCentered/anchored composition within a standard print box. Design elements stop within the print area; no bleed off edges.`);
    }
  }

  return parts.join("\n\n");
}

/** Build the gpt-image-2 prompt for a refinement (chained from parent). */
function buildRefinementPrompt(input: GenerateDesignInput): string {
  const { paletteRoles, compositionMeta, refinementInstruction } = input;
  if (!refinementInstruction) {
    throw new Error(
      "[boiler] buildRefinementPrompt called without refinementInstruction",
    );
  }

  // gpt-image-2 sees the previous design via previous_response_id, so this prompt
  // is much terser — focuses on what to change, not what to keep.
  return [
    `Refine the previous BLIPS design with the following adjustment. Keep EVERYTHING ELSE unchanged — palette roles, composition, typography, placement.`,
    ``,
    `## ADJUSTMENT`,
    refinementInstruction,
    ``,
    `## INVARIANTS (these stay locked)`,
    `Garment base: ${paletteRoles.garment_base}`,
    `Ring outer: ${paletteRoles.ring_outer}`,
    `Ring inner: ${paletteRoles.ring_inner}`,
    `Front ink: ${paletteRoles.front_ink}`,
    `Back ink: ${paletteRoles.back_ink}`,
    ``,
    formatCompositionMeta(compositionMeta),
    ``,
    `Output remains: single-piece flat artwork, transparent background, multi-element composition. Apply only the requested adjustment.`,
  ].join("\n");
}

/** Build the gpt-image-2 prompt for branching (fork from older parent, no instruction). */
function buildBranchPrompt(input: GenerateDesignInput): string {
  const { paletteRoles, compositionMeta } = input;

  // Branching: re-emit the locked invariants without the refinement instruction.
  // gpt-image-2 sees the parent version via previous_response_id and produces
  // a parallel design at the same parameters. Useful when the founder wants
  // an alternative direction from an earlier version.
  return [
    `Produce an alternative variation of the previous BLIPS design. Same palette, same composition rules, same typography spec — but explore a different sub-arrangement of the elements within those constraints. This is a parallel exploration, NOT a refinement.`,
    ``,
    `## LOCKED PALETTE`,
    `Garment base: ${paletteRoles.garment_base}`,
    `Ring outer: ${paletteRoles.ring_outer}`,
    `Ring inner: ${paletteRoles.ring_inner}`,
    `Front ink: ${paletteRoles.front_ink}`,
    `Back ink: ${paletteRoles.back_ink}`,
    ``,
    formatCompositionMeta(compositionMeta),
    ``,
    `Output: single-piece flat artwork, transparent background, multi-element composition.`,
  ].join("\n");
}

/** Render the composition_meta JSONB as a prompt-friendly description. */
function formatCompositionMeta(meta: CompositionMeta): string {
  const parts: string[] = [];

  if (meta.exact_text) {
    const t = meta.exact_text;
    const lines = [
      t.front ? `  Front: "${t.front}"` : null,
      t.back ? `  Back: "${t.back}"` : null,
    ].filter(Boolean);
    if (lines.length > 0) {
      parts.push(`Exact text content:\n${lines.join("\n")}`);
    }
  }

  if (meta.typography) {
    const t = meta.typography;
    const lines = [
      t.front_weight !== undefined
        ? `  Front weight: ${t.front_weight}${
            t.front_tracking ? `, tracking: ${t.front_tracking}` : ""
          }`
        : null,
      t.back_weight !== undefined
        ? `  Back weight: ${t.back_weight}${
            t.back_tracking ? `, tracking: ${t.back_tracking}` : ""
          }`
        : null,
    ].filter(Boolean);
    if (lines.length > 0) {
      parts.push(`Typography spec:\n${lines.join("\n")}`);
    }
  }

  if (meta.composition_rules) {
    const rules = Object.entries(meta.composition_rules)
      .map(([k, v]) => `  ${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`)
      .join("\n");
    if (rules.length > 0) {
      parts.push(`Composition rules:\n${rules}`);
    }
  }

  if (meta.print_spec) {
    const p = meta.print_spec;
    const lines = [
      p.method ? `  Print method: ${p.method}` : null,
      p.separations !== undefined ? `  Color separations: ${p.separations}` : null,
      p.halftones !== undefined ? `  Halftones: ${p.halftones ? "yes" : "no"}` : null,
      p.full_bleed !== undefined
        ? `  Full bleed: ${p.full_bleed ? "yes — design extends off all edges" : "no — anchored composition"}`
        : null,
    ].filter(Boolean);
    if (lines.length > 0) {
      parts.push(`Print spec:\n${lines.join("\n")}`);
    }
  }

  return parts.join("\n");
}

/**
 * PR-B (May 20, 2026) — the validated garment-system assembler.
 *
 * When FURNACE (PR-A) supplies the garment-design-system fields (frontLayout +
 * dominantSystem + garmentStructure), BOILER assembles the FRONT-face prompt in
 * the format proven in the autonomous-loop research (research/garment-system/)
 * that produced the founder-approved output: a hard anti-literal + flat + two-ink
 * preamble, then the element-by-element wiring diagram, the color palette, and
 * the single exact front phrase as INTEGRATED typography (not a caption).
 *
 * This is a mechanical wrap — all design intelligence lives in FURNACE's brief.
 * Deterministic given the inputs (easy to audit, persisted as prompt_used).
 */
/**
 * Richness treatment (May 22, 2026) — translate FURNACE's per-signal treatment
 * choices into concrete prompt directives. This is what lifts a clean-but-flat
 * design to "rich". Returns [] for pre-richness briefs (backward compatible).
 * Texture here is FLAT screen-print craft (halftone/grain/overprint), never 3D.
 */
function richnessDirectives(fb: GenerateDesignInput["furnaceBrief"]): string[] {
  const lines: string[] = [];
  const texMap: Record<string, string> = {
    flat_clean:
      "TEXTURE: flat solid inks, crisp hard edges, no halftone/grain — restraint is the intent.",
    halftone_gradient:
      "TEXTURE: halftone dot-screen gradients for tonal depth (flat screen-print halftones, NEVER photographic gradients).",
    ink_grain_distress:
      "TEXTURE: subtle ink grain + lightly distressed/eroded edges — the tactile hand of real screen-print. Still flat (texture, not 3D).",
    overprint_blend:
      "TEXTURE: where forms overlap, inks visibly MULTIPLY into a third tone (overprint), as in 2-colour screen printing.",
    tonal_density:
      "TEXTURE: build tonal density across the field — sparse in one region, dense in another — weight through element density, not shading.",
  };
  const depthMap: Record<string, string> = {
    single_plane: "DEPTH: a single flat plane, restrained.",
    layered_fg_bg:
      "DEPTH: distinct planes — a background field, a midground system, a foreground focal element — layered so the eye reads depth.",
    scale_contrast_hero:
      "DEPTH: strong scale contrast — one dominant hero element against fine, small secondary detail.",
  };
  const colorMap: Record<string, string> = {
    monochrome: "COLOUR: monochrome — one ink on the garment base.",
    duotone_accent:
      "COLOUR: base ink + ONE accent colour used sparingly, only where it earns emphasis.",
    tonal_range:
      "COLOUR: a tonal ladder of a single hue via halftone — reads rich while staying few-ink.",
  };
  const compMap: Record<string, string> = {
    centered_iconic: "COMPOSITION: centered, iconic, badge-like.",
    asymmetric_tension:
      "COMPOSITION: asymmetric — off-axis weight, intentional negative space, dynamic tension.",
    full_bleed_immersive:
      "COMPOSITION: full-bleed immersive — elements run off the edges of the print area, no tidy margins.",
  };
  if (fb.textureStrategy && texMap[fb.textureStrategy]) lines.push(`- ${texMap[fb.textureStrategy]}`);
  if (fb.depthStrategy && depthMap[fb.depthStrategy]) lines.push(`- ${depthMap[fb.depthStrategy]}`);
  if (fb.colorStrategy && colorMap[fb.colorStrategy]) lines.push(`- ${colorMap[fb.colorStrategy]}`);
  if (fb.compositionStance && compMap[fb.compositionStance]) lines.push(`- ${compMap[fb.compositionStance]}`);
  return lines;
}

function buildGarmentSystemFrontPrompt(input: GenerateDesignInput): string {
  const { context, furnaceBrief } = input;
  // frontLayout is a prose wiring diagram, " | "-separated (one element per segment).
  const flSegments = (furnaceBrief.frontLayout ?? "")
    .split("|")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const palette = furnaceBrief.colorPalette ?? [];
  const frontPhrase = furnaceBrief.exactText?.front?.trim() || context.framingHook;

  const paletteLines =
    palette.length > 0
      ? palette.map((c) => `- ${c.role}: ${c.name} ${c.hex}`)
      : [
          `- garment_base: ${input.paletteRoles.garment_base}`,
          `- primary_ink: ${input.paletteRoles.front_ink}`,
          `- accent_ink: ${input.paletteRoles.ring_inner}`,
        ];

  const layoutLines = flSegments.map((seg, i) => `${i + 1}. ${seg}`);

  return [
    `Flat artwork for a premium philosophical-apparel t-shirt, transparent background, ready for screen print. FRONT face.`,
    ``,
    `=== ABSOLUTE CONSTRAINTS ===`,
    `- ABSTRACT CONCEPTUAL DESIGN, NOT illustration. NO human figures, faces, people, bodies, hands. NO literal depiction of the concept's subject. ONLY abstract geometric vocabulary: lines, bars, arrows, points, ticks, arcs, rings, grids, geometric primitives.`,
    `- FLAT screen-print aesthetic. NO 3D shading, NO perspective, NO photographic/CGI rendering. Flat does NOT mean bare — screen-print TEXTURE (halftones, ink grain, overprint) is encouraged per the RICHNESS TREATMENT below. Respect the palette's ink count.`,
    `- TEXT: render ONLY this exact phrase, SPELLED CHARACTER-FOR-CHARACTER, as integrated typography woven INTO the composition (a structural element, NOT a caption parked in empty space): "${frontPhrase}". Do NOT invent, drop, reorder, or alter any letters; render it large enough to be perfectly legible. Render NO other words, labels, wordmarks, or captions.`,
    `=== END CONSTRAINTS ===`,
    ``,
    `## MANIFESTATION`,
    `Shortcode: ${context.shortcode} · Decade: ${context.manifestationDecade} · Season: ${context.season}`,
    `Framing hook: ${context.framingHook}`,
    ``,
    `## DOMINANT VISUAL SYSTEM: ${furnaceBrief.dominantSystem ?? "(unspecified)"}`,
    ...(furnaceBrief.systemRationale ? [furnaceBrief.systemRationale] : []),
    ...(furnaceBrief.garmentStructure
      ? [`Garment structure: ${furnaceBrief.garmentStructure}`]
      : []),
    ``,
    `## COLOR PALETTE (use ONLY these hex codes in their stated roles — no substitutions, no extra colors)`,
    ...paletteLines,
    ``,
    `## FRONT LAYOUT — render these elements exactly, at these positions (the wiring diagram)`,
    ...(layoutLines.length > 0
      ? layoutLines
      : [`(no layout supplied — compose a multi-element abstract design in the ${furnaceBrief.dominantSystem ?? "chosen"} system)`]),
    ...(richnessDirectives(furnaceBrief).length > 0
      ? [
          ``,
          `## RICHNESS TREATMENT — how to render (this is what lifts it from clean to premium)`,
          ...richnessDirectives(furnaceBrief),
        ]
      : []),
    ``,
    `## REQUIREMENTS`,
    `- Multi-element composition with conceptual logic — NOT a single icon, NOT minimal, NOT a caption under a graphic.`,
    `- The work and the thinking is visible — someone looking at this should feel it was composed, not generated.`,
    `- Premium, restrained, editorial. Asymmetric where the layout calls for it.`,
    ``,
    `OUTPUT: transparent background, no garment silhouette, no mockup. A single resolved premium flat artwork, the only text being "${frontPhrase}" rendered legibly and integrated into the composition.`,
  ]
    .filter((l) => l !== undefined)
    .join("\n");
}

/**
 * PR-C (May 20, 2026) — does this brief call for a generated BACK face?
 * True for front_back_narrative / colorway_pair with a backLayout present.
 * The back is generated via /edits FROM the front image so the shared
 * visual system stays consistent and only the narrative variable changes
 * (the PAPER-RCK "same ring field, square displaced" move).
 */
export function needsBackFace(furnaceBrief: GenerateDesignInput["furnaceBrief"]): boolean {
  const s = furnaceBrief.garmentStructure;
  return (
    (s === "front_back_narrative" || s === "colorway_pair") &&
    typeof furnaceBrief.backLayout === "string" &&
    furnaceBrief.backLayout.trim().length > 0
  );
}

/**
 * PR-C — the BACK-face prompt. Used with /v1/images/edits, passing the FRONT
 * image as the reference so the back keeps the front's exact system + palette,
 * changing ONLY the narrative variable. Mirrors how PAPER-RCK's back is the
 * same ring field with the square displaced + a ghost trail.
 */
export function buildGarmentSystemBackPrompt(input: GenerateDesignInput): string {
  const { context, furnaceBrief } = input;
  const blSegments = (furnaceBrief.backLayout ?? "")
    .split("|")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const backPhrase = furnaceBrief.exactText?.back?.trim() || "";
  const layoutLines = blSegments.map((seg, i) => `${i + 1}. ${seg}`);

  return [
    `Render the BACK face of a two-beat BLIPS garment design, using the reference image (the FRONT face) as the base.`,
    ``,
    `=== ABSOLUTE CONSTRAINTS ===`,
    `- KEEP the EXACT same visual system, palette, line-weight, and composition language as the reference front image. This is the second beat of ONE design, not a new design.`,
    `- Apply ONLY this narrative change (the front's story, one beat later): ${furnaceBrief.narrativeVariable ?? "(shift the focal element per the back layout below)"}`,
    `- ABSTRACT geometric only. NO human figures, faces, people, literal objects. FLAT screen-print (no 3D/photographic rendering); KEEP the front's texture treatment (halftone/grain/overprint) exactly as-is.`,
    backPhrase
      ? `- TEXT: render ONLY this exact phrase, SPELLED CHARACTER-FOR-CHARACTER (do not invent, drop, or alter any letters; large enough to be perfectly legible), woven into the composition: "${backPhrase}". NO other words.`
      : `- TEXT: no text on the back face.`,
    `=== END CONSTRAINTS ===`,
    ``,
    `## DOMINANT VISUAL SYSTEM (unchanged from front): ${furnaceBrief.dominantSystem ?? "(as front)"}`,
    `## MANIFESTATION: ${context.shortcode} · ${context.manifestationDecade} · ${context.season}`,
    ``,
    `## BACK LAYOUT — render these elements exactly (same system as front, variable applied)`,
    ...(layoutLines.length > 0
      ? layoutLines
      : [`(apply the narrative variable to the front composition)`]),
    ...(richnessDirectives(furnaceBrief).length > 0
      ? [``, `## RICHNESS TREATMENT (same as front — keep consistent)`, ...richnessDirectives(furnaceBrief)]
      : []),
    ``,
    `OUTPUT: transparent background, no garment silhouette, no mockup. The back face of the pair${backPhrase ? `, the only text being "${backPhrase}"` : ", with no text"}.`,
  ].join("\n");
}

/**
 * Public entry — picks the right prompt builder based on input shape.
 *
 * Fresh generate with garment-system fields (PR-A): the validated assembler.
 * Fresh generate (legacy brief, no frontLayout): full FURNACE brief + spec + knowledge.
 * Refinement (parent + instruction): terse adjustment + invariants.
 * Branch (parent, no instruction): "parallel exploration" + invariants.
 */
export function buildBoilerPrompt(input: GenerateDesignInput): string {
  if (input.parent && input.refinementInstruction) {
    return buildRefinementPrompt(input);
  }
  if (input.parent && !input.refinementInstruction) {
    return buildBranchPrompt(input);
  }
  // PR-B: garment-system path when FURNACE supplied the wiring-diagram layout.
  if (input.furnaceBrief.frontLayout && input.furnaceBrief.frontLayout.length > 0) {
    return buildGarmentSystemFrontPrompt(input);
  }
  return buildFreshPrompt(input);
}

/**
 * Helper: validate that a palette is "complete enough" to render. Used by
 * generate-design.ts before calling OpenAI. Returns an error message string if
 * incomplete (palette role missing or not a valid hex), else null.
 *
 * Validation is strict by design — gpt-image-2 prompts that say "garment base:
 * undefined" produce garbage. Better to fail loudly + early.
 */
export function validatePaletteRoles(
  roles: Partial<PaletteRoles>,
): string | null {
  const requiredRoles: Array<keyof PaletteRoles> = [
    "garment_base",
    "ring_outer",
    "ring_inner",
    "front_ink",
    "back_ink",
  ];
  for (const role of requiredRoles) {
    const value = roles[role];
    if (typeof value !== "string" || value.length === 0) {
      return `palette_roles.${role} is missing`;
    }
    if (!/^#[0-9a-fA-F]{6}$/u.test(value)) {
      return `palette_roles.${role} is not a 6-digit hex with leading # (got: ${value})`;
    }
  }
  return null;
}
