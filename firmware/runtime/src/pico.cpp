#include "runtime.hpp"
#include "wire.hpp"
#include "pico/stdlib.h"
#include "pico/rand.h"
#include "hardware/uart.h"
#include "hardware/watchdog.h"
#if DRONE_SENSOR_BENCH
#include "pico_sensors.hpp"
#endif

namespace {
constexpr uint output_pin = 15, trace_pin = 16;
constexpr uint baud = 115200;
struct UartIO {
    bool readable() const { return uart_is_readable(uart0); }
    uint8_t read() { return uint8_t(uart_getc(uart0)); }
    bool writable() const { return uart_is_writable(uart0); }
    void write(uint8_t byte) { uart_putc_raw(uart0, char(byte)); }
};
}
int main() {
    // External 10k pulldown is required for neutral during reset/BOOTSEL.
    gpio_init(output_pin); gpio_put(output_pin, false); gpio_set_dir(output_pin, GPIO_OUT);
    gpio_init(trace_pin); gpio_put(trace_pin, false); gpio_set_dir(trace_pin, GPIO_OUT);
    uart_init(uart0, baud);
    gpio_set_function(0, GPIO_FUNC_UART); gpio_set_function(1, GPIO_FUNC_UART);
    uart_set_hw_flow(uart0, false, false); uart_set_format(uart0, 8, 1, UART_PARITY_NONE);
    uart_set_fifo_enabled(uart0, true);
    auto boot = get_rand_64();
    if (!boot) boot = 1;
#if DRONE_SENSOR_BENCH
    drone::PicoSensors sensors(boot);
#endif
    const auto origin = time_us_64();
    drone::Runtime runtime(boot, watchdog_caused_reboot(), origin);
    drone::Wire wire;
    UartIO io;
    watchdog_enable(100, false);
    uint64_t next = origin + drone::period_us;
    uint32_t iterations = 0;
    while (true) {
        busy_wait_until(from_us_since_boot(next));
        const auto start = time_us_64();
        gpio_put(trace_pin, true);
        gpio_put(output_pin, false);  // There is no non-neutral output path.
        const bool healthy = runtime.tick(start, start);
        wire.poll(runtime, start, io);
#if DRONE_SENSOR_BENCH
        sensors.poll(start);
#endif
        wire.report(runtime, start, ++iterations % 100 == 0);
#if DRONE_SENSOR_BENCH
        sensors.report(wire);
#endif
        gpio_put(trace_pin, false);
        const bool completed = runtime.finish_tick(start, time_us_64());
        if (healthy && completed) watchdog_update();
#if DRONE_WATCHDOG_TEST
        if (iterations == 2000) while (true) tight_loop_contents();
#endif
        // A late tick remains a latched fault; the hardware watchdog resets it.
        next += drone::period_us;
    }
}
