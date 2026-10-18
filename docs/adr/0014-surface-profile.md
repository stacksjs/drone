# ADR 0014: own surface survey and sampling policy

Status: accepted for simulation; physical acceptance open.

Use the shared v2 vehicle mission runtime for harbour survey, sample and return. A vehicle profile owns the planar hull, controller, quantized range/sonar/contact rendering and scoped modeled sampler port. The shared estimator, authority, lease/watchdog and mission engine own lifecycle. No separate surface mission executor is introduced.

A synthetic three degree of freedom vector-thrust hull makes station keeping under current explicit. Controllers receive qualified sensors and the owned estimate. Truth is restricted to sensor rendering and independent evaluation. Faults latch and never automatically rearm or resample.

Keep sounding reduction as a pure public function. It requires capture-time position, named vertical datum, travel time, sound speed, draft, water level and explicit uncertainties. Export raw corrections alongside reduced depth. A single-beam track cannot imply complete bottom coverage. Require a declared identity beam mount, capture-time attitude and angular uncertainty. Project the single beam into NED and reject roll/pitch outside the modeled 0.05 rad envelope; physical beam/motion calibration remains open.

Sampler ACK binds event, task, operation, container, reference and actual observed capture time/location. Uncertain collection consumes that container identity within the port session; operator inspection and an explicit new mission/run are required. A missing ACK never triggers an automatic duplicate request.

Physical actuator allocation, navigation rules, real sonar calibration, charting compliance and physical sample validation remain separate acceptance gates documented in vehicles-surface.md.
