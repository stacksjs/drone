#include "runtime.hpp"
#include <limits>
namespace drone {
Runtime::Runtime(uint64_t boot, bool reset, uint64_t start)
    : boot_(boot), last_now_(start), next_due_(start + period_us), watchdog_(reset) {}
void Runtime::invalidate() { session_ = 0; expiry_ = 0; last_command_ = 0; }
bool Runtime::clock(uint64_t now) {
    if (now < last_now_) { faults_ |= clock_fault; invalidate(); return false; }
    last_now_ = now;
    if (expiry_ && now >= expiry_) expiry_ = 0;
    return true;
}
bool Runtime::tick(uint64_t start, uint64_t finish) {
    if (!clock(start) || finish < start) { faults_ |= clock_fault; invalidate(); return false; }
    if (faulted() || start < next_due_) return false;
    if (start - next_due_ > max_lateness_us || ticks_ == UINT32_MAX || start > UINT64_MAX - period_us) {
        if (misses_ != UINT32_MAX) ++misses_;
        faults_ |= deadline_fault; invalidate(); return false;
    }
    next_due_ += period_us;
    sample_at_ = start;
    ++ticks_;
    sample_ = int32_t(ticks_ % 2001) - 1000;
    return finish_tick(start, finish);
}
bool Runtime::finish_tick(uint64_t start, uint64_t finish) {
    if (finish < start || !clock(finish)) { faults_ |= clock_fault; invalidate(); return false; }
    const auto execution = finish - start;
    if (execution > max_execution_) max_execution_ = execution > UINT32_MAX ? UINT32_MAX : uint32_t(execution);
    if (execution > deadline_us) {
        if (!faulted() && misses_ != UINT32_MAX) ++misses_;
        faults_ |= deadline_fault; invalidate();
    }
    return !faulted();
}
void Runtime::receive(const Frame& c, uint64_t now) {
    if (!clock(now) || faulted() || c.sequence == 0 || c.sample != 0 || c.ticks || c.misses || c.flags || c.max_execution_us || c.state_bytes) { invalidate(); return; }
    if (c.kind == Kind::hello && c.boot == 0 && c.session != 0 && c.sample_time_us == 0 && c.lease_us == 0) {
        invalidate(); session_ = c.session; session_since_ = now; last_command_ = c.sequence; return;
    }
    if (c.boot != boot_ || c.session == 0 || c.session != session_ || c.sequence <= last_command_
        || c.sample_time_us < session_since_ || c.sample_time_us > now || now - c.sample_time_us > freshness_us) { invalidate(); return; }
    if (c.kind == Kind::lease && c.lease_us > 0 && c.lease_us <= max_lease_us && ticks_ > 0 && now <= UINT64_MAX - c.lease_us) {
        last_command_ = c.sequence; expiry_ = now + c.lease_us;
    } else if (c.kind == Kind::stop && c.lease_us == 0) {
        last_command_ = c.sequence; expiry_ = 0;
    } else invalidate();
}
Frame Runtime::status(uint64_t now) {
    clock(now);
    Frame f;
    f.kind = Kind::status;
    // Sequence wrap revokes this session. A fresh handshake is required.
    if (sequence_ == UINT32_MAX) { invalidate(); sequence_ = 0; }
    f.sequence = ++sequence_; f.boot = boot_; f.session = session_; f.sample_time_us = sample_at_;
    f.lease_us = expiry_ > now ? uint32_t(expiry_ - now) : 0; f.sample = sample_;
    f.ticks = ticks_; f.misses = misses_; f.max_execution_us = max_execution_;
    f.flags = capabilities | faults_ | (expiry_ > now ? leased : 0) | (watchdog_ ? watchdog_reset : 0) | (ticks_ ? sample_valid : 0);
    f.state_bytes = sizeof(Runtime);
    return f;
}
}
