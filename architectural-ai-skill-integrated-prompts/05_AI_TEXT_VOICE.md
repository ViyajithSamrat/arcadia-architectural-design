# Phase 5 --- AI Briefing, Text Generation, and Optional Voice Integration

## Objective

Implement verified server-side AI text functionality and, if provider
access and documentation are available, voice input/output. Keep
providers behind testable interfaces and preserve safe fallbacks.

## Instructions

Read `CLAUDE.md`, TRD, runtime prompt templates, environment guide,
architecture decision, risk register, and integration matrix.

### 1. Provider verification

Before integration, verify the chosen provider's official current
documentation for: - Authentication method. - Base URL and endpoint. -
Supported model/service identifiers. - Request and response schemas. -
Supported modalities and languages. - Rate limits, payload limits,
pricing, and error responses.

Do not invent details or assume all OpenRouter models support image
generation. Confirm the exact role of OpenRouter in text versus image
generation. Confirm the actual Gnani STT/TTS API details before using
the proposed variable names.

### 2. Text-generation service

-   Implement server-side provider adapters.
-   Keep secrets server-only.
-   Use the approved prompt templates.
-   Validate model output against strict schemas before saving or
    displaying it.
-   Handle timeouts, rate limits, malformed output, and provider errors.
-   Do not allow AI output to change payment state, roles, permissions,
    or asset-release status.
-   Add request limits and avoid logging private customer content
    unnecessarily.
-   Use mocks for automated tests and clearly label them.

### 3. Voice integration

Only implement live STT/TTS when the provider is verified and
credentials are supplied. Otherwise create a clean interface boundary
and explicit disabled state. Do not make fake voice controls appear
functional.

### 4. Acceptance criteria

-   Text provider calls occur only server-side.
-   Output is validated before use.
-   Failure modes are handled safely.
-   Missing credentials do not crash unrelated parts of the app.
-   Mock and live modes are clearly distinguished.
-   Tests cover valid output, malformed output, provider errors, and
    missing configuration.
-   Provider verification status is documented.

This phase does not authorize image generation before payment
verification. Stop and wait for approval.


### Optional tooling
If ECC testing or code-review skills are already available, use only those relevant to input validation, provider boundaries, schema validation, and error handling. Verify current provider documentation independently; skills and model suggestions are not evidence of API support. Do not install tools or call paid services without approval.
