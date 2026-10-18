#pragma once
#include <cstddef>
#include <cstdint>

namespace drone {
constexpr std::size_t frame_size = 64;
constexpr uint8_t protocol_version = 1;
enum class Kind : uint8_t { hello = 1, lease = 2, stop = 3, status = 4 };
constexpr uint32_t synthetic = 1, neutral_only = 2, leased = 4, deadline_fault = 8,
    clock_fault = 16, watchdog_reset = 32, sample_valid = 64;
constexpr uint32_t capabilities = synthetic | neutral_only;
struct Frame {
    Kind kind = Kind::hello;
    uint32_t sequence = 0;
    uint64_t boot = 0, session = 0, sample_time_us = 0;
    uint32_t lease_us = 0;
    int32_t sample = 0;
    uint32_t ticks = 0, misses = 0, flags = 0, max_execution_us = 0, state_bytes = 0;
};
uint32_t crc32(const uint8_t* data, std::size_t size);
void encode(const Frame& frame, uint8_t (&bytes)[frame_size]);
bool decode(const uint8_t (&bytes)[frame_size], Frame& frame);
}
