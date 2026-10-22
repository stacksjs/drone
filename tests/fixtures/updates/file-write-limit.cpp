// Test-only inherited POSIX file-size limit. No application or board linkage.
#include <cerrno>
#include <csignal>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <sys/resource.h>
#include <unistd.h>

int main(int argc, char** argv) {
    if (argc < 3 || !argv[1][0] || std::strlen(argv[1]) > 8
        || std::strspn(argv[1], "0123456789") != std::strlen(argv[1])) return 125;
    errno = 0;
    char* end = nullptr;
    const auto requested = std::strtoull(argv[1], &end, 10);
    if (errno || !end || *end || requested < 1 || requested > 16777216) return 125;
    const rlim_t bytes = static_cast<rlim_t>(requested);
    const rlimit limit{bytes, bytes};
    if (setrlimit(RLIMIT_FSIZE, &limit) != 0 || std::signal(SIGXFSZ, SIG_IGN) == SIG_ERR) return 125;
    rlimit observed{};
    if (getrlimit(RLIMIT_FSIZE, &observed) != 0 || observed.rlim_cur != bytes || observed.rlim_max != bytes) return 125;
    if (setenv("DRONE_TEST_FILE_LIMIT", argv[1], 1) != 0) return 125;
    std::fprintf(stderr, "FILE_LIMIT_ACTIVE %llu\n", requested);
    std::fflush(stderr);
    execvp(argv[2], argv + 2);
    std::perror("File-limit test exec");
    return 127;
}
