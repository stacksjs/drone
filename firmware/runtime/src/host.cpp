#include "runtime.hpp"
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <cerrno>

static int nibble(char c) {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    return -1;
}
int main(int argc, char** argv) {
    if (argc != 4 || std::strcmp(argv[1], "--stdio") != 0
        || std::strcmp(argv[2], "--boot-id") != 0 || std::strlen(argv[3]) != 16) return 2;
    uint64_t boot = 0;
    for (std::size_t i = 0; i < 16; ++i) {
        const int value = nibble(argv[3][i]);
        if (value < 0) return 2;
        boot = (boot << 4) | uint64_t(value);
    }
    if (boot == 0) return 2;
    drone::Runtime runtime(boot);
    uint64_t now = 0;
    char line[160];
    while (std::fgets(line, sizeof(line), stdin)) {
        const auto size = std::strlen(line);
        if (!size || line[size - 1] != '\n') return 2;
        line[size - 1] = 0;
        if (std::strncmp(line, "tick ", 5) == 0) {
            char* end = nullptr;
            errno = 0;
            if (line[5] == 0 || std::strspn(line + 5, "0123456789") != std::strlen(line + 5)) return 2;
            auto next = std::strtoull(line + 5, &end, 10);
            if (errno || end == line + 5 || *end || line[5] == '-') return 2;
            now = next;
            runtime.tick(now, now);
        } else if (std::strncmp(line, "frame ", 6) == 0 && size == 6 + drone::frame_size * 2 + 1) {
            uint8_t bytes[drone::frame_size];
            for (std::size_t i = 0; i < drone::frame_size; ++i) {
                int a = nibble(line[6 + i * 2]), b = nibble(line[7 + i * 2]);
                if (a < 0 || b < 0) return 2;
                bytes[i] = uint8_t((a << 4) | b);
            }
            drone::Frame command;
            if (drone::decode(bytes, command)) runtime.receive(command, now);
            else runtime.invalidate();
        } else return 2;
        uint8_t bytes[drone::frame_size];
        drone::encode(runtime.status(now), bytes);
        for (auto byte : bytes) std::printf("%02x", byte);
        std::puts(""); std::fflush(stdout);
    }
    return std::ferror(stdin) ? 1 : 0;
}
