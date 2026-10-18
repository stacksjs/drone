#pragma once
#include "protocol.hpp"
#include <cstring>
namespace drone {
constexpr unsigned sensor_frame_size = 128;
enum class SensorKind : uint8_t { imu = 1, barometer = 2, gnss = 3 };
constexpr uint32_t sensor_valid = 1, sensor_bus_error = 2, sensor_overrun = 4,
    sensor_estimated_time = 8, sensor_source_time_error = 16, sensor_timing_unvalidated = 32;
struct SensorFrame {
    SensorKind kind = SensorKind::imu;
    uint32_t sequence = 0;
    uint64_t boot = 0, captured_us = 0, completed_us = 0;
    uint32_t flags = 0;
    uint16_t device = 0, length = 0;
    uint32_t uncertainty_us = 0;
    uint8_t payload[80]{};
};
void encode_sensor(const SensorFrame& frame, uint8_t (&bytes)[sensor_frame_size]);
bool decode_sensor(const uint8_t (&bytes)[sensor_frame_size], SensorFrame& frame);

// SPI and I2C register HALs provide read(reg,bytes,count), write(reg,value), wait_us(us).
// Initialization is outside the scheduled loop. Runtime reads never wait for a conversion.
struct Icm42688 {
    bool initialized = false;
    template<class Bus> bool begin(Bus& bus) {
        uint8_t id = 0, config[2]{}, endian = 0, power = 0;
        if (!bus.write(0x76, 0) || !bus.write(0x11, 1)) return false;
        bus.wait_us(2000);
        if (!bus.read(0x75, &id, 1) || id != 0x47 || !bus.write(0x4c, 0x30)
            || !bus.write(0x4f, 0x06) || !bus.write(0x50, 0x06) || !bus.write(0x4e, 0x0f)) return false;
        bus.wait_us(45000);
        initialized = bus.read(0x4f, config, 2) && config[0] == 0x06 && config[1] == 0x06
            && bus.read(0x4c, &endian, 1) && endian == 0x30 && bus.read(0x4e, &power, 1) && power == 0x0f;
        return initialized;
    }
    template<class Bus> int sample(Bus& bus, SensorFrame& f) {
        if (!initialized) return -1;
        uint8_t status = 0;
        if (!bus.read(0x2d, &status, 1)) return -1;
        if (!(status & 8)) return 0;
        if (!bus.read(0x1d, f.payload, 14)) return -1;
        f.payload[14] = 0x06; f.payload[15] = 0x06;
        f.kind = SensorKind::imu; f.device = 1; f.length = 16;
        f.uncertainty_us = 2000; f.flags = sensor_valid | sensor_estimated_time | sensor_timing_unvalidated;
        return 1;
    }
};
struct Bmp280 {
    uint8_t trim[24]{};
    bool initialized = false, pending = false;
    uint64_t triggered_us = 0;
    template<class Bus> bool begin(Bus& bus) {
        uint8_t id = 0, status = 0;
        if (!bus.read(0xd0, &id, 1) || id != 0x58 || !bus.write(0xe0, 0xb6)) return false;
        bus.wait_us(4000);
        if (!bus.read(0xf3, &status, 1) || (status & 1) || !bus.read(0x88, trim, 24)) return false;
        initialized = (trim[6] || trim[7]) && !(trim[6] == 255 && trim[7] == 255);
        return initialized;
    }
    template<class Bus> bool trigger(Bus& bus, uint64_t now) {
        pending = initialized && bus.write(0xf4, 0x25); // x1/x1, forced conversion.
        triggered_us = now; return pending;
    }
    template<class Bus> int sample(Bus& bus, uint64_t now, SensorFrame& f) {
        if (!initialized) return -1;
        if (!pending || now < triggered_us || now - triggered_us < 10000) return 0;
        uint8_t status = 0;
        if (!bus.read(0xf3, &status, 1)) { pending = false; return -1; }
        if (status & 9) { if (now - triggered_us > 20000) { pending = false; return -1; } return 0; }
        pending = false;
        if (!bus.read(0xf7, f.payload, 6)) return -1;
        std::memcpy(f.payload + 6, trim, 24);
        f.kind = SensorKind::barometer; f.device = 2; f.length = 30;
        f.captured_us = triggered_us; f.uncertainty_us = uint32_t(now - triggered_us);
        f.flags = sensor_valid | sensor_estimated_time;
        return 1;
    }
};
struct UbxNavPvt {
    uint8_t bytes[100]{};
    unsigned used = 0;
    uint64_t first_us = 0;
    uint32_t last_tow = 0;
    bool seen = false;
    bool feed(uint8_t byte, uint64_t now, SensorFrame& frame);
};
static_assert(sizeof(SensorFrame) <= 128, "Sensor record budget exceeded");
static_assert(sizeof(UbxNavPvt) <= 128, "GNSS parser budget exceeded");
}
