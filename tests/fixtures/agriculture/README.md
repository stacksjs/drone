# Agriculture numerical reference

`known-panel.json` retains small actual red/NIR DN extracts and calibration metadata from the
official [MicaSense imageprocessing](https://github.com/micasense/imageprocessing) test dataset,
pinned at `3a903861b2f38c1717a5b6d918a2d9196db507ae`. The adjacent `NOTICE` preserves the
repository's MIT license. The pinned README identifies `data/` as test data and states the MIT
license; no separate data license or exclusion was found in that tree.

The source photographs are vendor reference-panel images, not a synthetic crop field. The
numerical results verify agreement with an independently executed vendor model. They do not
establish measured physical calibration, pixel registration, a vegetation map or agronomic accuracy.

## Inputs and independent computation

Both files are in `data/REDEDGE-MX/` at the pinned revision. Git stores LFS pointers, so download
the actual files through the official pinned GitHub media URLs retained in the JSON. Actual bytes
were SHA256-checked against their original LFS OIDs:

| File | Band | SHA256 | Bytes |
| --- | --- | --- | --- |
| `IMG_0001_3.tif` | Red, 668 nm | `911e3d06f3534910f1b2c2c07a71d7984d4d506f8cab8725d3f2f9edc7dead27` | 2466298 |
| `IMG_0001_4.tif` | NIR, 842 nm | `4aa4bc51637f4279bd560135b4ceb09a14131fbb88b0585481cae4627e0644a3` | 2466334 |

Expected radiance and reflectance arrays were computed separately from Drone using temporary
Python with NumPy and Pillow. Pillow decoded each full 1280 by 960 uint16 raster and its original
EXIF/XMP metadata. The unchanged ASTs of the pinned vendor `Image.radiance`, `Image.vignette`
and `Image.reflectance` methods were executed with those arrays and metadata. No Drone function
was used to generate the expected arrays, and no TIFF decoder or Python processor is added to
the application.

Pinned `micasense/image.py` SHA256:
`41b523ac426f7c694fa812b29da0a5a4830cd0528d585ed195223992cd35edf4`.

For reproduction, load that exact file, parse it using Python's `ast`, retain the three method
nodes unchanged in a class named `Image`, and execute with `np` and `math` globals. Supply
`raw()` from Pillow/NumPy, the metadata fields in the fixture, and initialize the three private
radiance/reflectance cache fields to `None`. Run the methods on the full original grids before
extracting the following zero-based 4 by 4 row-major ROIs:

| Band | Panel-calibration ROI x,y | Disjoint validation ROI x,y |
| --- | --- | --- |
| Red | 718,688 | 734,704 |
| NIR | 676,658 | 692,680 |

The radiance model preserves global raw x/y coordinates for row and radial-vignette correction.
Its normalization is 65536, not 65535. The fixture retains coefficients, exposure, ISO-derived
gain, black level, vignette center and polynomial, declared panel albedo and DLS values.

For the panel correction, compute `panelE = mean(panelL) * pi / declaredPanelReflectance`, then
execute the vendor `Image.reflectance(panelE)` and extract each validation ROI. Those manually
selected raw-coordinate ROIs do not reproduce the full vendor undistorted automatic panel mask.

| Band | Validation mean radiance | Validation mean panel-corrected reflectance |
| --- | --- | --- |
| Red | 0.1567166566878131 | 0.48192353536943666 |
| NIR | 0.10348380542521061 | 0.46904909965344294 |

NDVI of these **ROI mean reflectances**, independently evaluated as `(NIR-red)/(NIR+red)`, is
`-0.013538176853726163`. These separate band ROIs view the same nominally uniform panel material;
they are not registered matching vegetation pixels. The [USGS NDVI definition](https://www.usgs.gov/landsat-missions/landsat-normalized-difference-vegetation-index)
provides the spectral-band formula. This scalar reference verifies arithmetic, without claiming
vendor-published crop truth or map validation.

The alternate DLS result uses the retained original horizontal-irradiance tags. Pinned
`micasense/metadata.py` applies scale 0.01 when those DLS2 tags lack an explicit scale tag.
This produces mean reflectances red `0.7316714592954217`, NIR `0.811487656518095`, and NDVI
`0.051722597109239835`. The numerical disagreement between corrections remains explicit; it
does not establish which correction is physically accurate.

The official [panel tests](https://github.com/micasense/imageprocessing/blob/3a903861b2f38c1717a5b6d918a2d9196db507ae/tests/test_panel.py#L112)
also publish a separate blue-band scalar check: mean radiance approximately 0.179092,
declared reflectance 0.49 and irradiance 1.1482, with 0.001 relative irradiance tolerance.
That is a full-panel approximate reference, separate from these tiny red/NIR ROIs.

## Evidence limits

- Original timestamps and capture identity are vendor declarations. They do not prove measured
  band synchronization, clock accuracy or ground correspondence.
- Panel albedo and calibration metadata have not been checked against physical certificates
  or instruments. No measured camera, atmospheric, illumination or field uncertainty is asserted.
- Scalar tests use the retained full-grid pixel coordinates. Registered image processing tests
  use separate, independently worked small-grid examples. The vendor ROIs cannot silently become
  a common-grid crop image, because their calibration grids and coordinates must be preserved.
- Neither this fixture nor the application implements general TIFF ingestion, full MicaSense
  compatibility, orthomosaic reconstruction, crop-health diagnosis or treatment recommendations.
- Application NDVI intervals are conditional on declared radiance, irradiance, panel-reflectance
  bounds and one-DN quantization. They exclude unmodeled physical sensor behavior and geometric
  pose/registration/area errors. Physical agricultural accuracy remains unqualified.

The SHA256 of the retained JSON, before any intentional future fixture revision, is
`cd7db2ba9704d8336806a52c3325535bbbac23bf3778a36ad03bd4756f033f67`.
