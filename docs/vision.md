# Calibrated selected-target localization

Issue #17 adds owned calibrated localization and explicit GNSS/visual pairing under
`resources/functions/drone/vision/`. It executes on the existing raw sensor, estimator,
authority, multirotor controller and independent modeled board pipeline. The Pi AI Camera
acquisition path remains image-only because its current detections contain no qualified depth.

```sh
./buddy vision:validate examples/vision-calibration.json
./buddy vision:simulate --scenario follow
./buddy vision:simulate --scenario crossing
./buddy vision:simulate --scenario identity-drift
```

Open `/vision` to record the same scenarios and inspect pairing, calibrated metric observations,
uncertainty and loss decisions at a recorded epoch. The scenario script explicitly selects one
detection, waits for confirmation and pairs its lock with one target source. These are simulated
operator actions. The page does not select a live person or command an aircraft. The compiled
standalone CLI exposes both commands outside the checkout.

## Measurement contract

`createVisionLocalizer(calibration, heldOut)` validates a fixed lens/mode calibration and at least
six independently acquired held-out 3D correspondences before accepting observations. It supports
pinhole intrinsics with Brown5 radial/tangential distortion, a declared calibration-pixel crop
and output scaling, plus camera-to-body quaternion and lever arm. Unknown fields and unsupported
versions fail. Each independent sample names its output pixel, optical Z depth and body-frame 3D
point. Residuals must fit the declared model budget, cover both image axes and multiple depths.
This is calibration import and independent residual evaluation; it does not solve a calibration
fit from checkerboard images or prove that an operator's imported data is independent.

The [OpenCV pinhole and distortion model](https://docs.opencv.org/4.x/d9/d0c/group__calib3d.html)
defines the pixel-to-ray geometry. Optical axes are right, down, forward, consistent with
[REP 103's optical frame](https://github.com/ros-infrastructure/rep/blob/master/rep-0103.rst).
The library explicitly transforms that ray to body forward/right/down, then fixed LOCAL_NED.
Optical depth is the camera Z coordinate, not slant distance. Pixels in a validation profile
and runtime depth observations are output pixel coordinates at the selected box centre.

Raspberry Pi's [`convert_inference_coords`](https://github.com/raspberrypi/documentation/blob/master/documentation/asciidoc/accessories/ai-camera/details.adoc)
already maps inference coordinates to the final ISP output image. Calibrate that exact mode,
or supply its explicit crop/scale relative to a calibrated image. Do not apply the network ROI
mapping a second time. Network model metadata is not a measured physical lens calibration.

Every metric observation requires all of the following:

- A confirmed, current visual lock and the exact matched detection ID, camera session, frame
  sequence and capture epoch. An older displayed box cannot borrow a newer frame's depth.
- Registered depth at that detection's centre, explicitly tied to the calibration, camera session,
  frame and candidate. Generic nearest-obstacle range cannot qualify. No box-size distance estimate exists.
- Capture-time local pose, camera mounting, compatible evidence and a declared heading alignment.
  Missing pose or depth fails measurement production. The local origin/reference must match the paired target.
- One local monotonic clock, camera/depth/pose synchronization within the configured maximum of
  20 ms including declared clock uncertainty, and measurement age no greater than 200 ms.
- Conservative uncertainty covering pixel/depth error, pose position and attitude, extrinsic
  translation/rotation, model residual and motion during timing uncertainty. Depth must stay
  within the held-out calibration interval. Lens inverses, folds, declared numeric bounds and
  the minimum depth-noise budget are checked. Actual error distributions require measurements.

The motion assumptions are at most 3 m/s vehicle translation, 2 m/s target motion and 35 rad/s
angular motion, matching the owned estimator's admitted gyro ceiling. The uncertainty includes
range-scaled angular timing error and cross terms. A hardware integration must justify those bounds.

The current estimator has relative yaw and no observed absolute heading. The owned fixture starts
north-aligned and explicitly budgets drift while predicting capture attitude from qualified raw
gyro data. A physical adapter needs independently surveyed body-to-NED alignment and measured timing,
pose and uncertainty. Declaring a field in JSON does not establish this evidence.

## Explicit pairing, fusion and loss

`createVisionTargetFusion()` starts unpaired. An operator calls `pair()` with the exact selected
lock epoch, camera session, calibration and depth source, plus one GNSS source/session/target and
fixed frame reference. The offset from the visible depth point to the GNSS target origin is an
explicit NED vector with uncertainty. A person-box centre is not inherently the GNSS antenna position.

The engine gates the visual/GNSS innovation and source motion, then uses fixed-weight isotropic
covariance intersection. It assumes unknown correlations between inputs. This follows the
[covariance-intersection bound](https://skoge.folk.ntnu.no/prost/proceedings/ifac2014/media/files/0875.pdf),
with an intentionally fixed weight of one half rather than an optimized estimator. The published
sigma is a covariance upper-bound input, not a measured confidence guarantee or a probability of
correct identity. Asynchronous positions include a declared target-motion allowance and publish
the oldest capture epoch. Repeated identical packets add no information or freshness.

Missing or stale observations, camera stalls, occlusion, ambiguous crossings, reselection, changed
session/reference, packet replay, conflicting retained data and excessive innovation latch `lost`
and release the target. Healthy packets cannot revive it. A new operator action must clear and
pair again. The simulator additionally retains the authority/fault latch, so pairing alone cannot
restore flight control. Identity drift inconsistent with the selected GNSS fix is rejected. Two
nearby people that remain geometrically consistent cannot be reliably distinguished by this tracker.
There is no appearance embedding, biometric identity model or automatic re-identification.

## Evidence and remaining gates

[Recorded scenario metrics](vision-evidence.json) distinguish synthetic calibration from physical
measurements. Worked distortion/crop/frame examples and held-out 3D points test geometry independently.
The owned physics fixture renders pixels/depth from its plant separately from localization, which
uses the estimator's capture pose. It measures target position error and declared three-sigma coverage,
then follows the fused target through the navigation goal and existing authority/control/output gates.
Crossings, occlusion, camera/depth/target loss, identity drift, reference reset and manual override
exercise release behavior. At normal scenario end, the operator releases control. Zero thrust after
an airborne fault is not a controlled landing.

Before physical metric following, retain independently measured lens/mount/ROI calibration, an
external registered depth source, surveyed heading/reference, camera/depth/pose synchronization,
and ground-truth position/error datasets. Split calibration-fit and validation samples. Measure
range, lighting, motion, temperature, rolling-shutter and occlusion effects; verify the declared
uncertainty with held-out trajectories. Complete on-Pi acquisition, restart/reselection and HIL
authority campaigns. Neither this dataset nor a `declared-bench` import closes those gates.

Issue #17 remains open for those campaigns, physical sensor adapters and broader appearance/privacy
evaluation if an appearance tracker is introduced. See [ADR 17](adr/0017-calibrated-vision.md).
