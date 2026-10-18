#include "protocol.hpp"
namespace drone {
static uint64_t get(const uint8_t* p, unsigned n) {
    uint64_t value = 0;
    for (unsigned i = 0; i < n; ++i) value |= uint64_t(p[i]) << (i * 8);
    return value;
}
static void put(uint8_t* p, uint64_t value, unsigned n) {
    for (unsigned i = 0; i < n; ++i) p[i] = uint8_t(value >> (i * 8));
}
uint32_t crc32(const uint8_t* data, std::size_t size) {
    uint32_t crc = 0xffffffff;
    for (std::size_t i = 0; i < size; ++i) {
        crc ^= data[i];
        for (unsigned bit = 0; bit < 8; ++bit) crc = (crc >> 1) ^ (0xedb88320u & (0u - (crc & 1u)));
    }
    return ~crc;
}
void encode(const Frame& f, uint8_t (&b)[frame_size]) {
    for (auto& byte : b) byte = 0;
    b[0] = 'D'; b[1] = 'R'; b[2] = protocol_version; b[3] = uint8_t(f.kind);
    put(b + 4, f.sequence, 4); put(b + 8, f.boot, 8); put(b + 16, f.session, 8);
    put(b + 24, f.sample_time_us, 8); put(b + 32, f.lease_us, 4); put(b + 36, uint32_t(f.sample), 4);
    put(b + 40, f.ticks, 4); put(b + 44, f.misses, 4); put(b + 48, f.flags, 4);
    put(b + 52, f.max_execution_us, 4); put(b + 56, f.state_bytes, 4); put(b + 60, crc32(b, 60), 4);
}
bool decode(const uint8_t (&b)[frame_size], Frame& f) {
    if (b[0] != 'D' || b[1] != 'R' || b[2] != protocol_version || b[3] < 1 || b[3] > 4 || get(b + 60, 4) != crc32(b, 60)) return false;
    f.kind = Kind(b[3]); f.sequence = uint32_t(get(b + 4, 4)); f.boot = get(b + 8, 8);
    f.session = get(b + 16, 8); f.sample_time_us = get(b + 24, 8); f.lease_us = uint32_t(get(b + 32, 4));
    const auto sample = uint32_t(get(b + 36, 4));
    f.sample = sample <= 0x7fffffffu ? int32_t(sample) : -1 - int32_t(~sample);
    f.ticks = uint32_t(get(b + 40, 4)); f.misses = uint32_t(get(b + 44, 4)); f.flags = uint32_t(get(b + 48, 4));
    f.max_execution_us = uint32_t(get(b + 52, 4)); f.state_bytes = uint32_t(get(b + 56, 4));
    return true;
}
}
