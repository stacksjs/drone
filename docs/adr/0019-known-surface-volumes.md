# ADR 19: known surfaces and auditable stockpile integration

Status: accepted for bounded numerical processing, physical survey acceptance open.

Issue #19 requires owned volume computation with explicit base, reference, coverage and uncertainty.
Acquiring images or counting LiDAR points does not provide a reconstructed elevation surface.

Keep the scientific contract in `resources/functions/drone/volumes/`. Accept an indexed 2.5D TIN
or explicit cell-area grid with a SHA256-bound provenance sidecar. Use strict metre-based east,
north, elevation-up references and an affine plane base. Reject implicit reference conversions,
raw-point triangulation and unimplemented base surfaces. Clip primitives and split cut/fill at
the zero line before exact affine integration, retaining signed hole-weighted contributions.

Unknown coverage and error stay unknown. A conditional vertical bound is distinct from overall
accuracy. An optional reference must match the measurement contract and retain independent source
identity; synthetic comparison cannot become physical survey evidence.

Use native Stacks commands and stx signals/composables for entrypoints. The reusable new-directory,
synced-files, completion-manifest publication protocol serves both mapping imagery and volume
datasets, so it is also contributed to `@stacksjs/storage/completed-artifact-directory`. The app
keeps a local implementation until a normal package release and buddy-bot dependency update make
that API available. It never imports a sibling checkout or patches installed package internals.

Consequences: current processing supports useful bounded, auditable numeric surfaces. LAS/LAZ,
GeoTIFF, meshing, richer base overlays, large-dataset streaming, measured independent reference
campaigns and field accuracy remain explicit issue acceptance work. Math and CLI tests do not
qualify acquisition, calibration, reconstruction, HIL or physical operation.
