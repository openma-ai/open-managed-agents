# Console screenshots

Light-theme captures from real Console components at source commit `ac1d1aac`, taken on 2026-10-15 at 1440 × 1080 with local synthetic fixtures. All accounts, integration statuses, messages, tool results, and timings are demonstration data, not production or performance evidence.

## README selection

The English and Chinese READMEs share three always-visible images: one full-width hero and two side-by-side thumbnails linked to the original PNGs. The gallery is not collapsed.

- `agent-light.png`: visible hero, showing Agent configuration, integrations, and version history.
- `model-setup-light.png`: model configuration, left supporting image.
- `environment-light.png`: environment configuration, right supporting image.

A separate session capture is retained in local review artifacts, not included in this gallery. Its fixture renders “Worked for 0s” alongside an 11-second event span. That discrepancy remains unresolved; the image has not been retouched to conceal it.

## Capture provenance

No Console components or styles were changed for these images. The capture used the declared `@openma/common@0.9.1` package and locally installed frontend dependencies, not a clean production build.

The repository intentionally includes only light screenshots. Dark counterparts remain local review artifacts. No theme-dependent `<picture>` sources are used.
