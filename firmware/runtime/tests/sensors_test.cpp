#include "sensors.hpp"
#include <cstdio>
#include <cstring>
#define CHECK(x) do { if (!(x)) { std::fprintf(stderr, "line %d: %s\n", __LINE__, #x); return 1; } } while (0)
struct RegisterBus {
    uint8_t registers[256]{};
    bool fails = false;
    unsigned waited = 0;
    bool read(uint8_t reg, uint8_t* data, unsigned count) { if (fails) return false; std::memcpy(data, registers + reg, count); return true; }
    bool write(uint8_t reg, uint8_t value) { if (fails) return false; registers[reg] = value; return true; }
    void wait_us(uint32_t time) { waited += time; }
};
int main(int argc, char** argv) {
    if (argc == 2 && std::strcmp(argv[1], "--roundtrip") == 0) {
        uint8_t input[drone::sensor_frame_size], output[drone::sensor_frame_size];
        while (true) {
            auto size = std::fread(input, 1, sizeof(input), stdin);
            if (size == 0) return std::ferror(stdin) ? 1 : 0;
            drone::SensorFrame frame;
            if (size != sizeof(input) || !drone::decode_sensor(input, frame)) return 2;
            drone::encode_sensor(frame, output);
            if (std::fwrite(output, 1, sizeof(output), stdout) != sizeof(output)) return 1;
        }
    }
    drone::SensorFrame frame;
    RegisterBus bus; bus.registers[0x75] = 0x47;
    drone::Icm42688 imu;
    CHECK(imu.begin(bus)); CHECK(bus.waited >= 45000);
    CHECK(bus.registers[0x4e] == 0x0f && bus.registers[0x4f] == 6 && bus.registers[0x50] == 6);
    CHECK(imu.sample(bus, frame) == 0);
    bus.registers[0x2d] = 8; bus.registers[0x23] = 0xf8; // z = -2048 counts, sensor-axis specific force.
    CHECK(imu.sample(bus, frame) == 1 && frame.length == 16 && frame.device == 1);
    frame.boot = 1; frame.sequence = 1; frame.captured_us = 1000; frame.completed_us = 1010;
    uint8_t bytes[drone::sensor_frame_size]; drone::encode_sensor(frame, bytes);
    drone::SensorFrame copy; CHECK(drone::decode_sensor(bytes, copy)); CHECK(copy.payload[6] == 0xf8);
    bytes[80] ^= 1; CHECK(!drone::decode_sensor(bytes, copy));
    bus.fails = true; CHECK(imu.sample(bus, frame) == -1);
    RegisterBus bad; drone::Icm42688 absent; CHECK(!absent.begin(bad));
    RegisterBus pressure; pressure.registers[0xd0] = 0x58; pressure.registers[0x8e] = 1;
    drone::Bmp280 baro; CHECK(baro.begin(pressure)); CHECK(baro.trigger(pressure, 1000));
    CHECK(baro.sample(pressure, 10000, frame) == 0);
    pressure.registers[0xf3] = 8; CHECK(baro.sample(pressure, 11000, frame) == 0);
    pressure.registers[0xf3] = 0; CHECK(baro.sample(pressure, 12000, frame) == 1);
    CHECK(frame.length == 30 && frame.captured_us == 1000 && frame.uncertainty_us == 11000);
    CHECK(baro.sample(pressure, 13000, frame) == 0); // No duplicate conversion.
    CHECK(baro.trigger(pressure, 20000)); pressure.registers[0xf3] = 8;
    CHECK(baro.sample(pressure, 41000, frame) == -1);
    pressure.registers[0xf3] = 0; CHECK(baro.trigger(pressure, 50000));
    CHECK(baro.sample(pressure, 60000, frame) == 1); // Conversion timeout is recoverable.
    uint8_t ubx[100]{}; ubx[0] = 0xb5; ubx[1] = 0x62; ubx[2] = 1; ubx[3] = 7; ubx[4] = 92;
    ubx[6] = 0xe8; ubx[7] = 3; ubx[26] = 3; ubx[27] = 1;
    auto checksum = [&]() { uint8_t a = 0, b = 0; for (unsigned i = 2; i < 98; ++i) { a = uint8_t(a + ubx[i]); b = uint8_t(b + a); } ubx[98] = a; ubx[99] = b; };
    checksum(); drone::UbxNavPvt parser;
    for (unsigned i = 0; i < 100; ++i) CHECK(parser.feed(ubx[i], 1000 + i, frame) == (i == 99));
    CHECK(frame.length == 80 && frame.captured_us == 1000 && frame.uncertainty_us == UINT32_MAX);
    for (auto byte : ubx) CHECK(!parser.feed(byte, 2000, frame)); // Same iTOW cannot refresh age.
    ubx[6]++; checksum(); ubx[99] ^= 1;
    for (auto byte : ubx) CHECK(!parser.feed(byte, 3000, frame));
    ubx[99] ^= 1;
    for (unsigned i = 0; i < 100; ++i) CHECK(parser.feed(ubx[i], 4000 + i, frame) == (i == 99));
    ubx[6]--; checksum();
    for (unsigned i = 0; i < 100; ++i) CHECK(parser.feed(ubx[i], 5000 + i, frame) == (i == 99));
    CHECK(frame.flags & drone::sensor_source_time_error);
    const uint32_t week_end = 604799000;
    for (unsigned i = 0; i < 4; ++i) ubx[6 + i] = uint8_t(week_end >> (8 * i));
    checksum();
    for (unsigned i = 0; i < 100; ++i) CHECK(parser.feed(ubx[i], 6000 + i, frame) == (i == 99));
    for (unsigned i = 0; i < 4; ++i) ubx[6 + i] = 0;
    checksum();
    for (unsigned i = 0; i < 100; ++i) CHECK(parser.feed(ubx[i], 7000 + i, frame) == (i == 99));
    CHECK(!(frame.flags & drone::sensor_source_time_error));
    std::puts("Sensor register drivers, bounds, conversion lifecycle and UBX parsing passed");
    return 0;
}
