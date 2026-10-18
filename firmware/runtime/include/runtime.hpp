#pragma once
#include "protocol.hpp"
namespace drone {
constexpr uint64_t period_us = 1000, max_lateness_us = 250, deadline_us = 500,
    freshness_us = 50000, max_lease_us = 100000;
/** No actuator values exist in this contract. A lease is diagnostic bench state only. */
class Runtime {
public:
    explicit Runtime(uint64_t boot, bool reset_by_watchdog = false, uint64_t start = 0);
    bool tick(uint64_t start, uint64_t finish);
    bool finish_tick(uint64_t start, uint64_t finish);
    void receive(const Frame& command, uint64_t now);
    void invalidate();
    Frame status(uint64_t now);
    bool faulted() const { return faults_ != 0; }
    bool neutral() const { return true; }
private:
    uint64_t boot_, session_ = 0, session_since_ = 0, expiry_ = 0, last_now_, next_due_, sample_at_ = 0;
    uint32_t last_command_ = 0, sequence_ = 0, ticks_ = 0, misses_ = 0, faults_ = 0, max_execution_ = 0;
    int32_t sample_ = 0;
    bool watchdog_;
    bool clock(uint64_t now);
};
static_assert(sizeof(Runtime) <= 128, "Kernel state budget exceeded");
}
