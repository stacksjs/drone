#pragma once
#include "sensors.hpp"
#include "wire.hpp"
#include "pico/stdlib.h"
#include "hardware/spi.h"
#include "hardware/i2c.h"
#include "hardware/uart.h"
namespace drone {
struct PicoImuBus {
    bool read(uint8_t reg, uint8_t* data, unsigned count) {
        uint8_t command = reg | 0x80;
        gpio_put(5, false);
        spi_write_blocking(spi0, &command, 1);
        const int result = spi_read_blocking(spi0, 0, data, count);
        gpio_put(5, true); return result == int(count);
    }
    bool write(uint8_t reg, uint8_t value) {
        uint8_t bytes[2]{reg, value}; gpio_put(5, false);
        int result = spi_write_blocking(spi0, bytes, 2); gpio_put(5, true); return result == 2;
    }
    void wait_us(uint32_t us) { busy_wait_us(us); }
};
struct PicoBaroBus {
    bool read(uint8_t reg, uint8_t* data, unsigned count) {
        return i2c_write_timeout_us(i2c0, 0x76, &reg, 1, true, 100) == 1
            && i2c_read_timeout_us(i2c0, 0x76, data, count, false, count * 25 + 75) == int(count);
    }
    bool write(uint8_t reg, uint8_t value) {
        uint8_t bytes[2]{reg, value}; return i2c_write_timeout_us(i2c0, 0x76, bytes, 2, false, 150) == 2;
    }
    void wait_us(uint32_t us) { busy_wait_us(us); }
};
struct PicoSensors {
    Icm42688 imu; Bmp280 baro; UbxNavPvt gnss;
    PicoImuBus spi; PicoBaroBus i2c;
    SensorFrame pending[3]{};
    bool available[3]{};
    uint32_t sequences[3]{}, cycles = 0, imu_samples = 0;
    unsigned next = 0;
    uint64_t boot;
    explicit PicoSensors(uint64_t token) : boot(token) {
        spi_init(spi0, 8000000); spi_set_format(spi0, 8, SPI_CPOL_0, SPI_CPHA_0, SPI_MSB_FIRST);
        gpio_set_function(2, GPIO_FUNC_SPI); gpio_set_function(3, GPIO_FUNC_SPI); gpio_set_function(4, GPIO_FUNC_SPI);
        gpio_init(5); gpio_put(5, true); gpio_set_dir(5, GPIO_OUT);
        i2c_init(i2c0, 400000); gpio_set_function(8, GPIO_FUNC_I2C); gpio_set_function(9, GPIO_FUNC_I2C);
        gpio_pull_up(8); gpio_pull_up(9);
        uart_init(uart1, 115200); gpio_set_function(21, GPIO_FUNC_UART);
        uart_set_hw_flow(uart1, false, false); uart_set_format(uart1, 8, 1, UART_PARITY_NONE); uart_set_fifo_enabled(uart1, true);
        imu.begin(spi); baro.begin(i2c);
    }
    void publish(unsigned index, SensorFrame& frame, uint64_t now, bool error = false) {
        if (sequences[index] == UINT32_MAX) { available[index] = false; return; }
        frame.kind = SensorKind(index + 1); frame.device = uint16_t(index + 1);
        frame.boot = boot; frame.sequence = ++sequences[index];
        if (error) { frame.flags = sensor_bus_error | sensor_estimated_time; frame.captured_us = now; }
        frame.completed_us = time_us_64();
        if (available[index]) frame.flags |= sensor_overrun;
        pending[index] = frame; available[index] = true;
    }
    void poll(uint64_t now) {
        ++cycles;
        SensorFrame frame;
        frame.captured_us = now;
        const int result = imu.sample(spi, frame);
        if (result > 0 && ++imu_samples % 20 == 0) publish(0, frame, now);
        else if (result < 0 && cycles % 20 == 0) { frame.length = 16; publish(0, frame, now, true); }
        if (cycles % 100 == 0 && !baro.trigger(i2c, now)) { frame = SensorFrame{}; frame.length = 30; publish(1, frame, now, true); }
        frame = SensorFrame{};
        const int pressure = baro.sample(i2c, now, frame);
        if (pressure > 0) publish(1, frame, now);
        else if (pressure < 0 && (baro.initialized || cycles % 100 == 10)) { frame.length = 30; publish(1, frame, now, true); }
        for (unsigned i = 0; i < 32 && uart_is_readable(uart1); ++i) {
            frame = SensorFrame{};
            if (gnss.feed(uint8_t(uart_getc(uart1)), now, frame)) publish(2, frame, now);
        }
    }
    void report(Wire& wire) {
        for (unsigned i = 0; i < 3; ++i) {
            unsigned index = (next + i) % 3;
            if (available[index] && wire.queue_sensor(pending[index])) { available[index] = false; next = (index + 1) % 3; break; }
        }
    }
};
static_assert(sizeof(PicoSensors) <= 768, "Sensor acquisition memory budget exceeded");
}
