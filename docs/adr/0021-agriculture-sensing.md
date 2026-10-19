# ADR 21: Calibrated raw-band field sampling and explicit livestock selection

Status: accepted for owned simulation development.

Keep agriculture planning, radiometry, capture, evidence and reporting in
`resources/functions/drone/agriculture/`. Reuse the existing owned survey sensor/estimator/mission/
authority/control/board physics path. Supply a concrete multispectral camera through an optional
camera factory; the default visible survey path remains unchanged. Extract the acknowledged generic
shutter protocol only because visible, thermal and raw-band frames are actual separate callers.

Retain raw red/NIR DN with explicit per-band model, panel, exposure/gain, irradiance, timing and
registration metadata. Use the documented MicaSense numerical response model, independently checked
against a pinned vendor panel-image extract. This is not a vendor TIFF ingestion driver or proof of
physical sensor calibration. Distinguish that model reference from independent synthetic map landmarks.

Compute a bounded geospatial sampling layer using estimated poses and actual calibrated pixels.
Preserve nodata, exact clipped field/parcel support and missing coverage. Report area-weighted
sample summaries, conditional input bounds and unavailable RTK/PPK/GCP explicitly. Do not claim
reconstruction, agronomic diagnosis, prescriptions or complete field accuracy.

Require an explicit operator-selected animal label and source pixel. Bind the original bytes,
calibration, pose and projected parcel using an unsigned digest. Preserve original selection scope;
never infer identity or automatically transfer a selection to another animal or capture.

Use native Stacks commands, stx signals and ts-css for the operator path. Keep the synchronous
mission and numeric processing loops free of database/queue dependencies. Reuse the private bounded
reader and completed-artifact publication protocol; browser modules cannot import fs/codecs.
Hardware/field/HIL and storage power-loss qualification remain separate acceptance under issue21.

Large CLI JSON results await stdout completion, including backpressure. The async output helper
is contributed to native `@stacksjs/cli/output` and temporarily mirrored under
`resources/functions/cli/output.ts` until a normal dependency release makes it available. This
keeps compiled commands independent of the sibling Stacks checkout. Existing synchronous native
printing remains suitable for small immediate-exit diagnostics.
