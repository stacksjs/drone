import type { AgricultureBandCalibration, AgricultureConfig, AgriculturePanel } from './types'
import { exampleSurveyConfig } from '../mapping/fixtures'

/** Independently declared model coefficients and panel DN; never a physical Pi or multispectral calibration. */
export function exampleAgricultureConfig(): AgricultureConfig {
  const survey = exampleSurveyConfig()
  survey.id = 'agriculture-scout'
  const band = (name: 'red' | 'nir'): AgricultureBandCalibration => ({
    name, wavelengthNm: name === 'red' ? 668 : 840, bandwidthNm: name === 'red' ? 10 : 40,
    width: 96, height: 72, bitDepth: 16, blackLevelDn: 4000,
    coefficients: [.001, 0, 0], vignetteCenterPx: [48, 36], vignettePolynomial: [0, 0, 0, 0, 0, 0],
  })
  // L=(DN-4000)/65536 for a1=.001, exposure=.001s, gain1.
  // A diffuse 0.5 panel under spectral irradiance1 has L=.5/pi; quantized DN14430.
  const panel = (name: 'red' | 'nir'): AgriculturePanel => ({
    id: `panel-${name}`, band: name, certificateId: `synthetic-${name}-panel`, capturedAtMs: 0,
    exposureTimeUs: 1000, gain: 1, reflectance: .5, reflectanceUncertainty: .005, irradianceWm2Nm: 1,
    samples: [[44, 32], [48, 32], [52, 32], [44, 36], [48, 36], [52, 36], [44, 40], [48, 40], [52, 40]].map(pixel => ({ pixel: pixel as [number, number], dn: 14430 })),
  })
  return {
    version: 1, id: survey.id, survey,
    parcels: [
      { id: 'south-parcel', name: 'South parcel', boundsM: [-.8, -.8, 0, .8] },
      { id: 'north-parcel', name: 'North parcel', boundsM: [0, -.8, .8, .8] },
    ],
    radiometry: {
      id: 'synthetic-red-nir-radiometry', model: 'micasense-v1', evidence: 'synthetic', bands: [band('red'), band('nir')], panels: [panel('red'), panel('nir')],
      maxPanelAgeMs: 120000, maxIrradianceAgeMs: 40, maxSyncMs: 5, maxRegistrationErrorPx: .25,
      relativeRadianceUncertainty: .02, relativeIrradianceUncertainty: .01,
    },
    gridResolutionM: .1,
  }
}
