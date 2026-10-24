# ADR 0036: One point-load intake for a receiving vehicle

Status: accepted for software simulation.

## Context

Cargo fleet handover needs a physical parcel to leave one carrier, undergo finite modeled
station handling and enter another carrier's actual dynamics. A custody-label change or
an initially loaded second vehicle would bypass that mass transfer. The rigid body already
supports an attached point load and one zero-ejection separation, but had no empty joint.

## Decision

Add `createReceivingRigidBody` over the same integrator, with a captured `expectedPointLoad`.
Its lifecycle is `awaiting -> attached -> separated`. The initial body has base mass/inertia;
the planned load is not an actual parcel. A successful intake consumes this one opportunity.
The old `createRigidBody` constructor still starts attached and exposes no intake method or
awaiting phase. Its default/no-load numerical paths and result projections remain unchanged.

The receiving joint reports its position and velocity. The incoming parcel record contains
its own id, mass, position and velocity. Match id/mass exactly and require exact coincident
binary64 position components at invocation. This is an ideal programmatic contact condition,
not a sensor tolerance or claim of physical positioning precision. Captured records and
finite tuple elements reject accessors. Valid refusal or malformed input does not mutate
the body or consume its intake opportunity.

Let base mass be `m`, point mass `p`, body-forward joint vector `r`, and combined mass `M=m+p`.
The new body-frame CG is `c=p*r/M`. Combined center velocity is `(m*vBody+p*vParcel)/M`.
About that center, body-frame angular momentum is base `I*omega` plus
`m*p/M * cross(r, inverseRotate(vParcel-vBody))`. Dividing by the combined principal inertia
gives the new angular rate. Reconstruct datum velocity from center velocity and `omega cross c`.
The joint is on the body x axis, so the existing diagonal parallel-axis inertia is sufficient.

The base and incoming point jointly determine conserved linear/angular momentum. Structural
position, quaternion and actual motor state remain unchanged. Kinetic energy may decrease;
retain before/after energy and raw dissipation. Reject non-finite candidates or a gain beyond
`64 * Number.EPSILON * max(1, kineticBeforeJ, kineticAfterJ)` before committing state. Keep the
raw represented loss, including tolerated tiny negatives. NED potential is `-mass*g*down`.
The event reports both potential values separately.

## Consequences

The primitive models an instantaneous inelastic impulse, not contact duration, force peaks,
parcel spin/deformation, latch actuation or restitution. The retained acceleration is the last
continuous integration sample, not an invented impact acceleration. A later physics step uses
the new mass/CG/inertia without resetting the controller, estimator, pose or motor lag.

World/policy code must own and consume the single parcel, admit the physical operation, model
finite transport to the joint and capture mechanism/vehicle acknowledgement with current
authority and source epochs. This primitive does not globally prevent a caller from supplying
the same record to two independent worlds. A joint pose is not a source parcel or proof of custody.
Station handling and the actual two-vehicle protocol remain unimplemented at this checkpoint.
No physical output, authenticated identity, battery endurance or fleet completion is claimed.
