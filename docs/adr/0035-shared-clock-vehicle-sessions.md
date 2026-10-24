# ADR 0035: Retained vehicle sessions on one modeled clock

Status: accepted for software simulation.

## Context

Cargo issue #25 needs distinct vehicles with current authority and source evidence at
the handover epoch. Running one complete fixture and relabeling its result as a fresh
peer would discard timing, independent watchdog and sensor identity requirements.
The shared vehicle loop previously ran to completion with fixed boot 55/session 123.

## Decision

Expose `createVehicleSimulationSession` over that same loop. Its caller advances exact
4 ms epochs from zero; the loop retains raw sensing, estimator updates, 20 ms policy,
mission, controls, authority, payload ownership and independent board state. The ordinary
`runVehicleSimulation` drains this interface to the same terminal report.

Capture an optional nonzero uint64 boot/session scope before allocating a profile session.
The actual synthetic raw packets, pipeline clock anchor, estimator reference, supervisor
and board use that scope. Defaults retain the original identities and report projection.
Identity labels do not authenticate a peer, prevent duplicate scope selection or establish
distributed time synchronization.

Ticks expose detached mission/authority/board snapshots, reference, phase and last completed
host policy epoch. Host loss freezes host work while the finite independent settling tail
can still advance the board and plant. The caller can advance another live vehicle at the
same epochs. Payload teardown occurs once. Explicit close or a step exception revokes the
board and closes ownership; simultaneous failures remain observable.

## Consequences

This is a necessary runtime prerequisite for a captured, two-vehicle custody protocol.
It does not implement that protocol or claim fleet handover is complete. The cargo
coordinator must still bind distinct peers, physically modeled parcel transfer, current
qualified captures, cancellation and conservative uncertain outcomes.

The caller owns stepping and cleanup and must stop stepping a terminal session. Invalid
epochs do not mutate execution. `result` is unavailable until terminal and detached
thereafter. Explicit close stops simulation without running recovery or a physical
settling interval. All physical outputs remain inhibited. This clock is deterministic
simulation time, not a wall-clock deadline guarantee or real-time hardware scheduler.
