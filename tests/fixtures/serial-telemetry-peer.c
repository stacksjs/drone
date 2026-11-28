#include <poll.h>
#include <pty.h>
#include <stdio.h>
#include <string.h>
#include <termios.h>
#include <unistd.h>

int main(void) {
    int master, slave;
    char path[128], command[4096];
    struct termios original = {0};
    if (openpty(&master, &slave, path, NULL, NULL) || tcgetattr(slave, &original)) return 1;
    setvbuf(stdout, NULL, _IOLBF, 0);
    puts(path);
    while (fgets(command, sizeof(command), stdin)) {
        if (!strcmp(command, "quiet\n")) {
            struct pollfd ready = { .fd = master, .events = POLLIN };
            puts(poll(&ready, 1, 50) == 0 ? "quiet" : "unexpected-bytes");
        } else if (!strcmp(command, "restored\n")) {
            struct termios actual = {0};
            puts(!tcgetattr(slave, &actual) && !memcmp(&original, &actual, sizeof(actual)) ? "restored" : "changed-settings");
        } else if (!strcmp(command, "detach\n")) {
            close(master);
            close(slave);
            puts("detached");
            return 0;
        } else if (!strncmp(command, "send ", 5)) {
            unsigned char bytes[2048];
            const size_t length = strcspn(command + 5, "\n");
            if (length == 0 || length % 2 || length / 2 > sizeof(bytes)) return 2;
            for (size_t i = 0; i < length / 2; i++) {
                unsigned value;
                if (sscanf(command + 5 + i * 2, "%2x", &value) != 1) return 3;
                bytes[i] = (unsigned char)value;
            }
            if (write(master, bytes, length / 2) != (ssize_t)(length / 2)) return 4;
            puts("sent");
        } else return 5;
    }
    close(master);
    close(slave);
    return 0;
}
