# ADR 20: asset-relative inspection and explicit evidence review

Status: accepted for owned simulation and recording workflows; physical acceptance open.

Issue #20 requires a repeatable asset route, attached imagery/pose/quality, human annotations and
failure/revisit evidence. A geotagged photo or completed waypoint mission alone cannot establish
clearance, inspection quality or a physical defect.

Implement one explicit finite bridge face with east/up/south axes and a retained asset revision.
Compile station goals into the existing mission graph and check every transit segment. Model raw
range corners and visible/temperature-field pixels from plant state; qualify geometry and metadata
using the estimator. Add real wind only through the existing physics disturbance interface.

Share the modeled shutter protocol between mapping and inspection because both need scoped ACKs,
one pending command, uncertainty deadlines, byte snapshots and cancellation. Keep domain renderers
and thermal semantics separate. This is vehicle simulation logic, not a generic Stacks package.
Native Stacks commands, stx signals/composables, public function barrels and the shared artifact
writer provide the application entrypoints and persistence. No new dependency or framework edit
is needed for this domain feature.

Retain unsigned compact mission replay and explicit pose-epoch consistency. Bind operator reviews
to source bytes/configuration and projected asset points with SHA256, preserving unauthenticated
identity and unverified physical-defect status. Revisit comparison evaluates geometry and declared
uncertainty; it never diagnoses deterioration from differing pixels. Export actual PNG/numeric
thermal content with private completion-marked datasets.

Consequences: the module supports useful inspection development on the owned runtime. Its thermal
field is synthetic, not calibrated radiometry; compact replay is not full sensor evidence. Asset
families beyond the selected face, measured hardware registration/corrections, real defect review,
dynamic structures/occlusions and full HIL/vehicle acceptance remain explicit issue work.
