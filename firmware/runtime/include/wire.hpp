#pragma once
#include "runtime.hpp"
#include "sensors.hpp"

namespace drone {
// HAL boundary: IO supplies nonblocking readable/read/writable/write methods.
struct Wire {
    uint8_t rx[drone::frame_size]{}, tx[drone::sensor_frame_size]{};
    unsigned received = 0, sent = 0, tx_size = 0;
    bool response = false;
    template<class IO>
    void poll(drone::Runtime& runtime, uint64_t now, IO& io) {
        // 32 bytes per tick bounds work even under a continuous sender.
        for (unsigned i = 0; i < 32 && io.readable(); ++i) {
            auto byte = io.read();
            if ((received == 0 && byte != 'D') || (received == 1 && byte != 'R')) {
                runtime.invalidate(); received = byte == 'D' ? 1 : 0;
                if (received) rx[0] = 'D';
                continue;
            }
            rx[received++] = byte;
            if (received == drone::frame_size) {
                drone::Frame frame;
                if (drone::decode(rx, frame)) runtime.receive(frame, now);
                else runtime.invalidate();
                received = 0; response = true;
            }
        }
        for (unsigned i = 0; i < 32 && sent < tx_size && io.writable(); ++i)
            io.write(tx[sent++]);
    }
    void report(drone::Runtime& runtime, uint64_t now, bool periodic) {
        if (sent != tx_size || (!response && !periodic)) return;
        uint8_t bytes[drone::frame_size];
        drone::encode(runtime.status(now), bytes);
        std::memcpy(tx, bytes, drone::frame_size); tx_size = drone::frame_size; sent = 0; response = false;
    }
    bool queue_sensor(const SensorFrame& frame) {
        if (sent != tx_size || response) return false;
        encode_sensor(frame, tx); tx_size = sensor_frame_size; sent = 0; return true;
    }
};
static_assert(sizeof(Wire) <= 224, "UART memory budget exceeded");
}
