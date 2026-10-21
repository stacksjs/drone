# Flight-development milestones

This is an engineering roadmap. Software tests do not establish an airworthy aircraft.

1. Run the browser and terminal simulation. Validate custom behaviors at the decision boundary.
2. Bring up Pi power, cooling, camera examples, and receive-only flight-controller telemetry with props removed.
3. Complete ArduCopter and PX4 SITL campaigns, including failures in `sitl.md` and `drivers.md`. Review telemetry rates,
   coordinate origin, message identity, estimator validity, setpoint timing and independent failsafes.
4. Assemble, calibrate and manually fly the airframe using the supported autopilot and independent RC link,
   after meeting the local aviation requirements. Confirm full mass, centre of gravity, thrust margin,
   battery monitoring and radio-loss behavior before adding the companion payload.
5. Add an authenticated paired-phone/GNSS feed. Verify source age and origin on the ground and in replay.
   Do not rely on phone GPS for close following; require accurate fixes and enough stand-off distance.
6. Engineer a physical command adapter as a separate reviewed change. Replace the SITL estimator-health
   assumption with actual autopilot status; add source authentication, replay handling, bounds accounting
   for dynamics/uncertainty, a hardware authority switch, logging and supervised lifecycle.
7. Validate at a suitable outdoor test site with a qualified pilot and observer, low speeds and generous
   separation. The person being followed should not be the only person supervising early autonomous tests.
8. Validate the implemented Pi AI Camera acquisition, explicit selection and geometric association on the Pi.
   Camera loss requires reselection. Depth, obstacle sensing and metric fusion remain separate milestones.

The owned runtime follows the dependency-linked [roadmap](https://github.com/stacksjs/drone/blob/main/docs/roadmap/README.md). The external drivers
support comparison and development while native board controls are implemented and validated.

Until those milestones are complete, the code here should be used for simulation and bench development.
