# ADR 0013: Differential ground profile on the owned runtime

Status: Accepted for simulation, physical acceptance open.

The ground vehicle reuses the common raw sensor pipeline, owned estimator, vehicle mission v2, authority and independent watchdog. Its profile provides a dynamic differential-drive plant, qualified raw wheel/contact/proximity measurements, estimator-corrected odometry, stopping-envelope controller and simulated acknowledged implement port. There is one mission executor and no ArduPilot/PX4 dependency.

Separate wheel angular inertia and traction-limited contact forces make wheel slip observable in the modeled data. Directly assigning desired body velocity would bypass traction, stopping and encoder disagreement, so the plant integrates contact forces and yaw torque. The controller sees only rendered packets and owned estimates. Truth remains within the plant, renderer and independent evaluation.

Mowing coverage and site logistics use ordinary v2 waypoint, payload, return and stop tasks. A rectangular strip planner supplies bounded geometry; it does not claim arbitrary terrain or obstacle avoidance. Payload events are once-only, stationary and guarded; acknowledgement is explicitly modeled. Neutral output engages a separately declared normally engaged wheel brake. Its simulation stopping bound has no implied physical braking guarantee.

All movement remains simulation-only. Ackermann steering, measured hardware dynamics, redundant emergency circuitry, blade shutdown, positioning observability and physical mission acceptance need separate evidence before enabling any physical output.
