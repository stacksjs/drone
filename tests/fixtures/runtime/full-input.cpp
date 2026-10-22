// Linux-only host transport fixture. Observe a full FIFO without consuming input.
#ifndef _GNU_SOURCE
#define _GNU_SOURCE
#endif
#include "protocol.hpp"
#include <cstdio>
#include <cstdlib>
#include <fcntl.h>
#include <sys/ioctl.h>
#include <unistd.h>

int main(int argc, char** argv) {
    const auto page = sysconf(_SC_PAGESIZE);
    if (argc != 4 || page < 4096 || page > 65536) return 2;
    const int capacity = fcntl(STDIN_FILENO, F_SETPIPE_SZ, int(page));
    if (capacity != page) return 2;
    drone::Frame status;
    status.kind = drone::Kind::status;
    status.boot = std::strtoull(argv[3], nullptr, 16);
    status.sequence = uint32_t(getpid());
    status.state_bytes = uint32_t(capacity);
    int previous = 0;
    for (;;) {
        int queued = 0;
        if (ioctl(STDIN_FILENO, FIONREAD, &queued) != 0) return 3;
        if (queued > 0 && queued != previous) {
            previous = queued;
            status.sample = queued;
            uint8_t bytes[drone::frame_size];
            drone::encode(status, bytes);
            for (auto byte : bytes) std::printf("%02x", byte);
            std::puts("");
            std::fflush(stdout);
        }
        usleep(1000);
    }
}
