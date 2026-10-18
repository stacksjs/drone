/* Additional assertions alongside the SDK's board memory map. Stack depth needs measurement. */
ASSERT(__flash_binary_end - __flash_binary_start <= 65536, "Bench flash budget exceeds 64 KiB")
ASSERT(__bss_end__ - __data_start__ <= 8192, "Bench static RAM budget exceeds 8 KiB")
