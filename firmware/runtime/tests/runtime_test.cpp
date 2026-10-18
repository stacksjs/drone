#include "runtime.hpp"
#include "wire.hpp"
#include <cstdio>
#include <cstring>
#define CHECK(x) do { if (!(x)) { std::fprintf(stderr, "line %d: %s\n", __LINE__, #x); return 1; } } while (0)
static drone::Frame command(drone::Kind kind, uint32_t seq, uint64_t time = 1000, uint32_t duration = 0) {
    drone::Frame c; c.kind = kind; c.sequence = seq; c.boot = 123; c.session = 456; c.sample_time_us = time; c.lease_us = duration;
    return c;
}
static void hello(drone::Runtime& r) {
    auto c = command(drone::Kind::hello, 1, 0); c.boot = 0; r.receive(c, 1000);
}
struct TestUART {
    uint8_t input[256]{}, output[256]{};
    unsigned size = 0, read_at = 0, writes = 0;
    bool ready = true;
    bool readable() const { return read_at < size; }
    uint8_t read() { return input[read_at++]; }
    bool writable() const { return ready; }
    void write(uint8_t byte) { output[writes++] = byte; }
};
int main() {
    CHECK(drone::crc32(reinterpret_cast<const uint8_t*>("123456789"), 9) == 0xcbf43926);
    {
        drone::Runtime r(123);
        CHECK(r.neutral());
        CHECK(r.tick(1000, 1200));
        auto s = r.status(1200);
        CHECK(s.ticks == 1 && s.sample_time_us == 1000 && s.sample == -999);
        CHECK(s.flags == (drone::capabilities | drone::sample_valid));
        CHECK(s.max_execution_us == 200 && s.state_bytes <= 128);
        uint8_t bytes[drone::frame_size]; drone::encode(s, bytes);
        drone::Frame decoded; CHECK(drone::decode(bytes, decoded));
        CHECK(decoded.sample == -999 && decoded.boot == 123);
        bytes[2] = 2; CHECK(!drone::decode(bytes, decoded));
    }
    {
        drone::Runtime r(123); CHECK(r.tick(1000, 1000)); hello(r);
        r.receive(command(drone::Kind::lease, 2, 1000, 100000), 1000);
        CHECK(r.status(1000).lease_us == 100000 && r.neutral());
        for (uint64_t t = 2000; t <= 101000; t += 1000) CHECK(r.tick(t, t));
        CHECK(r.status(101000).lease_us == 0);
        CHECK(!(r.status(101000).flags & drone::leased));
        // A strictly newer sequence still cannot renew from a stale board timestamp.
        r.receive(command(drone::Kind::lease, 3, 1000, 100000), 101000);
        CHECK(r.status(101000).session == 0);
    }
    for (int fault = 0; fault < 8; ++fault) {
        drone::Runtime r(123); CHECK(r.tick(1000, 1000)); hello(r);
        auto c = command(drone::Kind::lease, 2, 1000, 100000); r.receive(c, 1000);
        switch (fault) {
            case 0: r.receive(c, 1000); break; // replay
            case 1: c.sequence = 3; c.boot = 124; r.receive(c, 1000); break;
            case 2: c.sequence = 3; c.session = 457; r.receive(c, 1000); break;
            case 3: c.sequence = 3; c.sample_time_us = 1001; r.receive(c, 1000); break;
            case 4: c.sequence = 3; c.lease_us = 100001; r.receive(c, 1000); break;
            case 5: c.sequence = 3; c.flags = drone::leased; r.receive(c, 1000); break;
            case 6: r.invalidate(); break; // CRC/version/framing failure
            case 7: r.receive(command(drone::Kind::stop, 3), 1000); break;
        }
        CHECK(r.status(1000).lease_us == 0 && r.neutral());
    }
    {
        drone::Runtime r(123); CHECK(r.tick(1000, 1000)); hello(r);
        CHECK(r.tick(2250, 2500)); // Inclusive 250 us lateness and <=500 us execution.
        CHECK(!r.tick(3251, 3251));
        CHECK(r.faulted() && (r.status(3251).flags & drone::deadline_fault));
        CHECK(r.status(3251).misses == 1);
        auto c = command(drone::Kind::hello, 5, 0); c.boot = 0; r.receive(c, 3251);
        CHECK(r.status(3251).session == 0 && r.neutral()); // Fault remains latched.
    }
    {
        drone::Runtime r(123); CHECK(r.tick(1000, 1500));
        CHECK(!r.tick(2000, 2501));
        CHECK(r.faulted() && r.neutral());
        CHECK(r.status(2501).max_execution_us == 501);
    }
    {
        drone::Runtime r(123); CHECK(r.tick(1000, 1000));
        CHECK(!r.finish_tick(1000, 1501)); // Includes HAL/protocol work after sample.
        CHECK(r.status(1501).flags & drone::deadline_fault);
    }
    {
        drone::Runtime r(123); CHECK(r.tick(1000, 1000)); hello(r);
        CHECK(!r.tick(999, 999));
        CHECK(r.status(1000).flags & drone::clock_fault);
        CHECK(r.status(1000).session == 0 && r.neutral());
    }
    {
        drone::Runtime reset(999, true);
        CHECK(reset.status(0).flags & drone::watchdog_reset);
        CHECK(reset.status(0).boot == 999 && reset.status(0).session == 0 && reset.neutral());
    }
    {
        drone::Runtime r(123);
        for (uint64_t t = 1000; t <= 10000000; t += 1000) CHECK(r.tick(t, t + 20));
        CHECK(r.status(10000020).ticks == 10000 && r.neutral());
    }
    {
        drone::Runtime r(123); CHECK(r.tick(1000, 1000));
        drone::Wire wire; TestUART uart;
        auto c = command(drone::Kind::hello, 1, 0); c.boot = 0;
        uint8_t bytes[drone::frame_size]; drone::encode(c, bytes);
        // Header noise and fragmented input must resynchronize without exceeding 32 reads.
        uart.input[0] = 0xff; uart.input[1] = 'D';
        std::memcpy(uart.input + 2, bytes, drone::frame_size); uart.size = 2 + drone::frame_size;
        wire.poll(r, 1000, uart); CHECK(uart.read_at == 32 && r.status(1000).session == 0);
        wire.poll(r, 1000, uart); CHECK(uart.read_at == 64);
        wire.poll(r, 1000, uart); CHECK(r.status(1000).session == 456);
        wire.report(r, 1000, false);
        uart.ready = false; wire.poll(r, 1000, uart); CHECK(uart.writes == 0);
        wire.report(r, 1000, true); // Pending TX must not be overwritten.
        uart.ready = true; wire.poll(r, 1000, uart); CHECK(uart.writes == 32);
        wire.poll(r, 1000, uart); CHECK(uart.writes == 64);
        uint8_t response[drone::frame_size]; std::memcpy(response, uart.output, drone::frame_size);
        drone::Frame status; CHECK(drone::decode(response, status));
        CHECK(status.session == 456 && status.kind == drone::Kind::status);
        // A complete corrupt frame revokes authority and still requests a diagnostic response.
        uart.size = drone::frame_size; uart.read_at = 0; bytes[60] ^= 1;
        std::memcpy(uart.input, bytes, drone::frame_size);
        wire.poll(r, 1000, uart); wire.poll(r, 1000, uart);
        CHECK(r.status(1000).session == 0 && r.neutral());
    }
    {
        drone::Runtime r(123); CHECK(r.tick(1000, 1000));
        drone::Wire wire; TestUART uart; drone::SensorFrame sensor;
        sensor.sequence = 1; sensor.boot = 123; sensor.length = 16; sensor.device = 1;
        sensor.flags = drone::sensor_valid;
        CHECK(wire.queue_sensor(sensor));
        CHECK(!wire.queue_sensor(sensor));
        auto c = command(drone::Kind::hello, 1, 0); c.boot = 0;
        uint8_t request[drone::frame_size]; drone::encode(c, request);
        std::memcpy(uart.input, request, drone::frame_size); uart.size = drone::frame_size;
        uart.ready = false; wire.poll(r, 1000, uart); wire.poll(r, 1000, uart);
        CHECK(wire.response && uart.writes == 0);
        wire.report(r, 1000, true); CHECK(wire.tx_size == 128);
        uart.ready = true;
        for (unsigned i = 0; i < 4; ++i) { wire.poll(r, 1000, uart); CHECK(uart.writes == (i + 1) * 32); }
        CHECK(!wire.queue_sensor(sensor)); // Awaited diagnostic reply wins once TX becomes idle.
        wire.report(r, 1000, false); CHECK(!wire.response && wire.tx_size == 64);
        wire.poll(r, 1000, uart); wire.poll(r, 1000, uart);
        CHECK(uart.writes == 192);
        uint8_t ds[128], dr[64]; std::memcpy(ds, uart.output, 128); std::memcpy(dr, uart.output + 128, 64);
        drone::SensorFrame decoded_sensor; drone::Frame status;
        CHECK(drone::decode_sensor(ds, decoded_sensor) && decoded_sensor.sequence == 1);
        CHECK(drone::decode(dr, status) && status.session == 456 && status.kind == drone::Kind::status);
        CHECK(wire.queue_sensor(sensor) && r.neutral());
    }
    std::puts("Runtime contract: sampling, bounds, neutral state, expiry, replay, identity, deadlines, reset and clock checks passed");
    return 0;
}
