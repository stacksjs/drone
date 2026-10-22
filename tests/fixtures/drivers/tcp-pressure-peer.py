"""QA-only OS socket peer. No application, firmware, or physical-device imports."""

import json
import os
import select
import socket
import sys
import time


def emit(record):
    print(json.dumps(record), flush=True)


telemetry = bytes.fromhex(sys.argv[1])
if not 0 < len(telemetry) <= 1024:
    raise ValueError("Invalid QA telemetry length")

listener = socket.socket()
listener.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 4096)
listener.bind(("127.0.0.1", 0))
listener.listen(1)
listener.settimeout(5)
emit({"type": "ready", "port": listener.getsockname()[1],
      "receiveBufferBytes": listener.getsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF)})
connection = None
received = 0
try:
    connection, _ = listener.accept()
    listener.close()
    connection.setblocking(False)
    os.set_blocking(sys.stdin.fileno(), False)
    reading = False
    commands = b""
    pending = b""
    next_heartbeat = 0
    running = True
    while running:
        now = time.monotonic()
        if now >= next_heartbeat:
            pending += telemetry
            if len(pending) > 65536:
                raise RuntimeError("QA heartbeat output exceeded its bound")
            next_heartbeat = now + 0.2
        readers = [sys.stdin.fileno()] + ([connection] if reading else [])
        readable, writable, _ = select.select(readers, [connection] if pending else [], [], 0.02)
        if sys.stdin.fileno() in readable:
            part = os.read(sys.stdin.fileno(), 128)
            if not part:
                break
            commands += part
            if len(commands) > 1024:
                raise RuntimeError("QA command input exceeded its bound")
            while b"\n" in commands:
                command, commands = commands.split(b"\n", 1)
                if command == b"resume":
                    reading = True
                else:
                    raise ValueError("Unknown QA peer command")
        if connection in writable:
            try:
                count = connection.send(pending)
                if count == 0:
                    break
                pending = pending[count:]
            except BlockingIOError:
                pass
        if reading and connection in readable:
            budget = 1048576
            while budget > 0:
                try:
                    part = connection.recv(min(65536, budget))
                except BlockingIOError:
                    break
                if not part:
                    running = False
                    break
                received += len(part)
                budget -= len(part)
                if received > 33554432:
                    raise RuntimeError("QA receive count exceeded its bound")
            emit({"type": "received", "bytes": received})
except (BrokenPipeError, ConnectionResetError):
    pass
finally:
    if connection is not None:
        connection.close()
    listener.close()
    emit({"type": "closed", "bytes": received})
