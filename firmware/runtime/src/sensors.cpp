#include "sensors.hpp"
namespace drone {
static void put(uint8_t* p, uint64_t v, unsigned n) { for (unsigned i = 0; i < n; ++i) p[i] = uint8_t(v >> (i * 8)); }
static uint64_t get(const uint8_t* p, unsigned n) { uint64_t v = 0; for (unsigned i = 0; i < n; ++i) v |= uint64_t(p[i]) << (i * 8); return v; }
void encode_sensor(const SensorFrame& f, uint8_t (&b)[sensor_frame_size]) {
    for (auto& v : b) v = 0;
    b[0] = 'D'; b[1] = 'S'; b[2] = 1; b[3] = uint8_t(f.kind);
    put(b + 4, f.sequence, 4); put(b + 8, f.boot, 8); put(b + 16, f.captured_us, 8); put(b + 24, f.completed_us, 8);
    put(b + 32, f.flags, 4); put(b + 36, f.device, 2); put(b + 38, f.length, 2); put(b + 40, f.uncertainty_us, 4);
    if (f.length <= 80) std::memcpy(b + 44, f.payload, f.length);
    put(b + 124, crc32(b, 124), 4);
}
bool decode_sensor(const uint8_t (&b)[sensor_frame_size], SensorFrame& f) {
    if (b[0] != 'D' || b[1] != 'S' || b[2] != 1 || b[3] < 1 || b[3] > 3 || get(b + 38, 2) > 80 || get(b + 124, 4) != crc32(b, 124)) return false;
    f.kind = SensorKind(b[3]); f.sequence = uint32_t(get(b + 4, 4)); f.boot = get(b + 8, 8);
    f.captured_us = get(b + 16, 8); f.completed_us = get(b + 24, 8); f.flags = uint32_t(get(b + 32, 4));
    f.device = uint16_t(get(b + 36, 2)); f.length = uint16_t(get(b + 38, 2)); f.uncertainty_us = uint32_t(get(b + 40, 4));
    std::memcpy(f.payload, b + 44, 80); return true;
}
bool UbxNavPvt::feed(uint8_t byte, uint64_t now, SensorFrame& f) {
    if ((used == 0 && byte != 0xb5) || (used == 1 && byte != 0x62)) {
        used = byte == 0xb5 ? 1 : 0; if (used) { bytes[0] = byte; first_us = now; } return false;
    }
    if (used == 0) first_us = now;
    bytes[used++] = byte;
    if (used == 6 && (bytes[2] != 1 || bytes[3] != 7 || bytes[4] != 92 || bytes[5] != 0)) { used = 0; return false; }
    if (used != 100) return false;
    used = 0;
    uint8_t a = 0, b = 0;
    for (unsigned i = 2; i < 98; ++i) { a = uint8_t(a + bytes[i]); b = uint8_t(b + a); }
    if (a != bytes[98] || b != bytes[99] || now < first_us || now - first_us > 50000) return false;
    uint32_t tow = uint32_t(get(bytes + 6, 4));
    if (tow >= 604800000 || (seen && tow == last_tow)) return false;
    const bool reversed = seen && tow < last_tow && !(last_tow > 604798000 && tow < 2000);
    seen = true; last_tow = tow;
    f.kind = SensorKind::gnss; f.device = 3; f.length = 80;
    f.captured_us = first_us; f.flags = sensor_valid | sensor_estimated_time | (reversed ? sensor_source_time_error : 0);
    f.uncertainty_us = UINT32_MAX; // Receipt time only; no PPS measurement-time alignment yet.
    std::memcpy(f.payload, bytes + 6, 80);
    return true;
}
}
