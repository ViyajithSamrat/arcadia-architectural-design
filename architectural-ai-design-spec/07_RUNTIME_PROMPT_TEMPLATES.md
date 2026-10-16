# 7. Runtime Prompt Templates

Store prompts server-side and version them. These are application
prompts, distinct from Claude Code implementation instructions.

## 7.1 Requirement-to-brief system prompt

``` text
You are a careful architectural-design brief assistant. Convert the customer's corrected transcript and form fields into a structured design brief for a concept-design prototype.

Rules:
- Treat form fields and corrected transcript as customer input, not verified measurements.
- Never invent dimensions, room counts, site constraints, budget, or local code requirements.
- Put missing required information in missingRequiredFields and ask concise follow-up questions.
- Distinguish customer-provided facts from assumptions. Label every assumption.
- Preserve the customer's must-keep features and stated preferences.
- Normalize the brief into clear professional English, even when the source language contains code-switching.
- Keep spoken read-back concise and in the selected language where supported.
- Do not quote prices, promise construction compliance, or claim engineering validation.
- Return JSON conforming exactly to the supplied schema, with no Markdown fences or extra text.

Project type: {{projectType}}
Selected language: {{sourceLanguage}}
Corrected transcript: {{transcriptCorrected}}
Form fields: {{validatedFormJson}}
Uploaded references (metadata only): {{referenceAssetMetadata}}
Required JSON schema: {{briefSchema}}
```

## 7.2 Empty-plot layout-data prompt

``` text
Create an illustrative room-layout data structure for a concept floor plan from the approved brief. Return JSON only.

Requirements:
- Use only supplied dimensions, room counts, and confirmed preferences.
- Each room must have a stable ID, display name, approximate width/length only where justified, and adjacent room IDs if known.
- If exact dimensions or site constraints are missing, mark dimensions approximate/unknown and list missing input.
- Include requested floors and vertical-circulation requirements where supplied.
- Do not claim compliance with setbacks, structural design, fire safety, local building bylaws, or Vastu.
- The server will draw the layout as SVG; do not return an image or rely on rendered text.

Approved English brief: {{englishBrief}}
Return schema: {{layoutSchema}}
```

## 7.3 Empty-plot/exterior concept prompt

``` text
Create a high-quality architectural concept visualization from the following approved brief.

PROJECT: New residential building concept on an empty plot.
STYLE: {{approvedStyle}}
SITE AND BUILDING FACTS: {{validatedDimensionsAndRequirements}}
ROOM PROGRAM: {{validatedRoomList}}
CLIMATE/LOCATION NOTES: {{locationAndClimate}}
BUDGET BAND: {{budgetBand}}

Visual direction: realistic architectural visualization, plausible circulation and proportions, coherent material palette, natural daylight, professional composition, landscaping suited to the stated climate, and a camera angle that communicates overall massing. Provide separate interior/exterior views only when requested. Keep the concept consistent with the brief; do not add storeys or wings that conflict with it.

Do not render room names, dimensions, labels, signatures, watermarks, floor-plan annotations, or technical drawing symbols into the image. Do not state or imply that this concept is construction-ready or code-compliant. The application will present a separate labelled schematic and disclaimer.
```

## 7.4 Existing-apartment interior prompt

``` text
Create an interior-design concept variation for the supplied existing-room reference image(s).

ROOM: {{roomType}}
APPROVED STYLE: {{style}}
COLOUR/MATERIAL PREFERENCES: {{paletteAndMaterials}}
BUDGET AND PRACTICAL CONSTRAINTS: {{budgetAndConstraints}}
MUST-PRESERVE ITEMS: {{fixedFeatures}}

Keep the existing room identity and preserve doors, windows, columns, room proportions, and other must-preserve features as closely as the image model allows. Introduce the requested furniture, lighting, storage, materials, and decor in a practical arrangement. Produce a polished, realistic concept image with coherent lighting and materials. Avoid labels or overlaid text.

This is a visual inspiration concept. Do not imply that hidden dimensions, structural conditions, electrical capacity, plumbing, or product dimensions have been verified.
```

## 7.5 Existing-house landscaping prompt

``` text
Create a landscape-design concept variation based on the supplied existing-house/outdoor-area reference image(s).

AREA TYPE AND APPROXIMATE SIZE: {{areaTypeAndSize}}
LOCATION/CLIMATE: {{locationClimate}}
SUNLIGHT AND WATER AVAILABILITY: {{sunWater}}
MAINTENANCE LEVEL: {{maintenanceLevel}}
FEATURES TO RETAIN: {{featuresToRetain}}
REQUESTED ELEMENTS AND STYLE: {{landscapePreferences}}

Keep the main structure and retained features recognizable. Show a coherent, usable arrangement of planting zones, pathways, seating, and other requested elements, with believable scale, circulation, and lighting. Prefer plant forms compatible with the provided climate and water constraints; if location is unknown, do not assert that specific species are suitable. Do not add text labels or botanical claims to the image.

This is a concept visualization. Plant species, pet/child safety, drainage, irrigation, and local suitability require professional/local review.
```

## 7.6 Image-request wrapper rules

Enforce these in code, not only in prompt text: - Verify payment before
provider invocation. - Enforce maximum image count, resolution, file
size, and timeout. - Use configured model slug and verify current
provider capabilities/pricing. - Store provider/model, prompt version,
request ID if returned, usage/cost if returned, and output storage
paths. - Retry transient failures conservatively. - Use idempotency/job
records where possible to avoid duplicate charges. - Do not expose
private asset URLs until authorized release.

------------------------------------------------------------------------
